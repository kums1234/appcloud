// utils/leader-lock.js
//
// Postgres advisory-lock-based leader election for periodic background
// work (schedulers, aggregator ticks). Wraps a callback with
// `pg_try_advisory_lock(<key>)`; if the lock is taken by another process
// (typically another K8s replica), the callback is skipped.
//
// Why advisory locks: they cost nothing to take when free, are session-
// scoped (auto-released if the connection dies), and don't require a
// new table. The downside is they hold a pool connection for the
// duration of `fn()`. That's acceptable for our schedulers — they tick
// at minutes-to-hour intervals, so one connection tied up for the
// duration of a tick is a small fraction of pool capacity. If `fn()`
// is itself fast (a few seconds), the impact is negligible.
//
// Stable key choice: pick a per-scope BIGINT in the source so every
// caller agrees on the namespace. The constants live in this module so
// adding a new lock means adding to the SCHEDULER_LOCK_KEYS map below.
//
// Falls back to single-instance behaviour (just run) when no pool is
// available — stub mode in tests, or pre-Postgres-init startup race.

// Per-scope keys. Pick anything that fits in BIGINT; collisions across
// services on the same Postgres are unlikely at the chosen prefixes,
// but the namespace (decimal) is recorded next to each so a future
// migration to a different lock approach has the mapping.
export const SCHEDULER_LOCK_KEYS = Object.freeze({
  discoveryScan:        BigInt('0xDC509CA110000001'),  // discovery scan tick
  cmdbAssessmentRun:    BigInt('0xC1DB04559E550001'),  // cmdb assessment tick
})

// Run `fn()` while holding the advisory lock. Returns
//   { ok: true, result }                 on success
//   { skipped: 'leader-elsewhere' }      if another process holds the lock
//   { skipped: 'no-pool' }               if pool is null/undefined
// Throws whatever `fn()` throws.
export async function withLeaderLock(pool, lockKey, fn) {
  if (!pool) return { skipped: 'no-pool' }
  const client = await pool.connect()
  try {
    // pg_try_advisory_lock takes BIGINT and returns boolean. Pass the
    // BigInt directly; node-postgres serialises it.
    const r = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [lockKey.toString()],
    )
    if (!r.rows[0].locked) {
      return { skipped: 'leader-elsewhere' }
    }
    try {
      const result = await fn()
      return { ok: true, result }
    } finally {
      // Release on the same connection we took it on — pg_advisory_unlock
      // returns false if not held on the calling session, but we just
      // verified we hold it, so this is straight-line.
      try {
        await client.query(
          'SELECT pg_advisory_unlock($1::bigint)',
          [lockKey.toString()],
        )
      } catch {
        // If the unlock fails, the connection-end will clean up the
        // lock on the Postgres side. Don't mask the original `fn()`
        // result on the caller side.
      }
    }
  } finally {
    client.release()
  }
}
