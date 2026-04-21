// api/src/compliance/evaluator.js
// Compliance control evaluation engine.
//
// Authoritative source for framework/control definitions is Postgres
// (tables: benchmarks, controls, control_overrides). Built-in definitions
// are seeded from JSON files on the API image at startup by seeder.js.
//
// Controls are evaluated against Neo4j. Each control's Cypher query must
// return one row per FAILING resource; no rows means the control passes.
// A query error (e.g. a label that doesn't exist yet) is classified as
// NOT_APPLICABLE so the UI can say "no data" rather than false-fail.

import { randomUUID } from 'crypto'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { serialize } from '../utils/serialize.js'
import { compileFormRule } from './form-evaluator.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRAMEWORKS_DIR = join(__dirname, 'frameworks')

// ── Fallback: JSON file loader ──────────────────────────────────────────────
// Only used if Postgres is unavailable. Keeps the UI functional in degraded
// mode (read-only; overrides ignored).

function loadFrameworksFromFiles(log) {
  const frameworks = []
  try {
    for (const file of readdirSync(FRAMEWORKS_DIR)) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = readFileSync(join(FRAMEWORKS_DIR, file), 'utf8')
        const fw = JSON.parse(raw)
        if (fw.id && Array.isArray(fw.controls)) frameworks.push(fw)
      } catch (err) {
        log?.warn?.(`[compliance] Failed to load ${file}: ${err.message}`)
      }
    }
  } catch (err) {
    log?.warn?.(`[compliance] Framework directory unavailable: ${err.message}`)
  }
  return frameworks
}

// ── Postgres row → framework / control objects ──────────────────────────────

function rowToControl(row) {
  return {
    id: row.id,
    benchmarkId: row.benchmark_id,
    section: row.section,
    sectionTitle: row.section_title,
    level: row.level,
    title: row.title,
    description: row.description,
    rationale: row.rationale,
    severity: row.severity,
    rating: row.rating,
    automated: row.automated,
    evaluator: row.evaluator,
    resourceType: row.resource_type,
    query: row.query,
    params: row.params || {},
    formRule: row.form_rule || null,
    remediation: row.remediation || {},
    source: row.source,
    enabled: row.enabled,
    // Override fields — merged in by loadFramework if an override row exists.
    _override: null,
  }
}

function applyOverride(control, override) {
  if (!override) return control
  const merged = { ...control, _override: override }
  if (override.disabled) merged.enabled = false
  if (override.severity)   merged.severity = override.severity
  if (override.rating != null) merged.rating = override.rating
  if (override.remediation) merged.remediation = override.remediation
  return merged
}

// ── Framework loaders (Postgres-first, file fallback) ───────────────────────

export async function loadFrameworks(pg, log) {
  if (!pg?.pool) {
    log?.warn?.('[compliance] Postgres unavailable — falling back to on-disk JSON')
    return loadFrameworksFromFiles(log)
  }
  try {
    const benchRows = await pg.query(
      `SELECT * FROM benchmarks WHERE enabled = true ORDER BY name`
    )
    if (!benchRows.length) {
      log?.info?.('[compliance] No benchmarks in Postgres — falling back to JSON (seeder may not have run yet)')
      return loadFrameworksFromFiles(log)
    }

    const ctrlRows = await pg.query(
      `SELECT c.*, o.disabled AS override_disabled,
              o.severity AS override_severity, o.rating AS override_rating,
              o.remediation AS override_remediation, o.note AS override_note
         FROM controls c
         LEFT JOIN control_overrides o
           ON o.benchmark_id = c.benchmark_id AND o.control_id = c.id
        WHERE c.enabled = true
        ORDER BY c.benchmark_id, c.section, c.id`
    )

    const byBenchmark = new Map()
    for (const row of ctrlRows) {
      const control = rowToControl(row)
      const override = (row.override_disabled != null || row.override_severity
        || row.override_rating != null || row.override_remediation)
        ? {
          disabled: Boolean(row.override_disabled),
          severity: row.override_severity,
          rating: row.override_rating,
          remediation: row.override_remediation,
          note: row.override_note,
        }
        : null
      const merged = applyOverride(control, override)
      if (!byBenchmark.has(row.benchmark_id)) byBenchmark.set(row.benchmark_id, [])
      byBenchmark.get(row.benchmark_id).push(merged)
    }

    return benchRows.map(b => ({
      id: b.id,
      name: b.name,
      version: b.version,
      provider: b.provider,
      description: b.description,
      reference: b.reference,
      source: b.source,
      enabled: b.enabled,
      controls: byBenchmark.get(b.id) || [],
    }))
  } catch (err) {
    log?.error?.(`[compliance] Postgres read failed: ${err.message} — falling back to JSON`)
    return loadFrameworksFromFiles(log)
  }
}

export async function getFramework(pg, id, log) {
  const all = await loadFrameworks(pg, log)
  return all.find(f => f.id === id) || null
}

export async function getControl(pg, frameworkId, controlId, log) {
  const fw = await getFramework(pg, frameworkId, log)
  if (!fw) return null
  return fw.controls.find(c => c.id === controlId) || null
}

// ── Control evaluation ──────────────────────────────────────────────────────

async function evaluateControl(query, control) {
  if (control.enabled === false) {
    return {
      controlId: control.id,
      status: 'DISABLED',
      failCount: 0,
      violations: [],
      error: null,
    }
  }

  if (control.automated === false) {
    return {
      controlId: control.id,
      status: 'MANUAL',
      failCount: 0,
      violations: [],
      error: null,
    }
  }

  // Resolve the query + params to run against Neo4j. Built-in and imported
  // controls use `evaluator='cypher'` with a hand-written query. Custom
  // controls defined through the UI form builder use `evaluator='form'` and
  // we compile their structured form rule into safe parameterised Cypher here.
  let effectiveQuery = null
  let effectiveParams = control.params || {}

  if (control.evaluator === 'form') {
    if (!control.formRule) {
      return {
        controlId: control.id,
        status: 'NOT_APPLICABLE',
        failCount: 0,
        violations: [],
        error: 'Form-evaluator control is missing formRule',
      }
    }
    const compiled = compileFormRule(control.formRule)
    if (compiled.error) {
      return {
        controlId: control.id,
        status: 'NOT_APPLICABLE',
        failCount: 0,
        violations: [],
        error: `Form rule invalid: ${compiled.error}`,
      }
    }
    effectiveQuery = compiled.query
    effectiveParams = compiled.params
  } else if (!control.evaluator || control.evaluator === 'cypher') {
    if (!control.query) {
      return {
        controlId: control.id,
        status: 'NOT_APPLICABLE',
        failCount: 0,
        violations: [],
        error: 'No Cypher query defined',
      }
    }
    effectiveQuery = control.query
  } else {
    return {
      controlId: control.id,
      status: 'NOT_APPLICABLE',
      failCount: 0,
      violations: [],
      error: `Evaluator type "${control.evaluator}" not yet supported`,
    }
  }

  try {
    const records = await query(effectiveQuery, effectiveParams)
    const violations = records.map(r => {
      const resourceId = r.keys?.includes('resourceId')
        ? serialize(r.get('resourceId')) : null
      const resourceName = r.keys?.includes('resourceName')
        ? serialize(r.get('resourceName')) : null
      const resourceType = r.keys?.includes('resourceType')
        ? serialize(r.get('resourceType')) : null
      const evidence = r.keys?.includes('evidence')
        ? serialize(r.get('evidence')) : null
      return { resourceId, resourceName, resourceType, evidence }
    })

    return {
      controlId: control.id,
      status: violations.length === 0 ? 'PASS' : 'FAIL',
      failCount: violations.length,
      violations,
      error: null,
    }
  } catch (err) {
    return {
      controlId: control.id,
      status: 'NOT_APPLICABLE',
      failCount: 0,
      violations: [],
      error: err.message,
    }
  }
}

// ── Framework evaluation ────────────────────────────────────────────────────

export async function evaluateFramework(query, framework) {
  if (!framework) throw new Error('framework is required')
  const runId = randomUUID()
  const startedAt = new Date().toISOString()

  const results = await Promise.all(
    framework.controls.map(c => evaluateControl(query, c))
  )

  const counts = { PASS: 0, FAIL: 0, NOT_APPLICABLE: 0, MANUAL: 0, DISABLED: 0 }
  const severityBreakdown = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1
    if (r.status === 'FAIL') {
      const ctrl = framework.controls.find(c => c.id === r.controlId)
      const sev = ctrl?.severity || 'MEDIUM'
      severityBreakdown[sev] = (severityBreakdown[sev] || 0) + 1
    }
  }

  const automated = counts.PASS + counts.FAIL
  const total = framework.controls.length - counts.DISABLED
  const score = automated > 0 ? Math.round((counts.PASS / automated) * 100) : 0
  const coverage = total > 0 ? Math.round((automated / total) * 100) : 0

  return {
    runId,
    frameworkId: framework.id,
    startedAt,
    completedAt: new Date().toISOString(),
    total,
    counts,
    severityBreakdown,
    score,
    coverage,
    controls: framework.controls.map(c => {
      const result = results.find(r => r.controlId === c.id)
      return {
        id: c.id,
        section: c.section,
        sectionTitle: c.sectionTitle,
        title: c.title,
        description: c.description,
        rationale: c.rationale,
        severity: c.severity,
        rating: c.rating,
        level: c.level,
        automated: c.automated !== false,
        resourceType: c.resourceType,
        remediation: c.remediation,
        source: c.source,
        override: c._override || null,
        status: result.status,
        failCount: result.failCount,
        violations: result.violations,
        error: result.error,
      }
    }),
  }
}
