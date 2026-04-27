// plugins/metrics.js
//
// Prometheus exposition endpoint + per-domain gauges. Today this is just
// the audit retry buffer (saturation alerts), but the registry is shared
// — adding HTTP latency histograms or DB pool metrics later is a matter
// of registering more collectors against `register`, not new plumbing.
//
// /metrics is intentionally public (schema.security: []). Standard
// Prometheus deployments scrape pods over the cluster network where
// access control is a network-policy concern, not an API-key one. The
// auth-coverage test's ALLOWED_PUBLIC_ROUTES set documents this stance.
//
// Why prom-client over hand-rolled exposition:
//   - Histograms with proper bucketing (we don't use them yet, but
//     adding HTTP latency will be the next step).
//   - The `collect` callback hook lets gauges read fresh state on each
//     scrape instead of needing a polling timer.
//   - Standard text format with no edge cases (label escaping, `_total`
//     suffixes for counters) hand-rolled code tends to get wrong.

import client from 'prom-client'

export async function metricsPlugin(fastify) {
  const register = new client.Registry()
  // Default Node process metrics (event-loop lag, memory, GC) — cheap
  // and consistent with what every other Node service exposes. The
  // `prefix` keeps them from colliding with future app-level metrics.
  client.collectDefaultMetrics({ register, prefix: 'appcloud_' })

  // Audit retry buffer — exposes the same numbers fastify.pg.auditBuffer.stats()
  // returns. Pulled fresh on every scrape via the `collect` callback so we
  // don't need a polling timer; the gauge value is whatever stats() reports
  // at scrape time.
  const auditBufferPending = new client.Gauge({
    name:       'appcloud_audit_buffer_pending',
    help:       'Audit rows currently buffered awaiting retry (high values = Postgres outage or backpressure).',
    registers:  [register],
    collect() {
      const pending = fastify.pg?.auditBuffer?.pending?.()
      if (typeof pending === 'number') this.set(pending)
    },
  })

  const auditBufferDropped = new client.Counter({
    name:       'appcloud_audit_buffer_dropped_total',
    help:       'Cumulative audit rows dropped because the retry buffer was full at the time of the audit() call.',
    registers:  [register],
  })

  // Poison-evictions: rows whose individual INSERT failed MAX_ROW_ATTEMPTS
  // times in a row (typically FK or constraint violations). Distinct from
  // `dropped` (queue overflow) — a steady non-zero rate here means a
  // schema or referential-integrity bug that's costing audit rows even
  // when the DB is healthy.
  const auditBufferPoisoned = new client.Counter({
    name:       'appcloud_audit_buffer_poisoned_total',
    help:       'Cumulative audit rows evicted as poison pills after exceeding the per-row retry limit (typically constraint / FK violations).',
    registers:  [register],
  })

  // Counter values are monotonic — we read the cumulative stats on each
  // scrape and reconcile by setting an internal offset. prom-client
  // doesn't let us call .reset() then .inc() (that's racy under
  // concurrent scrapes), so we track lastSeen and increment by delta on
  // each scrape instead.
  let lastSeenDropped  = 0
  let lastSeenPoisoned = 0
  const collectDropped = () => {
    const stats = fastify.pg?.auditBuffer?.stats?.()
    if (!stats) return
    if (typeof stats.dropped === 'number') {
      const delta = stats.dropped - lastSeenDropped
      if (delta > 0)      { auditBufferDropped.inc(delta);  lastSeenDropped  = stats.dropped }
      else if (delta < 0) { lastSeenDropped  = stats.dropped }
    }
    if (typeof stats.poisoned === 'number') {
      const delta = stats.poisoned - lastSeenPoisoned
      if (delta > 0)      { auditBufferPoisoned.inc(delta); lastSeenPoisoned = stats.poisoned }
      else if (delta < 0) { lastSeenPoisoned = stats.poisoned }
    }
  }

  // Auth-disabled gauge — 1 when the auth plugin is in its open-auth
  // fallback (no bootstrap env vars + empty DB cache), 0 otherwise. The
  // intended alert: `appcloud_auth_disabled == 1` for more than a few
  // minutes in a non-dev environment is a deploy bug.
  new client.Gauge({
    name:       'appcloud_auth_disabled',
    help:       'Set to 1 when the auth plugin is running in open-auth fallback (every request becomes anonymous-admin); 0 otherwise.',
    registers:  [register],
    collect() {
      // fastify.authDisabled is decorated by plugins/auth.js. If the
      // auth plugin failed to load entirely, treat it as not-disabled
      // (the API won't be serving traffic anyway).
      this.set(fastify.authDisabled === true ? 1 : 0)
    },
  })

  // audit_log_default detached gauge — 1 when the default partition
  // exists but is no longer attached to the partition tree (the
  // post-DETACH state if redistributeDefaultPartition crashed before
  // the finally re-attach landed). A detached default silently rejects
  // INSERTs whose month has no monthly partition; the alert
  // `appcloud_audit_log_default_detached == 1 for > 5m` should page
  // ops, who run `ALTER TABLE audit_log ATTACH PARTITION
  // audit_log_default DEFAULT` to recover.
  new client.Gauge({
    name:       'appcloud_audit_log_default_detached',
    help:       'Set to 1 when audit_log_default exists but is detached from the partition tree; 0 otherwise.',
    registers:  [register],
    async collect() {
      // fastify.auditCleanup is decorated by plugins/audit-cleanup.js.
      // The probe is a fast pg_class / pg_inherits read — well under
      // the typical Prometheus scrape budget.
      const detached = await fastify.auditCleanup?.defaultPartitionDetached?.()
      this.set(detached === true ? 1 : 0)
    },
  })

  fastify.decorate('metricsRegistry', register)

  fastify.get('/metrics', {
    schema: {
      tags:        ['Health'],
      summary:     'Prometheus metrics',
      description: 'Plain-text Prometheus exposition for the API process. Open by convention — Prometheus scrapes pods over the cluster network where network policy provides isolation, not API keys. Audit-buffer saturation gauge `appcloud_audit_buffer_pending` and `appcloud_audit_buffer_dropped_total` are the high-leverage alert targets.',
      security:    [],
      response: {
        200: {
          // Plain-text body — declare the content type so @fastify/swagger
          // doesn't try to validate the response as JSON.
          content: { 'text/plain': { schema: { type: 'string' } } },
        },
      },
    },
  }, async (req, reply) => {
    collectDropped()
    reply.type(register.contentType)
    return register.metrics()
  })
}
