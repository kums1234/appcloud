// plugins/audit-cleanup.js
//
// Periodic retention job for audit_log. Deletes rows older than
// APPCLOUD_AUDIT_RETENTION_DAYS (default 365) at a fixed cadence.
//
// Why DELETE rather than partitioning: pre-customer the row volume is low
// enough that a single DELETE per day is fine; partitioning is the right
// answer at scale (DETACH PARTITION is ~constant-time vs. row-by-row delete)
// but the schema migration to convert audit_log → partitioned table is its
// own slice. The two approaches don't conflict — when partitioning lands,
// this plugin's role becomes "drop old partitions" instead of "DELETE rows"
// and the env-var contract stays the same.
//
// Behaviour:
//   - On startup (after a short delay so the rest of the boot finishes),
//     run one cleanup pass.
//   - Then run on a fixed interval (APPCLOUD_AUDIT_CLEANUP_INTERVAL_MS,
//     default 24h).
//   - Configurable retention; setting APPCLOUD_AUDIT_RETENTION_DAYS=0
//     disables the job entirely (default-safe for callers who explicitly
//     want forever-retention).
//   - Batched DELETE so a long-overdue cleanup on a large table doesn't
//     hold a row lock on millions of rows in one go.
//
// Exported for symmetry with the other plugins; called once from server.js
// after the postgres + auth plugins are wired.

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

  // Run a single cleanup pass, deleting rows older than `cutoff` in batches
  // until no rows remain. Each DELETE is bounded (CTE + LIMIT) so a long-
  // overdue first pass on a big table doesn't hold a single transaction
  // open across millions of rows.
  async function runCleanup() {
    const cutoff = new Date(Date.now() - retentionDays * DAY_MS)
    let totalDeleted = 0
    const startedAt = Date.now()
    while (true) {
      let deleted
      try {
        // CTE-based batched DELETE — Postgres-idiomatic. The DELETE in the
        // outer query picks rows by id from the inner SELECT, so the lock
        // surface stays bounded to ≤ batchSize even on huge tables.
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
        return { error: err.message, totalDeleted, durationMs: Date.now() - startedAt }
      }
      totalDeleted += deleted
      if (deleted < batchSize) break                  // last batch was short → done
    }
    const result = {
      cutoff:      cutoff.toISOString(),
      retentionDays,
      totalDeleted,
      durationMs:  Date.now() - startedAt,
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
