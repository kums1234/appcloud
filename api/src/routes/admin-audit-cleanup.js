// Admin endpoints for audit_log retention housekeeping that don't fit
// the periodic cleanup loop. The periodic loop (plugins/audit-cleanup.js)
// drops expired partitions on a timer; this file exposes operator-driven
// actions that are too coarse — or too rare — to bake into the loop.
//
// Today this is just /admin/audit-cleanup/redistribute-default. Future
// admin actions on the audit pipeline (manual partition drop, force
// retention pass, etc.) belong here too rather than in admin-api-keys.js.

// Both response shapes have a "happy path" form (full result) and a
// "skipped" form (returned when the dependency is unavailable). Don't
// declare `required` — Fastify treats response schemas as strict in
// either direction, and a schema that demands all happy-path fields
// would 500 on the legitimate `{ skipped: '...' }` shape.
const BufferStatsResponse = {
  type: 'object',
  properties: {
    pending: { type: 'integer',
      description: 'Audit rows currently sitting in the retry buffer (Postgres unreachable or slow). High and rising = Postgres backpressure; high and flat = Postgres unavailable.' },
    stats: {
      type: 'object',
      required: ['accepted', 'flushed', 'dropped', 'errors'],
      properties: {
        accepted: { type: 'integer', description: 'Lifetime audit() calls that the machinery accepted (regardless of whether they made it to Postgres).' },
        flushed:  { type: 'integer', description: 'Lifetime rows successfully INSERTed.' },
        dropped:  { type: 'integer', description: 'Lifetime rows dropped because the retry buffer was at capacity when audit() was called. Non-zero is a signal to bump APPCLOUD_AUDIT_BUFFER_MAX or fix the underlying Postgres outage.' },
        errors:   { type: 'integer', description: 'Lifetime INSERT failures (already retried via the buffer; this is the failure count, not the user-visible drop count).' },
      },
      additionalProperties: false,
    },
    skipped: { type: 'string',
      description: 'Set when no buffer is wired up — `no-pg` indicates the Postgres plugin degraded to its stub.' },
  },
  additionalProperties: false,
}

const RedistributeResponse = {
  type: 'object',
  // No `required` — see BufferStatsResponse for the rationale; the
  // skipped-path return is `{ skipped: 'state=...' }` which doesn't
  // populate the happy-path fields.
  properties: {
    moved: { type: 'integer',
      description: 'Total number of rows moved out of audit_log_default into monthly partitions.' },
    partitionsCreated: {
      type: 'array',
      items: { type: 'string' },
      description: 'Names of partitions created by this run (audit_log_YYYY_MM). Already-existing partitions are reused without re-creating.',
    },
    months: {
      type: 'array',
      description: 'Per-month breakdown so an operator can see which months held the largest backlog.',
      items: {
        type: 'object',
        required: ['partition', 'year', 'month', 'moved'],
        properties: {
          partition: { type: 'string', example: 'audit_log_2025_11' },
          year:      { type: 'integer' },
          month:     { type: 'integer', minimum: 1, maximum: 12 },
          moved:     { type: 'integer' },
        },
      },
    },
    skipped: { type: 'string',
      description: 'Set when no work was done — `no-pg` (DB unavailable) or `state=<x>` (audit_log not yet partitioned).' },
  },
  additionalProperties: false,
}

export default async function adminAuditCleanupRoutes(fastify) {
  // Audit retry buffer telemetry. Mirrors what /metrics exposes for
  // Prometheus, but as JSON for ad-hoc inspection / runbook checks.
  // Returns 200 with `skipped: 'no-pg'` when Postgres is in stub mode
  // (so the route can stay registered in dev without auth-disabled
  // surprises) rather than 503.
  fastify.get('/audit-cleanup/buffer-stats', {
    config: { scope: 'admin' },
    schema: {
      summary:     'Audit retry-buffer state (pending + lifetime counters)',
      description: 'Snapshot of the audit() retry buffer — the in-memory queue that holds audit rows during a Postgres outage. Use this when debugging "why are some audit rows missing?" or when alerts fire on the matching Prometheus gauges. Admin-tier; no rate limit on this route.',
      tags:        ['Audit'],
      response:    { 200: BufferStatsResponse },
    },
  }, async () => {
    const buf = fastify.pg?.auditBuffer
    if (!buf) return { pending: 0, stats: { accepted: 0, flushed: 0, dropped: 0, errors: 0 }, skipped: 'no-pg' }
    return { pending: buf.pending(), stats: buf.stats() }
  })

  // Push-button redistribute. Pre-partition rows park in audit_log_default
  // forever because retention's DROP PARTITION skips it. This sweeps them
  // into the matching monthly partitions, creating partitions as needed.
  // Idempotent — already-redistributed rows leave nothing to do, so a
  // re-run reports moved=0 cleanly.
  fastify.post('/audit-cleanup/redistribute-default', {
    config: { scope: 'admin' },
    schema: {
      summary:     'Redistribute audit_log_default rows into monthly partitions',
      description: 'Scans the default partition and moves rows into the partition matching their `created_at` month, creating new monthly partitions as needed. Use this once after the partitioning migration has parked old rows in the default, or any time pre-migration / unrouted rows accumulate. Admin-tier only.',
      tags:        ['Audit'],
      // No body — the action is its own trigger. Lock the shape so a
      // misconfigured client sending stale body data gets a 400 instead
      // of having its body silently ignored.
      body:        { type: 'object', additionalProperties: false },
      response:    { 200: RedistributeResponse },
    },
  }, async () => {
    return fastify.auditCleanup.redistributeDefault()
  })
}
