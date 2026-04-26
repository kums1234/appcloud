// utils/audit-buffer.js
//
// Factory for the audit() decorator + retry-buffer machinery. Extracted
// so postgres.js (which owns the live pool) and the integration test
// (which has its own connected pg.Client from Testcontainers) can share
// the SAME algorithm — no copy-paste drift between prod and the test
// that's supposed to lock the algorithm.
//
// Buffer semantics:
//
//   - On INSERT failure, the row is queued in `pendingAudits` rather
//     than silently dropped (the previous behaviour, which lost rows
//     during exactly the outages an auditor would care about most).
//
//   - When the queue is non-empty OR a drain is in progress, NEW audits
//     also queue (FIFO) instead of racing the drain — order of original
//     audit() calls is preserved.
//
//   - Drains run sequentially under a `draining` flag so two concurrent
//     drains (e.g. periodic timer + post-success kick) can't double-
//     insert the head-of-queue row.
//
//   - Queue overflow evicts the OLDEST row + bumps `stats.dropped` so
//     a permanent outage doesn't OOM the process.

export const AUDIT_INSERT_SQL = `
  INSERT INTO audit_log(actor, actor_key_id, actor_scope, action, resource_type, resource_id, resource_name, metadata, diff)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`

// Build the (actor, action, …) parameter tuple from the polymorphic actor
// argument. Used by both the live INSERT path and the buffered-retry path.
export function buildAuditRow(actor, action, resourceType, resourceId, resourceName, metadata, diff) {
  let actorName, actorKeyId = null, actorScope = null
  if (typeof actor === 'string') {
    actorName = actor
  } else if (actor && typeof actor === 'object') {
    actorName  = actor.name  || 'system'
    actorKeyId = actor.keyId || null
    actorScope = actor.scope || null
  } else {
    actorName = 'system'
  }
  return [
    actorName, actorKeyId, actorScope,
    action, resourceType, resourceId, resourceName,
    JSON.stringify(metadata || {}),
    diff ? JSON.stringify(diff) : null,
  ]
}

// `runQuery(sql, params)` is the only thing we need from the underlying
// connection. Pass it in so this factory works against `pool.query`,
// `client.query`, or any test stub.
//
// `log?` is the fastify logger or any object with a .warn(...) method.
//
// Returns `{ audit, drain, pending, stats }` — a minimal interface that
// postgres.js wires onto fastify.pg and that the test can drive directly.
export function makeAuditMachinery({ runQuery, log, bufferMax = 1000 } = {}) {
  if (typeof runQuery !== 'function') {
    throw new Error('makeAuditMachinery: runQuery is required')
  }
  const pendingAudits = []
  const stats         = { dropped: 0, drainSuccess: 0, drainFailure: 0 }
  let   draining      = false

  async function tryInsert(rowParams) {
    await runQuery(AUDIT_INSERT_SQL, rowParams)
  }

  async function drain() {
    if (draining) return { drained: 0, skipped: 'in-progress' }
    draining = true
    let drained = 0
    try {
      while (pendingAudits.length > 0) {
        try {
          await tryInsert(pendingAudits[0])
          pendingAudits.shift()
          drained++
          stats.drainSuccess++
        } catch (err) {
          stats.drainFailure++
          return { drained, error: err }
        }
      }
      return { drained }
    } finally {
      draining = false
    }
  }

  function enqueue(rowParams, err) {
    if (pendingAudits.length >= bufferMax) {
      pendingAudits.shift()                        // drop oldest
      stats.dropped++
      if (stats.dropped === 1 || stats.dropped % 100 === 0) {
        log?.warn?.(
          { dropped: stats.dropped, bufferMax },
          '[pg] audit buffer full — oldest row evicted; raise APPCLOUD_AUDIT_BUFFER_MAX or fix the underlying DB issue',
        )
      }
    }
    pendingAudits.push(rowParams)
    if (err) {
      log?.warn?.(
        { err: err.message, queued: pendingAudits.length },
        '[pg] audit INSERT failed — buffered for retry',
      )
    }
  }

  async function audit(actor, action, resourceType, resourceId, resourceName, metadata = {}, diff = null) {
    const rowParams = buildAuditRow(actor, action, resourceType, resourceId, resourceName, metadata, diff)
    // Backlog or in-flight drain → queue (preserves order). The fast path
    // (direct INSERT, no buffer interaction) is the empty-and-idle case.
    if (draining || pendingAudits.length > 0) {
      enqueue(rowParams, null)
      // Await the drain when we kick it. Audit() is fire-and-forget at every
      // call site (`pg.audit(...).catch(() => {})`), so the latency only
      // costs the detached audit promise — not the user request. Awaiting
      // here gives callers a deterministic "audit is in DB or back in
      // buffer" guarantee on resolve, which matters for the test that
      // immediately reads the audit_log after the await.
      if (!draining) {
        await drain().catch(() => {})
      }
      return
    }
    try {
      await tryInsert(rowParams)
    } catch (err) {
      enqueue(rowParams, err)
    }
  }

  return {
    audit,
    drain,
    pending: () => pendingAudits.length,
    stats:   () => ({ ...stats, pending: pendingAudits.length }),
  }
}
