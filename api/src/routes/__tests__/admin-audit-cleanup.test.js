// Handler-level tests for /admin/audit-cleanup/*. Exercises the
// route surface against a stub fastify; underlying logic
// (redistributeDefaultPartition, isDefaultPartitionDetached) has its
// own unit + integration tests in utils/audit-partitioning.test.js.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiSrc    = path.resolve(__dirname, '..', '..')

async function buildServer({ auditCleanup }) {
  // Auth-disabled mode so admin-tier endpoints reach handlers under
  // the anonymous-admin principal — no real key needed in test.
  delete process.env.APPCLOUD_API_KEY
  delete process.env.APPCLOUD_ADMIN_API_KEY
  delete process.env.APPCLOUD_API_KEY_FILE
  delete process.env.APPCLOUD_ADMIN_API_KEY_FILE
  process.env.APPCLOUD_AUTH_DISABLED_WARN_MS = '0'

  const fastify = Fastify({
    logger: false,
    ajv:    { customOptions: { strict: false, keywords: ['example', 'xml'] } },
  })
  const sensible = (await import('@fastify/sensible')).default
  await fastify.register(sensible)

  fastify.decorate('pg', {
    pool: {}, query: async () => [], audit: async () => {}, ping: async () => true,
    auditBuffer: { pending: () => 0, stats: () => ({}) },
  })
  fastify.decorate('auditCleanup', auditCleanup)

  const { authPlugin } = await import(path.join(apiSrc, 'plugins/auth.js'))
  await authPlugin(fastify)

  const adminAuditCleanup = (await import(path.join(apiSrc, 'routes/admin-audit-cleanup.js'))).default
  await fastify.register(adminAuditCleanup, { prefix: '/admin' })
  await fastify.ready()
  return fastify
}

describe('GET /admin/audit-cleanup/buffer-stats', () => {
  let fastify
  afterAll(async () => { await fastify?.close() })

  test('returns pending + lifetime counters in the documented shape', async () => {
    fastify = await buildServer({
      auditCleanup: { redistributeDefault: async () => ({}), defaultPartitionDetached: async () => false },
    })
    // Override the buffer accessor so the route returns deterministic numbers.
    fastify.pg.auditBuffer = {
      pending: () => 7,
      stats:   () => ({ accepted: 100, flushed: 93, dropped: 0, errors: 0, poisoned: 0 }),
    }
    const r = await fastify.inject({ method: 'GET', url: '/admin/audit-cleanup/buffer-stats' })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.pending).toBe(7)
    expect(body.stats).toMatchObject({ accepted: 100, flushed: 93, dropped: 0 })
  })

  test('returns the no-pg short-circuit when buffer is absent', async () => {
    fastify = await buildServer({
      auditCleanup: { redistributeDefault: async () => ({}), defaultPartitionDetached: async () => false },
    })
    fastify.pg.auditBuffer = undefined
    const r = await fastify.inject({ method: 'GET', url: '/admin/audit-cleanup/buffer-stats' })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.skipped).toBe('no-pg')
  })
})

describe('GET /admin/audit-cleanup/default-partition-state', () => {
  let fastify
  afterAll(async () => { await fastify?.close() })

  test('returns detached:false + empty recoverySql when default is attached', async () => {
    fastify = await buildServer({
      auditCleanup: {
        redistributeDefault:      async () => ({}),
        defaultPartitionDetached: async () => false,
      },
    })
    const r = await fastify.inject({ method: 'GET', url: '/admin/audit-cleanup/default-partition-state' })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.detached).toBe(false)
    expect(body.recoverySql).toBe('')
  })

  test('returns detached:true + the ATTACH PARTITION recovery SQL when detached', async () => {
    fastify = await buildServer({
      auditCleanup: {
        redistributeDefault:      async () => ({}),
        defaultPartitionDetached: async () => true,
      },
    })
    const r = await fastify.inject({ method: 'GET', url: '/admin/audit-cleanup/default-partition-state' })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.detached).toBe(true)
    expect(body.recoverySql).toMatch(/ATTACH PARTITION audit_log_default DEFAULT/)
  })
})

describe('POST /admin/audit-cleanup/redistribute-default', () => {
  let fastify
  afterAll(async () => { await fastify?.close() })

  test('returns the per-month breakdown the underlying function produced', async () => {
    fastify = await buildServer({
      auditCleanup: {
        redistributeDefault: async () => ({
          moved: 7,
          partitionsCreated: ['audit_log_2025_06'],
          months: [{ partition: 'audit_log_2025_06', year: 2025, month: 6, moved: 7 }],
        }),
        defaultPartitionDetached: async () => false,
      },
    })
    const r = await fastify.inject({ method: 'POST', url: '/admin/audit-cleanup/redistribute-default', payload: {} })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.moved).toBe(7)
    expect(body.partitionsCreated).toEqual(['audit_log_2025_06'])
    expect(body.months).toHaveLength(1)
  })

  test('rejects non-object body (fuzz invariant — schema is strict)', async () => {
    fastify = await buildServer({
      auditCleanup: { redistributeDefault: async () => ({}), defaultPartitionDetached: async () => false },
    })
    const r = await fastify.inject({
      method:  'POST',
      url:     '/admin/audit-cleanup/redistribute-default',
      headers: { 'content-type': 'application/json' },
      payload: '"not-an-object"',
    })
    expect(r.statusCode).toBe(400)
  })

  test('returns the no-pg shape when the plugin reports it', async () => {
    fastify = await buildServer({
      auditCleanup: {
        redistributeDefault:      async () => ({ skipped: 'no-pg' }),
        defaultPartitionDetached: async () => false,
      },
    })
    const r = await fastify.inject({ method: 'POST', url: '/admin/audit-cleanup/redistribute-default', payload: {} })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.skipped).toBe('no-pg')
  })
})
