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
//
//   - Poison-pill rows (e.g. FK violation, constraint failure on a
//     specific row) get a per-row attempt counter. After
//     MAX_ROW_ATTEMPTS retries that all fail, the row is evicted to
//     a "poisoned" counter and drain continues with the next row.
//     Without this, a single bad row blocks every subsequent audit
//     from being persisted — buffered rows pile up behind it and
//     eventually get dropped via overflow eviction with the auditor
//     never knowing why.

export const AUDIT_INSERT_SQL = `
  INSERT INTO audit_log(actor, actor_key_id, actor_scope, action, resource_type, resource_id, resource_name, metadata, diff, tenant_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`

// Build the (actor, action, …) parameter tuple from the polymorphic actor
// argument. Used by both the live INSERT path and the buffered-retry path.
//
// Phase 1d: tenant_id is required (audit_log.tenant_id NOT NULL post-cutover).
// Callers without a tenant context (none should exist for new code paths,
// but the audit_log schema constraint is the backstop) get an explicit
// error rather than a NULL that the DB later rejects with an opaque
// constraint violation.
export function buildAuditRow(actor, action, resourceType, resourceId, resourceName, metadata, diff, tenantId) {
  if (!tenantId) {
    throw new Error('buildAuditRow: tenantId is required (audit_log.tenant_id NOT NULL since Phase 1d)')
  }
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
    tenantId,
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
// After this many failed insert attempts on a single row, treat it as
// a poison pill and evict from the queue so subsequent rows aren't
// blocked. Three is conservative — transient DB blips usually recover
// within a single retry; FK / constraint violations don't recover at
// all, but their first attempt's error is enough signal.
const MAX_ROW_ATTEMPTS = 3

export function makeAuditMachinery({ runQuery, log, bufferMax = 1000 } = {}) {
  if (typeof runQuery !== 'function') {
    throw new Error('makeAuditMachinery: runQuery is required')
  }
  // Each entry: { params, attempts, lastErr }. Track attempts per-row
  // so a poison row gets evicted after MAX_ROW_ATTEMPTS instead of
  // permanently blocking the queue head.
  const pendingAudits = []
  const stats         = {
    dropped:       0,    // overflow-evictions (queue full)
    poisoned:      0,    // poison-evictions (row exceeded MAX_ROW_ATTEMPTS)
    drainSuccess:  0,
    drainFailure:  0,
  }
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
        const head = pendingAudits[0]
        try {
          await tryInsert(head.params)
          pendingAudits.shift()
          drained++
          stats.drainSuccess++
        } catch (err) {
          head.attempts = (head.attempts || 0) + 1
          head.lastErr  = err
          stats.drainFailure++
          if (head.attempts >= MAX_ROW_ATTEMPTS) {
            // Poison pill — evict + log the row identity so an operator
            // can reconstruct what happened. Continue draining the rest
            // of the queue; subsequent rows may succeed (the failure was
            // row-specific, not DB-wide).
            const evicted = pendingAudits.shift()
            stats.poisoned++
            log?.warn?.(
              {
                attempts:  evicted.attempts,
                err:       err.message,
                actor:     evicted.params[0],
                action:    evicted.params[3],
                resource:  `${evicted.params[4]}/${evicted.params[5]}`,
                poisoned:  stats.poisoned,
              },
              '[pg] audit row poison-evicted after MAX_ROW_ATTEMPTS — likely a permanent failure (constraint / FK)',
            )
            // Loop continues — try the next row.
          } else {
            // Transient-shaped failure on the head — bail out of this
            // drain pass so we don't burn through the rest of the queue
            // hammering the same DB. Next periodic drain (or post-
            // success kick) will retry from the head.
            return { drained, error: err }
          }
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
    pendingAudits.push({ params: rowParams, attempts: 0, lastErr: null })
    if (err) {
      log?.warn?.(
        { err: err.message, queued: pendingAudits.length },
        '[pg] audit INSERT failed — buffered for retry',
      )
    }
  }

  async function audit(actor, action, resourceType, resourceId, resourceName, metadata = {}, diff = null, tenantId = null) {
    const rowParams = buildAuditRow(actor, action, resourceType, resourceId, resourceName, metadata, diff, tenantId)
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
