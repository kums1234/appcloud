// api/src/routes/compliance.js
// Compliance framework endpoints — CIS Benchmarks first class.
//
// Framework + control definitions live in Postgres (authoritative).
// Built-in CIS definitions are seeded from api/src/compliance/frameworks/*.json
// at startup (onReady hook) and on-demand via /frameworks/reseed-builtins.

import { randomUUID } from 'crypto'
import { loadFrameworks, getFramework, getControl, evaluateFramework } from '../compliance/evaluator.js'
import { seedBuiltinFrameworks } from '../compliance/seeder.js'
import { compileFormRule, getSchema, RESOURCE_TYPE_WHITELIST } from '../compliance/form-evaluator.js'

// Resolve a control definition to an executable Cypher query + params, handling
// both hand-written (evaluator='cypher') and form-builder (evaluator='form')
// rules. Returns { query, params, error? }.
function resolveControlQuery(ctrl) {
  if (ctrl.evaluator === 'form') {
    if (!ctrl.formRule) return { error: 'Form-evaluator control is missing formRule' }
    const compiled = compileFormRule(ctrl.formRule)
    if (compiled.error) return { error: `Form rule invalid: ${compiled.error}` }
    return { query: compiled.query, params: compiled.params }
  }
  if (!ctrl.query) return { error: 'No Cypher query defined' }
  return { query: ctrl.query, params: ctrl.params || {} }
}

// Create the compliance catalog tables if they don't already exist.
// Mirrors postgres-init/07-compliance-catalog.sql so fresh environments
// without the ConfigMap-baked init SQL still bootstrap correctly.
const CREATE_COMPLIANCE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS benchmarks (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    version     TEXT NOT NULL,
    provider    TEXT NOT NULL,
    description TEXT,
    reference   TEXT,
    source      TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_benchmarks_provider ON benchmarks(provider);
  CREATE INDEX IF NOT EXISTS idx_benchmarks_source   ON benchmarks(source);

  CREATE TABLE IF NOT EXISTS controls (
    id             TEXT NOT NULL,
    benchmark_id   TEXT NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
    section        TEXT,
    section_title  TEXT,
    level          INTEGER,
    title          TEXT NOT NULL,
    description    TEXT,
    rationale      TEXT,
    severity       TEXT NOT NULL,
    rating         INTEGER,
    automated      BOOLEAN NOT NULL DEFAULT true,
    evaluator      TEXT NOT NULL,
    resource_type  TEXT,
    query          TEXT,
    params         JSONB NOT NULL DEFAULT '{}',
    form_rule      JSONB,
    remediation    JSONB NOT NULL DEFAULT '{}',
    source         TEXT NOT NULL,
    enabled        BOOLEAN NOT NULL DEFAULT true,
    created_by     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (benchmark_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_controls_benchmark ON controls(benchmark_id);
  CREATE INDEX IF NOT EXISTS idx_controls_source    ON controls(source);

  CREATE TABLE IF NOT EXISTS control_overrides (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    benchmark_id  TEXT NOT NULL,
    control_id    TEXT NOT NULL,
    disabled      BOOLEAN NOT NULL DEFAULT false,
    severity      TEXT,
    rating        INTEGER,
    remediation   JSONB,
    note          TEXT,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (benchmark_id, control_id)
  );
`

export default async function complianceRoutes(fastify) {
  const { query, write } = fastify.neo4j
  const audit = (...a) => fastify.pg?.audit?.(...a).catch(() => {})
  const actor = (req) => req.user?.name || req.user?.id || 'system'

  // ── Bootstrap: ensure tables + seed built-in frameworks on startup ─────────
  fastify.addHook('onReady', async () => {
    if (!fastify.pg?.pool) {
      fastify.log.warn('[compliance] Postgres not available — catalog features degraded')
      return
    }
    try {
      await fastify.pg.query(CREATE_COMPLIANCE_TABLES_SQL)
      fastify.log.info('[compliance] Catalog tables ready')
    } catch (err) {
      fastify.log.warn(`[compliance] Table init warning: ${err.message}`)
      return
    }
    try {
      const result = await seedBuiltinFrameworks(fastify.pg, fastify.log)
      const ok = (result.frameworks || []).filter(f => !f.error).length
      const errs = (result.frameworks || []).filter(f => f.error).length
      fastify.log.info(`[compliance] Seed complete: ${ok} ok, ${errs} error(s)`)
    } catch (err) {
      fastify.log.error(`[compliance] Seed failed: ${err.message}`)
    }
  })

  // ── GET /compliance/schedule ───────────────────────────────────────────────
  fastify.get('/schedule', async () => {
    const sched = await fastify.complianceScheduler?.getSchedule()
    if (!sched) return { enabled: false, interval_mins: 60 }
    // Fetch recent runs per framework
    let runs = []
    if (fastify.pg?.pool) {
      try {
        const rows = await fastify.pg.query(
          `SELECT framework_id, started_at, completed_at, status, score,
                  pass_count, fail_count, na_count, error
           FROM compliance_runs
           WHERE started_at > now() - interval '30 days'
           ORDER BY started_at DESC LIMIT 50`
        )
        runs = rows
      } catch {}
    }
    return { ...sched, recentRuns: runs }
  })

  // ── PATCH /compliance/schedule ─────────────────────────────────────────────
  fastify.patch('/schedule', async (req, reply) => {
    if (!fastify.complianceScheduler) return reply.serviceUnavailable('Scheduler not available')
    const { enabled, interval_mins } = req.body || {}
    const fields = {}
    if (typeof enabled === 'boolean') fields.enabled = enabled
    if (typeof interval_mins === 'number' && interval_mins >= 5 && interval_mins <= 1440) {
      fields.interval_mins = interval_mins
    }
    const updated = await fastify.complianceScheduler.updateSchedule(fields)
    audit(actor(req), 'update', 'ComplianceSchedule', 'global', 'global', fields)
    // Restart timer so changes apply immediately
    await fastify.complianceScheduler.restart()
    return updated
  })

  // ── POST /compliance/schedule/run-now ──────────────────────────────────────
  fastify.post('/schedule/run-now', async (req, reply) => {
    if (!fastify.complianceScheduler) return reply.serviceUnavailable('Scheduler not available')
    audit(actor(req), 'run', 'ComplianceSchedule', 'global', 'manual-trigger', {})
    fastify.complianceScheduler.runNow().catch(e =>
      fastify.log.error(`[compliance/run-now] ${e.message}`)
    )
    return { started: true }
  })

  // ── GET /compliance/frameworks ─────────────────────────────────────────────
  fastify.get('/frameworks', async () => {
    const all = await loadFrameworks(fastify.pg, fastify.log)
    return all.map(fw => ({
      id: fw.id,
      name: fw.name,
      version: fw.version,
      provider: fw.provider,
      description: fw.description,
      reference: fw.reference,
      source: fw.source,
      controlCount: fw.controls.length,
    }))
  })

  // ── GET /compliance/frameworks/:id ─────────────────────────────────────────
  fastify.get('/frameworks/:id', async (req, reply) => {
    const fw = await getFramework(fastify.pg, req.params.id, fastify.log)
    if (!fw) return reply.notFound(`Framework not found: ${req.params.id}`)
    return fw
  })

  // ── POST /compliance/frameworks/reseed-builtins ────────────────────────────
  // Re-run the JSON seeder without a pod restart. Overwrites built-in control
  // definitions; never touches custom controls or overrides.
  fastify.post('/frameworks/reseed-builtins', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Postgres not available')
    try {
      const result = await seedBuiltinFrameworks(fastify.pg, fastify.log)
      audit(actor(req), 'reseed', 'Benchmark', 'builtins', 'all',
        { frameworks: result.frameworks?.length || 0 })
      return result
    } catch (err) {
      fastify.log.error(`[compliance] Reseed failed: ${err.message}`)
      return reply.internalServerError(`Reseed failed: ${err.message}`)
    }
  })

  // ── POST /compliance/frameworks/:id/evaluate ───────────────────────────────
  fastify.post('/frameworks/:id/evaluate', async (req, reply) => {
    const fw = await getFramework(fastify.pg, req.params.id, fastify.log)
    if (!fw) return reply.notFound(`Framework not found: ${req.params.id}`)
    try {
      const result = await evaluateFramework(query, fw)
      audit(actor(req), 'evaluate', 'Benchmark', fw.id, fw.name,
        { score: result.score, failures: result.counts.FAIL })
      return result
    } catch (err) {
      fastify.log.error(`[compliance] Evaluate failed for ${fw.id}: ${err.message}`)
      return reply.internalServerError(`Evaluation failed: ${err.message}`)
    }
  })

  // ── GET /compliance/controls/:frameworkId/:controlId ───────────────────────
  fastify.get('/controls/:frameworkId/:controlId', async (req, reply) => {
    const ctrl = await getControl(fastify.pg, req.params.frameworkId, req.params.controlId, fastify.log)
    if (!ctrl) return reply.notFound(`Control not found: ${req.params.controlId}`)
    return ctrl
  })

  // ── GET /compliance/controls/:frameworkId/:controlId/blast-radius ──────────
  // Re-evaluate the control to get current failing resources, then traverse
  // the graph to find applications and components affected by remediation.
  fastify.get('/controls/:frameworkId/:controlId/blast-radius', async (req, reply) => {
    const ctrl = await getControl(fastify.pg, req.params.frameworkId, req.params.controlId, fastify.log)
    if (!ctrl) return reply.notFound(`Control not found: ${req.params.controlId}`)

    // Re-run the control query to get fresh failing resources (supports both
    // hand-written Cypher controls and form-builder controls).
    let failingIds = []
    const resolved = resolveControlQuery(ctrl)
    if (!resolved.error) {
      try {
        const rows = await query(resolved.query, resolved.params)
        failingIds = rows
          .map(r => r.keys?.includes('resourceId') ? r.get('resourceId') : null)
          .filter(Boolean)
      } catch (err) {
        return { applications: [], components: [], infra: [], failingResources: [], note: `Control not evaluable: ${err.message}` }
      }
    }

    if (!failingIds.length) {
      return { applications: [], components: [], infra: [], failingResources: [] }
    }

    // Find applications and components that touch the failing resources.
    // The failing resource could be :Infra, :Application, :Change, etc. —
    // do a broad traversal.
    const blast = await query(
      `UNWIND $ids AS rid
       MATCH (n {id: rid})
       OPTIONAL MATCH (n)<-[:DEPLOYED_ON]-(c:Component)<-[:CONTAINS]-(a:Application)
       OPTIONAL MATCH (a2:Application {id: rid})
       OPTIONAL MATCH (c2:Component {id: rid})<-[:CONTAINS]-(a3:Application)
       WITH rid,
            collect(DISTINCT {id: n.id, name: n.name, type: coalesce(n.resource_type, labels(n)[0])}) AS failing,
            collect(DISTINCT {id: a.id, name: a.name, tier: a.tier}) AS appsViaInfra,
            collect(DISTINCT {id: a2.id, name: a2.name, tier: a2.tier}) AS directApp,
            collect(DISTINCT {id: a3.id, name: a3.name, tier: a3.tier}) AS appsViaComp,
            collect(DISTINCT {id: c.id, name: c.name}) AS comps,
            collect(DISTINCT {id: c2.id, name: c2.name}) AS directComps
       RETURN rid,
              failing[0] AS failing,
              [x IN appsViaInfra + directApp + appsViaComp WHERE x.id IS NOT NULL] AS apps,
              [x IN comps + directComps WHERE x.id IS NOT NULL] AS components`,
      { ids: failingIds }
    )

    const allApps = new Map()
    const allComps = new Map()
    const failing = []
    for (const rec of blast) {
      const f = rec.get('failing')
      if (f?.id) failing.push(f)
      for (const a of rec.get('apps') || []) {
        if (a.id) allApps.set(a.id, a)
      }
      for (const c of rec.get('components') || []) {
        if (c.id) allComps.set(c.id, c)
      }
    }

    const apps = [...allApps.values()]
    const tier1 = apps.filter(a => a.tier === 1)
    return {
      failingResources: failing,
      applications: apps,
      components: [...allComps.values()],
      infra: failing.filter(f => f.type && !['Application', 'Change', 'Component'].includes(f.type)),
      tier1Count: tier1.length,
      highRisk: tier1.length > 0,
    }
  })

  // ── POST /compliance/controls/:frameworkId/:controlId/create-change ────────
  // Drafts a :Change node linked to the failing resources and the :Control
  // via a REMEDIATES relationship. Also MERGEs :Benchmark and :Control nodes
  // so the graph has first-class compliance metadata.
  // Uses the same shape as /changes so the existing workflow picks it up.
  fastify.post('/controls/:frameworkId/:controlId/create-change', async (req, reply) => {
    const fw = await getFramework(fastify.pg, req.params.frameworkId, fastify.log)
    if (!fw) return reply.notFound(`Framework not found: ${req.params.frameworkId}`)
    const ctrl = await getControl(fastify.pg, req.params.frameworkId, req.params.controlId, fastify.log)
    if (!ctrl) return reply.notFound(`Control not found: ${req.params.controlId}`)

    // Guard: if an open remediation change already exists for this control,
    // return it instead of creating a duplicate.
    const existing = await query(
      `MATCH (ch:Change)-[:REMEDIATES]->(:Control {id: $controlId, benchmarkId: $frameworkId})
       WHERE ch.status IN ['draft','in_review','approved','scheduled']
       RETURN ch.id AS id, ch.title AS title, ch.status AS status,
              ch.riskScore AS riskScore, ch.createdAt AS createdAt
       ORDER BY ch.createdAt DESC LIMIT 1`,
      { controlId: ctrl.id, frameworkId: req.params.frameworkId }
    )
    if (existing.length) {
      const r = existing[0]
      reply.code(200)
      return {
        id: r.get('id'),
        title: r.get('title'),
        status: r.get('status'),
        riskScore: r.get('riskScore'),
        controlId: ctrl.id,
        existing: true,
        message: `An open remediation change already exists for this control (${r.get('status')}). Opening the existing draft.`,
      }
    }

    // Get failing resources to compute risk (supports both Cypher and form controls)
    let failingIds = []
    const resolvedQuery = resolveControlQuery(ctrl)
    if (resolvedQuery.error) {
      return reply.badRequest(`Control not evaluable: ${resolvedQuery.error}`)
    }
    try {
      const rows = await query(resolvedQuery.query, resolvedQuery.params)
      failingIds = rows
        .map(r => r.keys?.includes('resourceId') ? r.get('resourceId') : null)
        .filter(Boolean)
    } catch (err) {
      return reply.badRequest(`Control query failed: ${err.message}`)
    }

    if (!failingIds.length) {
      return reply.badRequest('No failing resources found for this control — nothing to remediate.')
    }

    // Optional: caller marks this as a no-risk metadata change (tag update,
    // ownership assignment, classification fix). Skips Tier-1 risk bump,
    // uses the lowest risk score, and records a different change type.
    const noRisk = Boolean(req.body?.noRisk)
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : ''

    let riskScore
    let changeType = 'compliance-remediation'

    if (noRisk) {
      riskScore = 1
      changeType = 'compliance-metadata-remediation'
    } else {
      // Compute risk score from severity + Tier-1 exposure
      const sevScore = { CRITICAL: 10, HIGH: 8, MEDIUM: 5, LOW: 3 }
      const baseRisk = sevScore[ctrl.severity] || 5

      const tier1Check = await query(
        `UNWIND $ids AS rid
         MATCH (n {id: rid})
         OPTIONAL MATCH (n)<-[:DEPLOYED_ON]-(:Component)<-[:CONTAINS]-(a:Application {tier: 1})
         OPTIONAL MATCH (a2:Application {id: rid, tier: 1})
         RETURN count(DISTINCT a) + count(DISTINCT a2) AS tier1Count`,
        { ids: failingIds }
      )
      const tier1Count = tier1Check[0]?.get('tier1Count') || 0
      riskScore = Math.min(10, baseRisk + (Number(tier1Count) > 0 ? 1 : 0))
    }

    const changeId = randomUUID()
    const title = `Remediate ${ctrl.id}: ${ctrl.title}${noRisk ? ' (metadata only)' : ''}`
    const descParts = [ctrl.remediation?.summary || ctrl.rationale || '']
    if (note) descParts.push(`\n\nNote: ${note}`)
    if (noRisk) descParts.push('\n\nFlagged as no-risk metadata change — does not modify infrastructure configuration.')
    const description = descParts.join('').slice(0, 1200)
    const now = new Date().toISOString()

    try {
      // Create the :Change node and link it to Benchmark + Control nodes.
      // MERGE keeps these idempotent so repeated Change creation reuses the
      // same Control/Benchmark nodes.
      await write(
        `// 1. Ensure Benchmark + Control nodes exist
         MERGE (bm:Benchmark {id: $frameworkId})
           ON CREATE SET bm.name = $benchmarkName,
                         bm.version = $benchmarkVersion,
                         bm.provider = $benchmarkProvider,
                         bm.createdAt = $now
           ON MATCH  SET bm.name = $benchmarkName,
                         bm.version = $benchmarkVersion,
                         bm.provider = $benchmarkProvider
         MERGE (ctrl:Control {id: $controlId, benchmarkId: $frameworkId})
           ON CREATE SET ctrl.title = $controlTitle,
                         ctrl.section = $controlSection,
                         ctrl.severity = $controlSeverity,
                         ctrl.createdAt = $now
           ON MATCH  SET ctrl.title = $controlTitle,
                         ctrl.section = $controlSection,
                         ctrl.severity = $controlSeverity
         MERGE (bm)-[:HAS_CONTROL]->(ctrl)
         // 2. Create the Change node
         CREATE (ch:Change {
           id: $id,
           title: $title,
           description: $description,
           type: $changeType,
           status: 'draft',
           riskScore: $riskScore,
           submittedBy: $actor,
           createdAt: $now,
           controlId: $controlId,
           benchmarkId: $frameworkId,
           noRisk: $noRisk
         })
         // 3. Link Change -[:REMEDIATES]-> Control (closed-loop tracking)
         MERGE (ch)-[:REMEDIATES]->(ctrl)
         // 4. Link Change -[:MODIFIES]-> failing resources + AFFECTS apps
         WITH ch
         UNWIND $ids AS rid
         MATCH (target {id: rid})
         MERGE (ch)-[:MODIFIES]->(target)
         WITH ch, target
         OPTIONAL MATCH (target)<-[:DEPLOYED_ON]-(:Component)<-[:CONTAINS]-(a:Application)
         FOREACH (app IN CASE WHEN a IS NULL THEN [] ELSE [a] END |
           MERGE (ch)-[:AFFECTS]->(app)
         )
         RETURN ch.id AS id`,
        {
          id: changeId,
          title,
          description,
          riskScore,
          changeType,
          noRisk,
          actor: actor(req),
          now,
          controlId: ctrl.id,
          controlTitle: ctrl.title || '',
          controlSection: ctrl.section || '',
          controlSeverity: ctrl.severity || 'MEDIUM',
          frameworkId: req.params.frameworkId,
          benchmarkName: fw.name || '',
          benchmarkVersion: fw.version || '',
          benchmarkProvider: fw.provider || '',
          ids: failingIds,
        }
      )

      audit(actor(req), 'create', 'Change', changeId, title,
        { type: changeType, controlId: ctrl.id, riskScore, noRisk, failingCount: failingIds.length })

      reply.code(201)
      return {
        id: changeId,
        title,
        status: 'draft',
        riskScore,
        noRisk,
        type: changeType,
        controlId: ctrl.id,
        affectedResourceIds: failingIds,
        existing: false,
        message: `Draft ${noRisk ? 'metadata-only ' : ''}change created with ${failingIds.length} resource${failingIds.length === 1 ? '' : 's'}. Review on the Changes page.`,
      }
    } catch (err) {
      fastify.log.error(`[compliance] Failed to create change: ${err.message}`)
      return reply.internalServerError(`Failed to create change: ${err.message}`)
    }
  })

  // ── GET /compliance/frameworks/:id/remediation-status ──────────────────────
  // Returns a map of controlId → latest remediation Change for the entire
  // framework. Lets the UI render "remediation in progress" badges on every
  // control in one call, rather than N queries.
  fastify.get('/frameworks/:id/remediation-status', async (req, reply) => {
    const fw = await getFramework(fastify.pg, req.params.id, fastify.log)
    if (!fw) return reply.notFound(`Framework not found: ${req.params.id}`)

    try {
      const rows = await query(
        `MATCH (ch:Change)-[:REMEDIATES]->(ctrl:Control {benchmarkId: $frameworkId})
         WITH ctrl.id AS controlId, ch
         ORDER BY ch.createdAt DESC
         WITH controlId, collect(ch)[0] AS latest
         RETURN controlId,
                latest.id AS id,
                latest.title AS title,
                latest.status AS status,
                latest.riskScore AS riskScore,
                latest.type AS type,
                latest.noRisk AS noRisk,
                latest.createdAt AS createdAt,
                latest.submittedBy AS submittedBy`,
        { frameworkId: req.params.id }
      )

      const byControl = {}
      for (const r of rows) {
        const controlId = r.get('controlId')
        if (!controlId) continue
        byControl[controlId] = {
          id: r.get('id'),
          title: r.get('title'),
          status: r.get('status'),
          riskScore: r.get('riskScore'),
          type: r.get('type'),
          noRisk: Boolean(r.get('noRisk')),
          createdAt: r.get('createdAt'),
          submittedBy: r.get('submittedBy'),
          isOpen: ['draft', 'in_review', 'approved', 'scheduled'].includes(r.get('status')),
        }
      }
      return { frameworkId: req.params.id, byControl }
    } catch (err) {
      fastify.log.warn(`[compliance] remediation-status failed: ${err.message}`)
      return { frameworkId: req.params.id, byControl: {} }
    }
  })

  // ── GET /compliance/schema ─────────────────────────────────────────────────
  // Feeds the UI form builder: whitelisted resource types, operators, and
  // properties per type. UI uses this to populate dropdowns.
  fastify.get('/schema', async () => {
    return getSchema()
  })

  // ── POST /compliance/frameworks ────────────────────────────────────────────
  // Create a new custom framework (source='custom'). Users group their
  // custom rules under a named benchmark (e.g. "Internal Security Controls v1").
  fastify.post('/frameworks', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Postgres not available')
    const { id, name, version, provider, description, reference } = req.body || {}
    if (!id || !name) return reply.badRequest('id and name are required')
    if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(id)) {
      return reply.badRequest('id must contain only letters, digits, dashes, underscores, dots')
    }
    try {
      const rows = await fastify.pg.query(
        `INSERT INTO benchmarks (id, name, version, provider, description, reference, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'custom')
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           version = EXCLUDED.version,
           provider = EXCLUDED.provider,
           description = EXCLUDED.description,
           reference = EXCLUDED.reference,
           updated_at = now()
         WHERE benchmarks.source = 'custom'
         RETURNING id, name, version, provider, source`,
        [id, name, version || '1.0', provider || 'custom',
         description || null, reference || null]
      )
      if (!rows.length) {
        return reply.conflict(`Benchmark ${id} exists but is not custom — cannot overwrite via this endpoint`)
      }
      audit(actor(req), 'create', 'Benchmark', id, name, { source: 'custom' })
      reply.code(201)
      return rows[0]
    } catch (err) {
      fastify.log.error(`[compliance] Create framework failed: ${err.message}`)
      return reply.internalServerError(`Failed to create framework: ${err.message}`)
    }
  })

  // ── DELETE /compliance/frameworks/:id ──────────────────────────────────────
  fastify.delete('/frameworks/:id', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Postgres not available')
    const existing = await fastify.pg.query(
      `SELECT source, name FROM benchmarks WHERE id = $1`, [req.params.id]
    )
    if (!existing.length) return reply.notFound(`Framework not found: ${req.params.id}`)
    const src = existing[0].source
    if (src === 'builtin') {
      return reply.badRequest(`Cannot delete built-in benchmark ${req.params.id}. Disable individual controls via overrides instead.`)
    }
    await fastify.pg.query(`DELETE FROM benchmarks WHERE id = $1`, [req.params.id])
    audit(actor(req), 'delete', 'Benchmark', req.params.id, existing[0].name, { source: src })
    reply.code(204)
  })

  // ── POST /compliance/frameworks/:id/controls ───────────────────────────────
  // Create a custom control within a benchmark. The benchmark must be
  // source='custom' (or 'imported'); built-in benchmarks reject writes.
  fastify.post('/frameworks/:id/controls', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Postgres not available')

    const fwRows = await fastify.pg.query(
      `SELECT source FROM benchmarks WHERE id = $1`, [req.params.id]
    )
    if (!fwRows.length) return reply.notFound(`Framework not found: ${req.params.id}`)
    if (fwRows[0].source === 'builtin') {
      return reply.badRequest('Cannot add controls to a built-in benchmark. Create a custom framework first.')
    }

    const {
      id, title, description, rationale, severity = 'MEDIUM', rating,
      section, sectionTitle, level,
      formRule, remediation = { summary: '', steps: [], references: [] },
    } = req.body || {}

    if (!id || !title) return reply.badRequest('id and title are required')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.\-]*$/.test(id)) {
      return reply.badRequest('Control id must contain only letters, digits, dashes, underscores, dots')
    }
    if (!['CRITICAL','HIGH','MEDIUM','LOW'].includes(severity)) {
      return reply.badRequest('severity must be CRITICAL, HIGH, MEDIUM or LOW')
    }
    if (!formRule || typeof formRule !== 'object') {
      return reply.badRequest('formRule is required (custom controls use the form builder)')
    }

    // Pre-validate the form rule by compiling it. We still store it even if
    // the graph labels don't exist yet, but reject injection attempts early.
    const compiled = compileFormRule(formRule)
    if (compiled.error) return reply.badRequest(`Invalid form rule: ${compiled.error}`)

    try {
      const rows = await fastify.pg.query(
        `INSERT INTO controls (
           id, benchmark_id, section, section_title, level, title, description,
           rationale, severity, rating, automated, evaluator, resource_type,
           form_rule, remediation, source, enabled, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, 'form', $11,
           $12, $13, 'custom', true, $14
         )
         ON CONFLICT (benchmark_id, id) DO UPDATE SET
           section       = EXCLUDED.section,
           section_title = EXCLUDED.section_title,
           level         = EXCLUDED.level,
           title         = EXCLUDED.title,
           description   = EXCLUDED.description,
           rationale     = EXCLUDED.rationale,
           severity      = EXCLUDED.severity,
           rating        = EXCLUDED.rating,
           resource_type = EXCLUDED.resource_type,
           form_rule     = EXCLUDED.form_rule,
           remediation   = EXCLUDED.remediation,
           updated_at    = now()
         WHERE controls.source = 'custom'
         RETURNING *`,
        [id, req.params.id, section || null, sectionTitle || null, level ?? null,
         title, description || null, rationale || null, severity, rating ?? null,
         formRule.resourceType || null, JSON.stringify(formRule),
         JSON.stringify(remediation), actor(req)]
      )
      if (!rows.length) return reply.conflict(`Control ${id} exists but is not custom`)
      audit(actor(req), 'create', 'Control', `${req.params.id}:${id}`, title,
        { source: 'custom', severity })
      reply.code(201)
      return rows[0]
    } catch (err) {
      fastify.log.error(`[compliance] Create control failed: ${err.message}`)
      return reply.internalServerError(`Failed to create control: ${err.message}`)
    }
  })

  // ── PATCH /compliance/frameworks/:id/controls/:cid ─────────────────────────
  fastify.patch('/frameworks/:id/controls/:cid', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Postgres not available')

    const existing = await fastify.pg.query(
      `SELECT source FROM controls WHERE benchmark_id=$1 AND id=$2`,
      [req.params.id, req.params.cid]
    )
    if (!existing.length) return reply.notFound(`Control not found: ${req.params.cid}`)
    if (existing[0].source !== 'custom') {
      return reply.badRequest('Only custom controls can be edited. Use overrides to adjust built-ins.')
    }

    const {
      title, description, rationale, severity, rating,
      section, sectionTitle, level, formRule, remediation,
    } = req.body || {}

    if (severity && !['CRITICAL','HIGH','MEDIUM','LOW'].includes(severity)) {
      return reply.badRequest('severity must be CRITICAL, HIGH, MEDIUM or LOW')
    }
    if (formRule) {
      const compiled = compileFormRule(formRule)
      if (compiled.error) return reply.badRequest(`Invalid form rule: ${compiled.error}`)
    }

    try {
      const rows = await fastify.pg.query(
        `UPDATE controls SET
           title         = COALESCE($1, title),
           description   = COALESCE($2, description),
           rationale     = COALESCE($3, rationale),
           severity      = COALESCE($4, severity),
           rating        = COALESCE($5, rating),
           section       = COALESCE($6, section),
           section_title = COALESCE($7, section_title),
           level         = COALESCE($8, level),
           resource_type = COALESCE($9, resource_type),
           form_rule     = COALESCE($10::jsonb, form_rule),
           remediation   = COALESCE($11::jsonb, remediation),
           updated_at    = now()
         WHERE benchmark_id = $12 AND id = $13 AND source = 'custom'
         RETURNING *`,
        [title ?? null, description ?? null, rationale ?? null,
         severity ?? null, rating ?? null,
         section ?? null, sectionTitle ?? null, level ?? null,
         formRule?.resourceType ?? null,
         formRule ? JSON.stringify(formRule) : null,
         remediation ? JSON.stringify(remediation) : null,
         req.params.id, req.params.cid]
      )
      if (!rows.length) return reply.notFound('Control not updated')
      audit(actor(req), 'update', 'Control', `${req.params.id}:${req.params.cid}`,
        title || req.params.cid, {})
      return rows[0]
    } catch (err) {
      fastify.log.error(`[compliance] Update control failed: ${err.message}`)
      return reply.internalServerError(`Failed to update control: ${err.message}`)
    }
  })

  // ── DELETE /compliance/frameworks/:id/controls/:cid ────────────────────────
  fastify.delete('/frameworks/:id/controls/:cid', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Postgres not available')
    const existing = await fastify.pg.query(
      `SELECT source, title FROM controls WHERE benchmark_id=$1 AND id=$2`,
      [req.params.id, req.params.cid]
    )
    if (!existing.length) return reply.notFound(`Control not found: ${req.params.cid}`)
    if (existing[0].source !== 'custom') {
      return reply.badRequest('Only custom controls can be deleted. Disable built-ins via an override instead.')
    }
    await fastify.pg.query(
      `DELETE FROM controls WHERE benchmark_id=$1 AND id=$2 AND source='custom'`,
      [req.params.id, req.params.cid]
    )
    audit(actor(req), 'delete', 'Control', `${req.params.id}:${req.params.cid}`,
      existing[0].title, { source: 'custom' })
    reply.code(204)
  })

  // ── PUT /compliance/frameworks/:id/controls/:cid/override ──────────────────
  // Upsert an override for a built-in (or any) control. Null fields inherit
  // from the base definition. Setting `disabled: true` turns the control off.
  fastify.put('/frameworks/:id/controls/:cid/override', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Postgres not available')

    const ctrlRows = await fastify.pg.query(
      `SELECT id FROM controls WHERE benchmark_id=$1 AND id=$2`,
      [req.params.id, req.params.cid]
    )
    if (!ctrlRows.length) return reply.notFound(`Control not found: ${req.params.cid}`)

    const { disabled, severity, rating, remediation, note } = req.body || {}
    if (severity && !['CRITICAL','HIGH','MEDIUM','LOW'].includes(severity)) {
      return reply.badRequest('severity must be CRITICAL, HIGH, MEDIUM or LOW')
    }

    try {
      const rows = await fastify.pg.query(
        `INSERT INTO control_overrides (
           benchmark_id, control_id, disabled, severity, rating, remediation, note, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (benchmark_id, control_id) DO UPDATE SET
           disabled    = EXCLUDED.disabled,
           severity    = EXCLUDED.severity,
           rating      = EXCLUDED.rating,
           remediation = EXCLUDED.remediation,
           note        = EXCLUDED.note,
           updated_at  = now()
         RETURNING *`,
        [req.params.id, req.params.cid,
         Boolean(disabled), severity || null, rating ?? null,
         remediation ? JSON.stringify(remediation) : null,
         note || null, actor(req)]
      )
      audit(actor(req), 'override', 'Control', `${req.params.id}:${req.params.cid}`,
        req.params.cid, { disabled: Boolean(disabled), severity, rating })
      return rows[0]
    } catch (err) {
      fastify.log.error(`[compliance] Override failed: ${err.message}`)
      return reply.internalServerError(`Failed to set override: ${err.message}`)
    }
  })

  // ── DELETE /compliance/frameworks/:id/controls/:cid/override ───────────────
  fastify.delete('/frameworks/:id/controls/:cid/override', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Postgres not available')
    const res = await fastify.pg.query(
      `DELETE FROM control_overrides WHERE benchmark_id=$1 AND control_id=$2 RETURNING id`,
      [req.params.id, req.params.cid]
    )
    if (!res.length) return reply.notFound('Override not found')
    audit(actor(req), 'clear-override', 'Control',
      `${req.params.id}:${req.params.cid}`, req.params.cid, {})
    reply.code(204)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 5 — Reporting & scoring
  // ═══════════════════════════════════════════════════════════════════════════

  // ── GET /compliance/frameworks/:id/history ────────────────────────────────
  // Returns the score time-series for a framework. Feeds the sparkline UI and
  // any future trend chart. Each point is a past run of evaluateFramework —
  // either triggered by the scheduler or a manual evaluation.
  //
  // Query params:
  //   days  - how far back to look (default 30, capped at 365)
  //   limit - max points (default 60)
  fastify.get('/frameworks/:id/history', async (req, reply) => {
    if (!fastify.pg?.pool) return { frameworkId: req.params.id, points: [] }
    const fw = await getFramework(fastify.pg, req.params.id, fastify.log)
    if (!fw) return reply.notFound(`Framework not found: ${req.params.id}`)

    const days = Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10)))
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '60', 10)))

    try {
      const rows = await fastify.pg.query(
        `SELECT started_at, completed_at, status, score,
                pass_count, fail_count, na_count, error
         FROM compliance_runs
         WHERE framework_id = $1
           AND started_at > now() - ($2 || ' days')::interval
         ORDER BY started_at DESC
         LIMIT $3`,
        [req.params.id, String(days), limit]
      )
      // Flip to chronological for sparkline rendering
      const points = rows.reverse().map(r => ({
        at: r.started_at,
        score: r.score,
        pass: r.pass_count,
        fail: r.fail_count,
        na: r.na_count,
        status: r.status,
      }))
      return {
        frameworkId: req.params.id,
        days,
        points,
      }
    } catch (err) {
      fastify.log.warn(`[compliance] history failed: ${err.message}`)
      return { frameworkId: req.params.id, points: [] }
    }
  })

  // ── Shared helper: build the current evaluation + metadata ────────────────
  // Used by both CSV and PDF exports so the numbers and status match the UI.
  async function buildReportData(frameworkId) {
    const fw = await getFramework(fastify.pg, frameworkId, fastify.log)
    if (!fw) return null
    const evaluation = await evaluateFramework(query, fw)

    // History (30 days) for trend section
    let history = []
    if (fastify.pg?.pool) {
      try {
        const rows = await fastify.pg.query(
          `SELECT started_at, score FROM compliance_runs
           WHERE framework_id = $1 AND started_at > now() - interval '30 days'
           ORDER BY started_at ASC`,
          [frameworkId]
        )
        history = rows
      } catch {}
    }

    return { framework: fw, evaluation, history }
  }

  // ── GET /compliance/frameworks/:id/export.csv ─────────────────────────────
  // Per-control pass/fail report with severity, resource count, override
  // state, and evidence snippets. Keeps CSV values safely quoted.
  fastify.get('/frameworks/:id/export.csv', async (req, reply) => {
    const data = await buildReportData(req.params.id)
    if (!data) return reply.notFound(`Framework not found: ${req.params.id}`)
    const { framework, evaluation, history } = data
    const ts = new Date().toISOString()

    // CSV-safe quoting: wrap in double quotes and escape inner quotes.
    const q = (v) => {
      if (v === null || v === undefined) return ''
      const s = String(v).replace(/"/g, '""')
      return `"${s}"`
    }

    const lines = []

    // Header block
    lines.push(`AppCloud Compliance Report — ${framework.name}`)
    lines.push(`Framework,${q(framework.id)}`)
    lines.push(`Version,${q(framework.version)}`)
    lines.push(`Provider,${q(framework.provider)}`)
    lines.push(`Generated,${ts}`)
    lines.push(`Score,${evaluation.score}%`)
    lines.push(`Coverage,${evaluation.coverage}%`)
    lines.push(``)

    // Summary counts
    lines.push(`SUMMARY`)
    lines.push(`Metric,Value`)
    lines.push(`Total Controls,${evaluation.total}`)
    lines.push(`Passing,${evaluation.counts.PASS || 0}`)
    lines.push(`Failing,${evaluation.counts.FAIL || 0}`)
    lines.push(`Not Applicable,${evaluation.counts.NOT_APPLICABLE || 0}`)
    lines.push(`Manual,${evaluation.counts.MANUAL || 0}`)
    lines.push(`Critical Failures,${evaluation.severityBreakdown?.CRITICAL || 0}`)
    lines.push(`High Failures,${evaluation.severityBreakdown?.HIGH || 0}`)
    lines.push(`Medium Failures,${evaluation.severityBreakdown?.MEDIUM || 0}`)
    lines.push(`Low Failures,${evaluation.severityBreakdown?.LOW || 0}`)
    lines.push(``)

    // Per-control results
    lines.push(`CONTROLS`)
    lines.push([
      'Control ID','Section','Title','Severity','Status',
      'Failing Resources','Source','Overridden','Note','Rationale'
    ].map(q).join(','))
    for (const c of evaluation.controls) {
      lines.push([
        c.id, c.section || '', c.title,
        c.severity, c.status, c.failCount || 0,
        c.source || 'builtin',
        c.override ? 'yes' : 'no',
        c.override?.note || '',
        (c.rationale || '').slice(0, 400),
      ].map(q).join(','))
    }
    lines.push(``)

    // Violations (flattened — one row per failing resource)
    const violatingControls = evaluation.controls.filter(c => c.status === 'FAIL')
    if (violatingControls.length) {
      lines.push(`FAILING RESOURCES`)
      lines.push(['Control ID','Severity','Resource ID','Resource Name','Resource Type','Evidence'].map(q).join(','))
      for (const c of violatingControls) {
        for (const v of (c.violations || [])) {
          lines.push([
            c.id, c.severity,
            v.resourceId || '', v.resourceName || '',
            v.resourceType || '', v.evidence || '',
          ].map(q).join(','))
        }
      }
      lines.push(``)
    }

    // Score history (last 30 days)
    if (history.length) {
      lines.push(`SCORE HISTORY (30 days)`)
      lines.push(['Timestamp','Score'].map(q).join(','))
      for (const r of history) {
        lines.push([r.started_at?.toISOString?.() || r.started_at, r.score ?? ''].map(q).join(','))
      }
    }

    const csv = lines.join('\n')
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition',
        `attachment; filename="appcloud-${framework.id}-${ts.slice(0,10)}.csv"`)
      .send(csv)
  })

  // ── GET /compliance/frameworks/:id/export.pdf ─────────────────────────────
  // Returns HTML that the browser prints to PDF via window.print(). Styled
  // for an auditor-ready one-pager with score, severity breakdown, sections,
  // and per-control detail.
  fastify.get('/frameworks/:id/export.pdf', async (req, reply) => {
    const data = await buildReportData(req.params.id)
    if (!data) return reply.notFound(`Framework not found: ${req.params.id}`)
    const { framework, evaluation, history } = data
    const ts = new Date().toISOString()

    const SEV_COLOR = { CRITICAL:'#f43f5e', HIGH:'#fb923c', MEDIUM:'#f59e0b', LOW:'#22c55e' }
    const STATUS_COLOR = { PASS:'#22c55e', FAIL:'#f43f5e', NOT_APPLICABLE:'#64748b', MANUAL:'#a78bfa' }
    const scoreColor = evaluation.score >= 80 ? '#22c55e' : evaluation.score >= 60 ? '#f59e0b' : '#f43f5e'

    const esc = (s) => String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

    // Group controls by section for a readable report
    const bySection = {}
    for (const c of evaluation.controls) {
      const key = c.section || 'Other'
      if (!bySection[key]) bySection[key] = { title: c.sectionTitle || key, controls: [] }
      bySection[key].controls.push(c)
    }

    // Build an inline SVG sparkline from history, if we have enough points
    let sparkSvg = ''
    if (history.length >= 2) {
      const w = 240, h = 40, pad = 2
      const scores = history.map(r => r.score ?? 0)
      const min = Math.min(...scores, 0)
      const max = Math.max(...scores, 100)
      const range = max - min || 1
      const step = (w - pad * 2) / (scores.length - 1)
      const pts = scores.map((s, i) => {
        const x = pad + i * step
        const y = h - pad - ((s - min) / range) * (h - pad * 2)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      }).join(' ')
      sparkSvg = `
        <svg width="${w}" height="${h}" style="display:block">
          <polyline fill="none" stroke="${scoreColor}" stroke-width="1.5"
            points="${pts}" />
        </svg>`
    }

    const sectionBlocks = Object.keys(bySection).sort().map(key => {
      const sec = bySection[key]
      const rows = sec.controls.map(c => `
        <tr>
          <td style="width:110px">${esc(c.id)}</td>
          <td>${esc(c.title)}
            ${c.override ? `<span class="badge badge-override">OVERRIDDEN</span>` : ''}
            ${c.source === 'custom' ? `<span class="badge badge-custom">CUSTOM</span>` : ''}
          </td>
          <td style="width:90px">
            <span class="sev" style="background:${SEV_COLOR[c.severity] || '#64748b'}22;
              color:${SEV_COLOR[c.severity] || '#64748b'};
              border:1px solid ${SEV_COLOR[c.severity] || '#64748b'}44">
              ${esc(c.severity)}
            </span>
          </td>
          <td style="width:90px">
            <span class="sev" style="background:${STATUS_COLOR[c.status] || '#64748b'}22;
              color:${STATUS_COLOR[c.status] || '#64748b'};
              border:1px solid ${STATUS_COLOR[c.status] || '#64748b'}44">
              ${esc(c.status)}
            </span>
          </td>
          <td style="width:80px;text-align:right">${c.failCount || 0}</td>
        </tr>
      `).join('')
      const pass = sec.controls.filter(c => c.status === 'PASS').length
      return `
        <h3>Section ${esc(key)} — ${esc(sec.title)} <span class="sec-count">${pass}/${sec.controls.length} pass</span></h3>
        <table>
          <thead>
            <tr><th>ID</th><th>Title</th><th>Severity</th><th>Status</th><th style="text-align:right">Failing</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `
    }).join('')

    // Collect failing-resource details for an appendix
    const failingBlocks = evaluation.controls
      .filter(c => c.status === 'FAIL' && (c.violations || []).length)
      .map(c => {
        const rows = (c.violations || []).slice(0, 50).map(v => `
          <tr>
            <td>${esc(v.resourceName || v.resourceId)}</td>
            <td>${esc(v.resourceType)}</td>
            <td>${esc(v.evidence)}</td>
          </tr>`).join('')
        const extra = (c.violations || []).length > 50
          ? `<p class="empty">+${(c.violations || []).length - 50} more resources truncated.</p>` : ''
        return `
          <h3>${esc(c.id)} — ${esc(c.title)}</h3>
          <table>
            <thead><tr><th>Resource</th><th>Type</th><th>Evidence</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${extra}
        `
      }).join('')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(framework.name)} — Compliance Report ${ts.slice(0,10)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #fff; color: #1e293b;
         padding: 40px 48px; font-size: 13px; line-height: 1.55 }
  h1 { font-size: 22px; font-weight: 800; color: #0f172a; margin-bottom: 4px }
  h2 { font-size: 14px; font-weight: 700; color: #0f172a; margin: 28px 0 10px;
       padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; text-transform: uppercase;
       letter-spacing: 0.06em }
  h3 { font-size: 12px; font-weight: 700; color: #334155; margin: 16px 0 6px;
       display: flex; align-items: center; gap: 10px }
  .meta  { font-size: 11px; color: #64748b; margin-bottom: 28px }
  .cards { display: grid; grid-template-columns: repeat(5,1fr); gap: 10px; margin-bottom: 24px }
  .card  { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px }
  .card .val  { font-size: 22px; font-weight: 800; color: #0f172a }
  .card .lbl  { font-size: 8px; color: #94a3b8; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 2px }
  .score-card { border-color: ${scoreColor}44; background: ${scoreColor}0a; grid-column: span 2 }
  .score-card .val { color: ${scoreColor}; font-size: 32px }
  .trend { grid-column: span 2; background: #f8fafc; border: 1px solid #e2e8f0;
           border-radius: 8px; padding: 12px 14px }
  .trend .lbl { font-size: 8px; color: #94a3b8; letter-spacing: 0.1em; text-transform: uppercase }
  table  { width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 11px }
  th     { text-align: left; padding: 7px 9px; background: #f1f5f9; color: #475569;
           font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
           border-bottom: 1px solid #e2e8f0 }
  td     { padding: 6px 9px; border-bottom: 1px solid #f1f5f9; vertical-align: top }
  tr:last-child td { border-bottom: none }
  .sev   { padding: 2px 7px; border-radius: 3px; font-size: 9px; font-weight: 700;
           letter-spacing: 0.06em; display: inline-block }
  .badge { font-size: 8px; padding: 1px 6px; border-radius: 3px; margin-left: 6px;
           font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase }
  .badge-override { background: #fbbf2418; color: #b45309; border: 1px solid #fbbf2444 }
  .badge-custom   { background: #a78bfa18; color: #6d28d9; border: 1px solid #a78bfa44 }
  .sec-count { font-size: 10px; color: #64748b; font-weight: 500; margin-left: 8px }
  .empty { color: #94a3b8; font-style: italic; font-size: 11px; padding: 4px 0 }
  @media print {
    body { padding: 20px 28px }
    .no-print { display: none }
    @page { margin: 1cm }
  }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
    <div>
      <h1>${esc(framework.name)}</h1>
      <div class="meta">
        Version ${esc(framework.version)} · ${esc(framework.provider)}
        &nbsp;·&nbsp; Generated ${new Date(ts).toLocaleString()}
      </div>
    </div>
    <button class="no-print" onclick="window.print()"
      style="padding:8px 18px;background:#0f172a;color:#fff;border:none;border-radius:6px;
             font-size:12px;font-weight:600;cursor:pointer">Print / Save PDF</button>
  </div>

  <div class="cards">
    <div class="card score-card">
      <div class="val">${evaluation.score}%</div>
      <div class="lbl">Compliance Score</div>
    </div>
    <div class="card">
      <div class="val">${evaluation.counts.PASS || 0}</div>
      <div class="lbl">Passing</div>
    </div>
    <div class="card">
      <div class="val">${evaluation.counts.FAIL || 0}</div>
      <div class="lbl">Failing</div>
    </div>
    <div class="trend">
      <div class="lbl" style="margin-bottom:4px">30-day trend</div>
      ${sparkSvg || '<span class="empty">No history yet</span>'}
    </div>
  </div>

  <h2>Failures by severity</h2>
  <div class="cards" style="grid-template-columns:repeat(4,1fr)">
    ${['CRITICAL','HIGH','MEDIUM','LOW'].map(s => `
      <div class="card" style="border-color:${SEV_COLOR[s]}44">
        <div class="val" style="color:${SEV_COLOR[s]}">${evaluation.severityBreakdown?.[s] || 0}</div>
        <div class="lbl">${s}</div>
      </div>
    `).join('')}
  </div>

  <h2>Controls (${evaluation.total})</h2>
  ${sectionBlocks || '<p class="empty">No controls defined.</p>'}

  ${failingBlocks ? `<h2>Failing resources — appendix</h2>${failingBlocks}` : ''}

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;
              font-size:10px;color:#94a3b8;display:flex;justify-content:space-between">
    <span>AppCloud · Compliance Platform</span>
    <span>${esc(framework.id)} · ${ts.slice(0,10)}</span>
  </div>
</body>
</html>`

    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Disposition',
        `inline; filename="appcloud-${framework.id}-${ts.slice(0,10)}.html"`)
      .send(html)
  })
}
