// api/src/routes/integrations.management.js
//
// CRUD for rows in the `integrations` table driven by the connector registry.
// Peers with two existing route files under /integrations:
//   · routes/integrations.js         (/integrations/terraform/import, /history)
//   · routes/integrations-cloud.js   (/integrations/cloud/*)
//
// Path ordering: Fastify's find-my-way prefers static segments over :id, so
// the pre-existing /terraform/* and /cloud/* routes keep winning matches
// against /integrations/:id. We validate :id as a UUID as a second line of
// defence in case new static siblings land later.

import { encryptConfig, decryptConfig } from '../utils/encrypt.js'
import { serializeSpec } from '../connectors/index.js'
import { validateRequired, ConnectorError } from '../connectors/base.js'
import { actorFromReq } from '../utils/audit.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requirePg(fastify, reply) {
  if (!fastify.pg?.pool) {
    reply.serviceUnavailable('Database not available — check Postgres connection')
    return false
  }
  return true
}

function redact(row) {
  if (!row) return row
  return { ...row, config: decryptConfig(row.config || {}) }
}

export default async function integrationManagementRoutes(fastify) {
  const audit = (...a) => fastify.pg.audit(...a).catch(() => {})
  const actor = actorFromReq

  // ── GET /integrations ───────────────────────────────────────────────────────
  // List all configured connector instances. Secrets are decrypted so the UI
  // can show field values (the UI is responsible for obscuring them further).
  fastify.get('/', {
    schema: {
      summary:     'List configured connector instances',
      description: 'Returns every row from the `integrations` table — ServiceNow, Terraform Cloud, OTel ingest, IaC state backends, etc. Secret fields are decrypted; client UIs are responsible for further obscuring.',
      response:    { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async () => {
    if (!fastify.pg?.pool) return []
    const rows = await fastify.pg.query(`
      SELECT id, type, name, enabled, config, poll_interval_seconds,
             last_sync_at, last_sync_status, last_sync_error,
             created_at, updated_at
        FROM integrations
        ORDER BY type, name
    `)
    return rows.map(redact)
  })

  // ── GET /integrations/:id ───────────────────────────────────────────────────
  fastify.get('/:id', {
    schema: {
      summary:     'Get one connector instance',
      description: 'Returns the integration row with config decrypted. Use `/connectors/:type` for the connector\'s schema and capabilities.',
      params:      { type: 'object', properties: { id: { type: 'string', pattern: UUID_RE.source } } },
      response:    { 200: { type: 'object', additionalProperties: true }, 404: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!requirePg(fastify, reply)) return
    const rows = await fastify.pg.query(
      `SELECT id, type, name, enabled, config, poll_interval_seconds,
              last_sync_at, last_sync_status, last_sync_error,
              created_at, updated_at
         FROM integrations WHERE id = $1`,
      [req.params.id],
    )
    if (!rows.length) return reply.notFound('Integration not found')
    return redact(rows[0])
  })

  // ── POST /integrations ──────────────────────────────────────────────────────
  // Create a new integration instance of a known connector type.
  // Body: { type, name, config, enabled?, pollIntervalSeconds? }
  fastify.post('/', {
    schema: {
      summary:     'Create a connector instance',
      description: 'Body shape: `{ type, name, config, enabled?, pollIntervalSeconds? }`. The `type` must match a registered connector (`/connectors`); the connector\'s `beforeUpsert` runs before validation to fill defaults / auto-generate secrets, and `afterUpsert` runs after persist to sync derived rows. Secret fields are AES-256-GCM-encrypted before INSERT.',
      body: { type: 'object', required: ['type', 'name'], additionalProperties: true, properties: {
        type:                { type: 'string', description: 'Connector id (e.g. servicenow, terraform-cloud, otel-ingest)' },
        name:                { type: 'string' },
        config:              { type: 'object', additionalProperties: true },
        enabled:             { type: 'boolean', default: true },
        pollIntervalSeconds: { type: ['integer', 'null'] },
      } },
      response: { 201: { type: 'object', additionalProperties: true }, 400: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!requirePg(fastify, reply)) return

    const { type, name, config = {}, enabled = true, pollIntervalSeconds = null } = req.body || {}
    if (!type || !name) return reply.badRequest('type and name are required')

    const spec = fastify.connectors.get(type)
    if (!spec) return reply.badRequest(`unknown connector type: ${type}`)

    const hookCtx = { log: fastify.log, pg: fastify.pg, neo4j: fastify.neo4j }

    // beforeUpsert — let the connector fill defaults / auto-generate secrets
    // before validation runs.
    let effective = { ...config }
    if (typeof spec.beforeUpsert === 'function') {
      try {
        effective = (await spec.beforeUpsert(effective, hookCtx)) || effective
      } catch (err) {
        fastify.log.error(`[Integrations] beforeUpsert failed for ${type}: ${err.message}`)
        return reply.internalServerError(`beforeUpsert: ${err.message}`)
      }
    }

    // Validate (after defaults filled)
    const authErrors   = validateRequired(spec.authSchema,   effective)
    const configErrors = validateRequired(spec.configSchema, effective)
    const errs = [...authErrors, ...configErrors]
    if (errs.length) return reply.badRequest(errs.join('; '))

    let row
    try {
      const encrypted = encryptConfig({ ...effective })
      const rows = await fastify.pg.query(
        `INSERT INTO integrations (type, name, config, enabled, poll_interval_seconds)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (type, name) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = EXCLUDED.enabled,
               poll_interval_seconds = EXCLUDED.poll_interval_seconds,
               updated_at = now()
         RETURNING id, type, name, enabled, config, poll_interval_seconds,
                   created_at, updated_at`,
        [type, name, JSON.stringify(encrypted), !!enabled, pollIntervalSeconds],
      )
      row = rows[0]
      audit(actor(req), 'create', 'Integration', row.id, `${type}:${name}`, { type })
    } catch (err) {
      fastify.log.error(`[Integrations] POST error: ${err.message}`)
      return reply.internalServerError(`Failed to save integration: ${err.message}`)
    }

    // afterUpsert — sync derived rows. Runs with the decrypted effective
    // config so the connector doesn't need to re-decrypt.
    if (typeof spec.afterUpsert === 'function') {
      try {
        await spec.afterUpsert(
          { ...row, config: effective },
          { ...hookCtx, integrationId: row.id },
        )
      } catch (err) {
        fastify.log.warn(`[Integrations] afterUpsert warning for ${type}/${name}: ${err.message}`)
        // Not fatal — the integration row itself is persisted.
      }
    }

    reply.code(201)
    return redact(row)
  })

  // ── PATCH /integrations/:id ─────────────────────────────────────────────────
  fastify.patch('/:id', {
    schema: {
      summary:     'Update a connector instance (partial)',
      description: 'Patches `config` (merged + re-encrypted), `enabled`, or `pollIntervalSeconds`. The connector\'s before/afterUpsert hooks run on each update.',
      params:      { type: 'object', properties: { id: { type: 'string', pattern: UUID_RE.source } } },
      body:        { type: 'object', additionalProperties: true, properties: {
        config:              { type: 'object', additionalProperties: true },
        enabled:             { type: 'boolean' },
        pollIntervalSeconds: { type: ['integer', 'null'] },
      } },
      response:    { 200: { type: 'object', additionalProperties: true }, 404: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!requirePg(fastify, reply)) return

    const { config, enabled, pollIntervalSeconds } = req.body || {}

    // Look up the connector first (we may need beforeUpsert)
    const existing = await fastify.pg.query(
      `SELECT type FROM integrations WHERE id = $1`,
      [req.params.id],
    )
    if (!existing.length) return reply.notFound('Integration not found')
    const spec = fastify.connectors.get(existing[0].type)
    const hookCtx = { log: fastify.log, pg: fastify.pg, neo4j: fastify.neo4j }

    let effective = config !== undefined ? { ...config } : undefined
    if (effective && spec && typeof spec.beforeUpsert === 'function') {
      try {
        effective = (await spec.beforeUpsert(effective, hookCtx)) || effective
      } catch (err) {
        return reply.internalServerError(`beforeUpsert: ${err.message}`)
      }
    }

    const fields = []
    const values = []
    let i = 1

    if (effective !== undefined) {
      fields.push(`config = $${i++}`)
      values.push(JSON.stringify(encryptConfig({ ...effective })))
    }
    if (enabled !== undefined) {
      fields.push(`enabled = $${i++}`)
      values.push(!!enabled)
    }
    if (pollIntervalSeconds !== undefined) {
      fields.push(`poll_interval_seconds = $${i++}`)
      values.push(pollIntervalSeconds)
    }
    if (!fields.length) return reply.badRequest('no updatable fields in body')

    fields.push(`updated_at = now()`)
    values.push(req.params.id)

    const rows = await fastify.pg.query(
      `UPDATE integrations SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, type, name, enabled, config, poll_interval_seconds,
                 last_sync_at, last_sync_status, last_sync_error,
                 created_at, updated_at`,
      values,
    )
    if (!rows.length) return reply.notFound('Integration not found')
    audit(actor(req), 'update', 'Integration', rows[0].id, `${rows[0].type}:${rows[0].name}`, {})

    if (spec && typeof spec.afterUpsert === 'function') {
      try {
        await spec.afterUpsert(
          { ...rows[0], config: effective ?? decryptConfig(rows[0].config || {}) },
          { ...hookCtx, integrationId: rows[0].id },
        )
      } catch (err) {
        fastify.log.warn(`[Integrations] afterUpsert warning for ${rows[0].type}: ${err.message}`)
      }
    }

    return redact(rows[0])
  })

  // ── DELETE /integrations/:id ────────────────────────────────────────────────
  fastify.delete('/:id', {
    schema: {
      summary:     'Delete a connector instance',
      description: 'Removes the row. Resources the connector previously ingested into Neo4j stay; the next discovery sweep / cleanupStaleNodes will mark them stale.',
      params:      { type: 'object', properties: { id: { type: 'string', pattern: UUID_RE.source } } },
      response:    { 204: { type: 'null' }, 404: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!requirePg(fastify, reply)) return
    const rows = await fastify.pg.query(
      `DELETE FROM integrations WHERE id = $1 RETURNING id, type, name`,
      [req.params.id],
    )
    if (!rows.length) return reply.notFound('Integration not found')
    audit(actor(req), 'delete', 'Integration', rows[0].id, `${rows[0].type}:${rows[0].name}`, {})
    reply.code(204).send()
  })

  // ── POST /integrations/:id/test ─────────────────────────────────────────────
  // Invoke the connector's healthCheck() with decrypted config.
  fastify.post('/:id/test', {
    schema: {
      summary:     'Test a connector\'s healthCheck',
      description: 'Invokes `spec.healthCheck()` against the live integration. Returns `{ ok, detail }`. Cheap — does not ingest anything.',
      params:      { type: 'object', properties: { id: { type: 'string', pattern: UUID_RE.source } } },
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!requirePg(fastify, reply)) return
    const rows = await fastify.pg.query(
      `SELECT id, type, name, config FROM integrations WHERE id = $1`,
      [req.params.id],
    )
    if (!rows.length) return reply.notFound('Integration not found')

    const row  = rows[0]
    const spec = fastify.connectors.get(row.type)
    if (!spec) return reply.badRequest(`connector not registered: ${row.type}`)
    if (typeof spec.healthCheck !== 'function') return { ok: true, detail: 'no healthCheck defined' }

    try {
      const result = await spec.healthCheck(decryptConfig(row.config || {}), {
        log: fastify.log, pg: fastify.pg, neo4j: fastify.neo4j, integrationId: row.id,
      })
      return result || { ok: true }
    } catch (err) {
      return { ok: false, detail: err.message }
    }
  })

  // ── POST /integrations/:id/scan ─────────────────────────────────────────────
  // Trigger a one-off fetch → normalize → ingest pass. Records a sync_jobs row.
  fastify.post('/:id/scan', {
    schema: {
      summary:     'Trigger a one-off ingest pass',
      description: 'Runs `fetch → normalize → ingest` for the connector and records a `sync_jobs` row with the outcome. Returns the result envelope (resourcesFound / created / updated / warnings).',
      params:      { type: 'object', properties: { id: { type: 'string', pattern: UUID_RE.source } } },
      response:    { 200: { type: 'object', additionalProperties: true }, 500: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!requirePg(fastify, reply)) return

    const rows = await fastify.pg.query(
      `SELECT id, type, name, config FROM integrations WHERE id = $1`,
      [req.params.id],
    )
    if (!rows.length) return reply.notFound('Integration not found')
    const row = rows[0]
    const decryptedConfig = decryptConfig(row.config || {})

    const [job] = await fastify.pg.query(
      `INSERT INTO sync_jobs (integration_id, integration_type, status, triggered_by)
       VALUES ($1, $2, 'running', 'manual') RETURNING id, started_at`,
      [row.id, row.type],
    )

    try {
      await fastify.pg.query(
        `UPDATE integrations SET last_sync_status = 'running', last_sync_at = now() WHERE id = $1`,
        [row.id],
      )
      const result = await fastify.connectors.run(
        { ...row, config: decryptedConfig },
      )
      const hasErrors = (result.warnings || []).length > 0
      const status    = hasErrors ? 'partial' : 'success'

      await fastify.pg.query(
        `UPDATE sync_jobs
            SET status = $1, finished_at = now(),
                duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000,
                resources_found   = $2,
                resources_created = $3,
                resources_updated = $4,
                summary           = $5
          WHERE id = $6`,
        [status, result.resourcesFound, result.resourcesCreated,
         result.resourcesUpdated, JSON.stringify(result), job.id],
      )
      await fastify.pg.query(
        `UPDATE integrations SET last_sync_status = $1, last_sync_error = NULL WHERE id = $2`,
        [status, row.id],
      )
      audit(actor(req), 'scan', 'Integration', row.id, `${row.type}:${row.name}`, result)

      // Tell the CMDB assessment scheduler a fresh scan has landed so it
      // picks up the new :CmdbCi / :Infra nodes on its next tick. No-op if
      // the plugin isn't decorated.
      fastify.cmdbAssessment?.markDirty?.().catch(() => {})

      return { jobId: job.id, ...result }
    } catch (err) {
      const msg = err instanceof ConnectorError ? err.message : `scan failed: ${err.message}`
      fastify.log.error(msg)
      await fastify.pg.query(
        `UPDATE sync_jobs SET status = 'error', finished_at = now(),
                              duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000,
                              error_message = $1
          WHERE id = $2`,
        [msg, job.id],
      ).catch(() => {})
      await fastify.pg.query(
        `UPDATE integrations SET last_sync_status = 'error', last_sync_error = $1 WHERE id = $2`,
        [msg, row.id],
      ).catch(() => {})
      return reply.internalServerError(msg)
    }
  })

  // ── GET /integrations/:id/history ───────────────────────────────────────────
  fastify.get('/:id/history', {
    schema: {
      summary:     'Connector instance sync history',
      description: 'Returns up to 50 of the most recent `sync_jobs` rows for this integration with status, durations, and per-status counts. Use this to debug why an ingest didn\'t produce the expected nodes.',
      params:      { type: 'object', properties: { id: { type: 'string', pattern: UUID_RE.source } } },
      response:    { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req, reply) => {
    if (!requirePg(fastify, reply)) return
    const rows = await fastify.pg.query(
      `SELECT id, status, triggered_by, started_at, finished_at, duration_ms,
              resources_found, resources_created, resources_updated,
              error_message, summary
         FROM sync_jobs
        WHERE integration_id = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [req.params.id],
    )
    return rows
  })
}

// ── Connector-registry endpoint ────────────────────────────────────────────────
// Registered at /connectors (separate prefix) from server.js.
export async function connectorsRegistryRoutes(fastify) {
  fastify.get('/', {
    schema: {
      summary:     'List available connectors (registry)',
      description: 'Returns every connector registered with the framework — ServiceNow, Terraform Cloud, OTel ingest, IaC state backends. Each entry includes its `authSchema`, `configSchema`, and UI metadata. Use this to render dynamic connector-creation forms.',
      response:    { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async () => fastify.connectors.list().map(serializeSpec))

  fastify.get('/:id', {
    schema: {
      summary:     'Get one connector\'s schema',
      description: 'Returns the full spec for one connector — `id`, `displayName`, `description`, JSON schemas for auth + config, UI metadata, capabilities. Used by the connector-creation UI to drive a form.',
      params:      { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response:    { 200: { type: 'object', additionalProperties: true }, 404: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const spec = fastify.connectors.get(req.params.id)
    if (!spec) return reply.notFound('Unknown connector')
    return serializeSpec(spec)
  })
}
