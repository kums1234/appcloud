// plugins/audit-cleanup.js
//
// Periodic retention job for audit_log. Removes rows older than
// APPCLOUD_AUDIT_RETENTION_DAYS (default 365) at a fixed cadence.
//
// Auto-detects whether audit_log is partitioned (postgres-native
// PARTITION BY RANGE — see utils/audit-partitioning.js) and chooses the
// right strategy:
//
//   partitioned → DETACH + DROP each partition whose upper bound is
//                 older than the cutoff. ~O(1) per partition; no row
//                 scan; no autovacuum churn.
//
//   regular     → batched CTE DELETE (the pre-partitioning fallback).
//                 Each batch is bounded by APPCLOUD_AUDIT_CLEANUP_BATCH_SIZE
//                 (default 10 000) so a long-overdue first pass on a big
//                 table doesn't hold one transaction across millions of rows.
//
// The two strategies share the same env-var contract — operators don't
// need to know which mode is active.
//
// Behaviour:
//   - On startup (after a short delay so the rest of the boot finishes),
//     run one cleanup pass.
//   - Then run on a fixed interval (APPCLOUD_AUDIT_CLEANUP_INTERVAL_MS,
//     default 24h).
//   - Each run also ensures next-month's partition exists (when
//     partitioned) so rows landing on a month boundary always have a
//     home.
//   - Setting APPCLOUD_AUDIT_RETENTION_DAYS=0 disables the job entirely
//     (default-safe for callers who explicitly want forever-retention).

import {
  detectAuditLogState,
  listExpiredPartitions,
  dropPartition,
  ensureCurrentAndNextPartitions,
} from '../utils/audit-partitioning.js'

const DAY_MS               = 24 * 60 * 60 * 1000
const DEFAULT_BATCH_SIZE   = 10_000
const DEFAULT_RETENTION    = 365                                   // days
const DEFAULT_INTERVAL_MS  = DAY_MS
const STARTUP_DELAY_MS     = 30_000                                // wait 30s before first run

export async function auditCleanupPlugin(fastify) {
  const retentionDays = parseInt(process.env.APPCLOUD_AUDIT_RETENTION_DAYS || String(DEFAULT_RETENTION), 10)
  const intervalMs    = parseInt(process.env.APPCLOUD_AUDIT_CLEANUP_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10)
  const batchSize     = parseInt(process.env.APPCLOUD_AUDIT_CLEANUP_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10)

  if (retentionDays <= 0) {
    fastify.log.info('[audit-cleanup] APPCLOUD_AUDIT_RETENTION_DAYS=0 — retention disabled, audit rows kept forever')
    fastify.decorate('auditCleanup', { runNow: async () => ({ skipped: 'retention=0' }) })
    return
  }

  if (!fastify.pg?.pool) {
    fastify.log.warn('[audit-cleanup] no Postgres pool — retention job inactive')
    fastify.decorate('auditCleanup', { runNow: async () => ({ skipped: 'no-pg' }) })
    return
  }

  // Run a single cleanup pass. Strategy depends on table shape:
  //   partitioned → drop expired partitions (fast, no row scan)
  //   regular     → batched CTE DELETE (pre-partitioning fallback)
  async function runCleanup() {
    const cutoff = new Date(Date.now() - retentionDays * DAY_MS)
    const startedAt = Date.now()

    let state
    try { state = await detectAuditLogState(fastify.pg.query) }
    catch (err) {
      fastify.log.error({ err: err.message }, '[audit-cleanup] state detection failed')
      return { error: err.message, durationMs: Date.now() - startedAt }
    }

    if (state === 'partitioned') {
      return runPartitionedCleanup(cutoff, startedAt)
    }
    return runRegularCleanup(cutoff, startedAt)
  }

  // Partitioned-table cleanup — DROP partitions whose upper bound is
  // older than the cutoff. Also ensures the current/next month
  // partitions exist so the next INSERT always has a home.
  async function runPartitionedCleanup(cutoff, startedAt) {
    let dropped = []
    try {
      // Roll the month boundary forward — this is cheap and the right
      // moment to do it (right before retention runs, when we'd notice
      // a missing partition anyway).
      await ensureCurrentAndNextPartitions(fastify.pg.query, fastify.log)
      const expired = await listExpiredPartitions(fastify.pg.query, cutoff)
      for (const p of expired) {
        try {
          await dropPartition(fastify.pg.query, fastify.log, p.name)
          dropped.push(p.name)
        } catch (err) {
          fastify.log.error({ partition: p.name, err: err.message },
            '[audit-cleanup] failed to drop partition (continuing)')
        }
      }
    } catch (err) {
      fastify.log.error({ err: err.message }, '[audit-cleanup] partitioned cleanup failed')
      return { error: err.message, mode: 'partitioned', dropped, durationMs: Date.now() - startedAt }
    }
    const result = {
      mode:         'partitioned',
      cutoff:       cutoff.toISOString(),
      retentionDays,
      dropped,
      durationMs:   Date.now() - startedAt,
    }
    if (dropped.length > 0) {
      fastify.log.info(result, '[audit-cleanup] dropped expired partitions')
    }
    return result
  }

  // Regular-table cleanup — batched CTE DELETE. Each batch is bounded
  // (LIMIT $batchSize) so a long-overdue first pass on a big table
  // doesn't hold a single transaction across millions of rows.
  async function runRegularCleanup(cutoff, startedAt) {
    let totalDeleted = 0
    while (true) {
      let deleted
      try {
        const rows = await fastify.pg.query(`
          WITH old AS (
            SELECT id FROM audit_log
            WHERE created_at < $1
            ORDER BY created_at ASC
            LIMIT $2
          )
          DELETE FROM audit_log a USING old WHERE a.id = old.id
          RETURNING a.id
        `, [cutoff, batchSize])
        deleted = rows.length
      } catch (err) {
        fastify.log.error({ err: err.message }, '[audit-cleanup] DELETE failed')
        return { error: err.message, mode: 'regular', totalDeleted, durationMs: Date.now() - startedAt }
      }
      totalDeleted += deleted
      if (deleted < batchSize) break                  // last batch was short → done
    }
    const result = {
      mode:         'regular',
      cutoff:       cutoff.toISOString(),
      retentionDays,
      totalDeleted,
      durationMs:   Date.now() - startedAt,
    }
    if (totalDeleted > 0) {
      fastify.log.info(result, '[audit-cleanup] removed expired audit rows')
    }
    return result
  }

  // Decorate fastify so an admin endpoint or a test can fire a run on
  // demand. Useful for the integration test below — and could become a
  // POST /admin/audit-cleanup/run later if operators want push-button
  // retention.
  fastify.decorate('auditCleanup', {
    runNow:        runCleanup,
    retentionDays,
    intervalMs,
    batchSize,
  })

  // Stagger the first run so it doesn't fight startup work. Then a
  // fixed-interval timer drives subsequent runs.
  const startupTimer = setTimeout(() => {
    runCleanup().catch(err =>
      fastify.log.warn({ err: err.message }, '[audit-cleanup] startup pass failed'),
    )
  }, STARTUP_DELAY_MS)
  startupTimer.unref?.()

  const intervalTimer = setInterval(() => {
    runCleanup().catch(err =>
      fastify.log.warn({ err: err.message }, '[audit-cleanup] periodic pass failed'),
    )
  }, intervalMs)
  intervalTimer.unref?.()

  fastify.addHook('onClose', async () => {
    clearTimeout(startupTimer)
    clearInterval(intervalTimer)
  })

  fastify.log.info(
    `[audit-cleanup] retention=${retentionDays}d, interval=${Math.round(intervalMs / 1000)}s, ` +
    `batch=${batchSize} — first run in ${Math.round(STARTUP_DELAY_MS / 1000)}s`,
  )
}
