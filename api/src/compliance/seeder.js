// api/src/compliance/seeder.js
// Seeds the benchmarks + controls tables from the JSON files shipped with the
// API image. Called on API startup (onReady hook) and on-demand via the
// POST /compliance/frameworks/reseed-builtins endpoint.
//
// Seed rules:
//   - Benchmark rows matching a JSON file are UPSERT'd with source='builtin'.
//   - Controls within those benchmarks are UPSERT'd by (benchmark_id, id),
//     overwriting every field except source (forced to 'builtin') and
//     preserving any existing custom rows.
//   - Controls present in DB with source='builtin' but missing from the
//     current JSON are soft-deleted (enabled=false) so historical references
//     remain valid.
//   - Custom controls (source='custom') and all control_overrides are never
//     touched by the seeder.

import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRAMEWORKS_DIR = join(__dirname, 'frameworks')

function readFrameworkFiles(log) {
  const frameworks = []
  let files = []
  try {
    files = readdirSync(FRAMEWORKS_DIR).filter(f => f.endsWith('.json'))
  } catch (err) {
    log?.warn?.(`[compliance/seeder] Framework directory unavailable: ${err.message}`)
    return frameworks
  }
  for (const file of files) {
    try {
      const raw = readFileSync(join(FRAMEWORKS_DIR, file), 'utf8')
      const fw = JSON.parse(raw)
      if (!fw.id || !Array.isArray(fw.controls)) {
        log?.warn?.(`[compliance/seeder] ${file}: missing id or controls[], skipping`)
        continue
      }
      frameworks.push({ file, framework: fw })
    } catch (err) {
      log?.warn?.(`[compliance/seeder] Failed to parse ${file}: ${err.message}`)
    }
  }
  return frameworks
}

// Upsert a benchmark + all of its controls in a single transaction.
// Returns { benchmarkId, inserted, updated, softDeleted }.
async function seedFramework(pool, framework, log) {
  const client = await pool.connect()
  const stats = { benchmarkId: framework.id, inserted: 0, updated: 0, softDeleted: 0 }

  try {
    await client.query('BEGIN')

    // Benchmark
    const benchRes = await client.query(
      `INSERT INTO benchmarks (id, name, version, provider, description, reference, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'builtin')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         version = EXCLUDED.version,
         provider = EXCLUDED.provider,
         description = EXCLUDED.description,
         reference = EXCLUDED.reference,
         source = 'builtin',
         enabled = true,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        framework.id,
        framework.name || framework.id,
        framework.version || '1.0',
        framework.provider || 'other',
        framework.description || null,
        framework.reference || null,
      ]
    )
    // xmax=0 on RETURNING means INSERT (not UPDATE)
    if (benchRes.rows[0]?.inserted) stats.inserted++
    else stats.updated++

    // Controls — collect IDs we're about to upsert so we can soft-delete the rest
    const controlIdsFromJson = new Set()

    for (const ctrl of framework.controls) {
      if (!ctrl.id) continue
      controlIdsFromJson.add(ctrl.id)

      const upsert = await client.query(
        `INSERT INTO controls (
           id, benchmark_id, section, section_title, level, title, description,
           rationale, severity, rating, automated, evaluator, resource_type,
           query, params, form_rule, remediation, source, enabled
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, 'builtin', true)
         ON CONFLICT (benchmark_id, id) DO UPDATE SET
           section       = EXCLUDED.section,
           section_title = EXCLUDED.section_title,
           level         = EXCLUDED.level,
           title         = EXCLUDED.title,
           description   = EXCLUDED.description,
           rationale     = EXCLUDED.rationale,
           severity      = EXCLUDED.severity,
           rating        = EXCLUDED.rating,
           automated     = EXCLUDED.automated,
           evaluator     = EXCLUDED.evaluator,
           resource_type = EXCLUDED.resource_type,
           query         = EXCLUDED.query,
           params        = EXCLUDED.params,
           form_rule     = EXCLUDED.form_rule,
           remediation   = EXCLUDED.remediation,
           source        = 'builtin',
           enabled       = true,
           updated_at    = now()
         WHERE controls.source IN ('builtin')
         RETURNING (xmax = 0) AS inserted`,
        [
          ctrl.id,
          framework.id,
          ctrl.section || null,
          ctrl.sectionTitle || null,
          ctrl.level ?? null,
          ctrl.title || ctrl.id,
          ctrl.description || null,
          ctrl.rationale || null,
          ctrl.severity || 'MEDIUM',
          ctrl.rating ?? null,
          ctrl.automated !== false,
          ctrl.evaluator || 'cypher',
          ctrl.resourceType || null,
          ctrl.query || null,
          JSON.stringify(ctrl.params || {}),
          ctrl.formRule ? JSON.stringify(ctrl.formRule) : null,
          JSON.stringify(ctrl.remediation || {}),
        ]
      )
      if (upsert.rows.length === 0) {
        // The WHERE clause blocked the update (non-builtin control with same id) — skip.
        continue
      }
      if (upsert.rows[0]?.inserted) stats.inserted++
      else stats.updated++
    }

    // Soft-delete builtin controls that were removed from the JSON
    if (controlIdsFromJson.size > 0) {
      const softDelete = await client.query(
        `UPDATE controls
           SET enabled = false, updated_at = now()
         WHERE benchmark_id = $1
           AND source = 'builtin'
           AND id != ALL($2::text[])
           AND enabled = true
         RETURNING id`,
        [framework.id, [...controlIdsFromJson]]
      )
      stats.softDeleted = softDelete.rowCount
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  return stats
}

/**
 * Run the full seed process.
 *
 * @param {object} pg  fastify.pg decorator ({ pool, query, audit })
 * @param {object} log fastify.log-compatible logger
 * @returns {object}   { frameworks: [stats, ...], error? }
 */
export async function seedBuiltinFrameworks(pg, log) {
  if (!pg?.pool) {
    log?.warn?.('[compliance/seeder] Postgres not available, skipping seed')
    return { frameworks: [], error: 'postgres-unavailable' }
  }

  const files = readFrameworkFiles(log)
  if (files.length === 0) {
    log?.info?.('[compliance/seeder] No framework JSON files found')
    return { frameworks: [] }
  }

  const results = []
  for (const { file, framework } of files) {
    try {
      const stats = await seedFramework(pg.pool, framework, log)
      log?.info?.(
        `[compliance/seeder] ${framework.id} (${file}): ` +
        `${stats.inserted} inserted, ${stats.updated} updated, ${stats.softDeleted} soft-deleted`
      )
      results.push({ file, ...stats })
    } catch (err) {
      log?.error?.(`[compliance/seeder] ${framework.id} (${file}) failed: ${err.message}`)
      results.push({ file, benchmarkId: framework.id, error: err.message })
    }
  }

  return { frameworks: results }
}
