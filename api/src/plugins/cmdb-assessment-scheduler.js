// plugins/cmdb-assessment-scheduler.js
//
// Periodic worker. Each tick (CMDB_ASSESSMENT_INTERVAL_MS, default 60s):
//
//   1. Peek at cmdb_assessment_state.
//   2. Run an assessment when either
//        - state.dirty = true, OR
//        - now - last_run_at > CMDB_ASSESSMENT_BACKSTOP_MS (default 30min).
//   3. After a run: clear dirty, update last_run_at + last_episode_id,
//      append to cmdb_assessment_runs.
//
// Concurrency: a local re-entrancy guard skips a tick if the previous one
// is still mid-run. This is a single-process concern (each pod has its
// own worker); distributed locking would be a later concern if we ever
// horizontally scale the API.
//
// Exposes fastify.cmdbAssessment with { markDirty, runNow } so scanners
// (routes/discovery.js) can flip the dirty flag after a scan finishes
// without importing state-management SQL directly.

import { runAssessment } from '../services/cmdb-assessment/index.js'
import { makeOnceLock }  from '../utils/once-lock.js'
import { withLeaderLock, SCHEDULER_LOCK_KEYS } from '../utils/leader-lock.js'

const DEFAULT_INTERVAL_MS = 60_000           // 1 minute tick
const DEFAULT_BACKSTOP_MS = 30 * 60_000      // 30 minutes
const SCOPE = 'global'

export async function cmdbAssessmentSchedulerPlugin(fastify) {
  const intervalMs = parseInt(process.env.CMDB_ASSESSMENT_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10)
  const backstopMs = parseInt(process.env.CMDB_ASSESSMENT_BACKSTOP_MS || String(DEFAULT_BACKSTOP_MS), 10)

  // Promise-based lock — same fix the discovery scheduler got. The old
  // `running` flag raced across awaits.
  const runLock = makeOnceLock()
  let timer = null

  async function readState() {
    const rows = await fastify.pg.query(
      `SELECT dirty, dirty_since, last_run_at, last_episode_id
         FROM cmdb_assessment_state WHERE scope = $1 LIMIT 1`,
      [SCOPE],
    )
    return rows[0] || null
  }

  async function markDirty() {
    if (!fastify.pg?.pool) return
    await fastify.pg.query(
      `INSERT INTO cmdb_assessment_state (scope, dirty, dirty_since, updated_at)
       VALUES ($1, true, now(), now())
       ON CONFLICT (scope) DO UPDATE
         SET dirty = true,
             dirty_since = COALESCE(cmdb_assessment_state.dirty_since, now()),
             updated_at  = now()`,
      [SCOPE],
    ).catch(err => fastify.log.warn(`[CmdbAssess] markDirty failed: ${err.message}`))
  }

  async function clearDirty(episodeId) {
    await fastify.pg.query(
      `UPDATE cmdb_assessment_state
          SET dirty = false,
              dirty_since = null,
              last_run_at = now(),
              last_episode_id = $2,
              updated_at = now()
        WHERE scope = $1`,
      [SCOPE, episodeId],
    ).catch(err => fastify.log.warn(`[CmdbAssess] clearDirty failed: ${err.message}`))
  }

  async function recordRun(trigger, result, outcome, errorMsg) {
    try {
      await fastify.pg.query(
        `INSERT INTO cmdb_assessment_runs
           (episode_id, trigger, started_at, finished_at, duration_ms,
            cis_total, infra_total, matched_count, unmatched_count,
            outcome, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          result?.episodeId || null,
          trigger,
          result?.startedAt || new Date().toISOString(),
          result?.finishedAt || null,
          result?.durationMs ?? null,
          result?.cis ?? null,
          result?.infra ?? null,
          result?.matched ?? null,
          result?.unmatched ?? null,
          outcome,
          errorMsg || null,
        ],
      )
    } catch (err) {
      fastify.log.warn(`[CmdbAssess] recordRun failed: ${err.message}`)
    }
  }

  async function runOnce(trigger) {
    // Two-layer lock: outer Postgres advisory lock (one replica per
    // tick), inner promise lock (no overlap within a replica).
    const outer = await withLeaderLock(fastify.pg?.pool, SCHEDULER_LOCK_KEYS.cmdbAssessmentRun, async () => {
      return runLock.run(async () => {
        try {
          const result = await runAssessment({ neo4j: fastify.neo4j, log: fastify.log })
          await clearDirty(result.episodeId)
          await recordRun(trigger, result, 'ok')
          fastify.log.info(
            `[CmdbAssess] ${trigger}: ${result.matched}/${result.cis} matched, ${result.infra} Infra, ${result.durationMs}ms`,
          )
          return result
        } catch (err) {
          fastify.log.error(`[CmdbAssess] ${trigger} failed: ${err.message}`)
          await recordRun(trigger, null, 'error', err.message)
          return null
        }
      })
    })
    if (outer.skipped === 'leader-elsewhere') {
      fastify.log.info('[CmdbAssess] another replica holds the leader lock — skipping tick')
      return null
    }
    if (outer.skipped) return null
    if (outer.result?.skipped) {
      fastify.log.info('[CmdbAssess] previous run still in flight — skipping tick')
      return null
    }
    return outer.result?.result ?? null
  }

  async function tick() {
    if (!fastify.pg?.pool) return
    let state
    try { state = await readState() }
    catch (err) {
      fastify.log.warn(`[CmdbAssess] readState failed: ${err.message}`)
      return
    }
    if (!state) return

    const now = Date.now()
    const lastRunMs = state.last_run_at ? new Date(state.last_run_at).getTime() : 0
    const dueDirty   = state.dirty
    const dueBackstop = now - lastRunMs > backstopMs
    if (dueDirty)       return runOnce('dirty')
    if (dueBackstop)    return runOnce('backstop')
  }

  fastify.decorate('cmdbAssessment', {
    markDirty,
    runNow: (trigger = 'manual') => runOnce(trigger),
    readState,
  })

  fastify.addHook('onReady', async () => {
    if (!fastify.pg?.pool) {
      fastify.log.warn('[CmdbAssess] Postgres not available — scheduler disabled')
      return
    }
    fastify.log.info(`[CmdbAssess] scheduler started: tick=${intervalMs}ms, backstop=${backstopMs}ms`)
    // Fire first tick immediately so boot triggers an initial run if
    // dirty. Log the outcome — a silent .catch(() => {}) used to mean
    // a broken assessor only surfaced on the second tick when the skew
    // got noticed; now the startup result is in the structured logs.
    tick().then(
      r => fastify.log.info({ startupTick: r ? 'ran' : 'no-op' }, '[CmdbAssess] startup tick complete'),
      err => fastify.log.error({ err: err.message, code: err.code }, '[CmdbAssess] startup tick failed'),
    )
    timer = setInterval(() => {
      tick().catch(err =>
        fastify.log.warn({ err: err.message, code: err.code }, '[CmdbAssess] periodic tick failed'),
      )
    }, intervalMs)
  })

  fastify.addHook('onClose', async () => {
    if (timer) clearInterval(timer)
    timer = null
  })
}
