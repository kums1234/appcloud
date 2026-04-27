// Handler-level tests for /admin/tenants/*. Mirrors the pattern of
// admin-api-keys.test.js: a stub fastify with auth disabled, stateful
// pg stub feeding `nextResult` per query, assertions on
// statusCode + body shape + the SQL the handler issued.
//
// Auth-disabled mode grants the open-auth principal the SUPER_ADMIN
// scope, so tenant-scoped routes (which require super-admin) reach
// the handler without an API key in test.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiSrc    = path.resolve(__dirname, '..', '..')

function makeStubPg() {
  const state = {
    queries: [],
    // Keyed responses — the handler runs multiple queries (existence
    // probe, then the mutating one); we step through this list in
    // order. Single-query tests can use `nextResult` for clarity.
    queue:        [],
    nextResult:   [],
    nextError:    null,
  }
  return {
    state,
    pg: {
      pool:        {},
      query:       async (sql, params) => {
        state.queries.push({ sql, params })
        if (state.nextError) {
          const e = state.nextError
          state.nextError = null
          throw e
        }
        if (state.queue.length > 0) return state.queue.shift()
        return state.nextResult
      },
      audit:       async () => {},
      ping:        async () => true,
      auditBuffer: { pending: () => 0, stats: () => ({}) },
    },
  }
}

async function build() {
  delete process.env.APPCLOUD_API_KEY
  delete process.env.APPCLOUD_ADMIN_API_KEY
  delete process.env.APPCLOUD_SUPER_ADMIN_API_KEY
  delete process.env.APPCLOUD_API_KEY_FILE
  delete process.env.APPCLOUD_ADMIN_API_KEY_FILE
  delete process.env.APPCLOUD_SUPER_ADMIN_API_KEY_FILE
  process.env.APPCLOUD_AUTH_DISABLED_WARN_MS = '0'

  const fastify = Fastify({
    logger: false,
    ajv:    { customOptions: { strict: false, keywords: ['example', 'xml'] } },
  })
  const sensible = (await import('@fastify/sensible')).default
  await fastify.register(sensible)

  const stub = makeStubPg()
  fastify.decorate('pg', stub.pg)

  const { authPlugin } = await import(path.join(apiSrc, 'plugins/auth.js'))
  await authPlugin(fastify)

  const { tenantContextPlugin } = await import(path.join(apiSrc, 'plugins/tenant-context.js'))
  await tenantContextPlugin(fastify)

  const adminTenantRoutes = (await import(path.join(apiSrc, 'routes/admin-tenants.js'))).default
  await fastify.register(adminTenantRoutes, { prefix: '/admin' })
  await fastify.ready()

  return { fastify, stub }
}

describe('POST /admin/tenants', () => {
  let fastify, stub
  beforeAll(async () => { ({ fastify, stub } = await build()) })
  afterAll(async () => { await fastify?.close() })
  beforeEach(() => {
    stub.state.queries.length = 0
    stub.state.queue.length   = 0
    stub.state.nextResult     = []
    stub.state.nextError      = null
  })

  test('returns 201 + the new row when slug, displayName valid', async () => {
    // Two queries: gen_random_uuid() then INSERT.
    stub.state.queue = [
      [{ id: '11111111-1111-1111-1111-111111111111' }],
      [{
        id: '11111111-1111-1111-1111-111111111111',
        slug: 'acme-corp',
        display_name: 'Acme Corp',
        status: 'active',
        schema_name: 'tenant_11111111111111111111111111111111',
        neo4j_database: 'tenant_11111111111111111111111111111111',
        created_at: new Date().toISOString(),
        created_by: 'anonymous',
        metadata: {},
      }],
    ]
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: 'acme-corp', displayName: 'Acme Corp' },
    })
    expect(r.statusCode).toBe(201)
    const body = JSON.parse(r.body)
    expect(body.slug).toBe('acme-corp')
    expect(body.status).toBe('active')
    expect(body.schema_name).toBe('tenant_11111111111111111111111111111111')
    expect(body.neo4j_database).toBe('tenant_11111111111111111111111111111111')
  })

  test('rejects an invalid slug as 400', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: 'BadSlug', displayName: 'x' },     // capitals, but Ajv pattern guards first
    })
    // Ajv catches the pattern at validation; the error is a 400.
    expect(r.statusCode).toBe(400)
  })

  test('rejects reserved slug `admin` even though it matches the pattern', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: 'admin', displayName: 'x' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toMatch(/reserved/)
  })

  test('rejects slug starting with underscore', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: '_internal', displayName: 'x' },
    })
    // Ajv pattern doesn't match `_…` either, so this fails at validation.
    expect(r.statusCode).toBe(400)
  })

  test('translates Postgres unique_violation (23505) into 409 Conflict', async () => {
    // First call (gen_random_uuid) succeeds; second call (INSERT) throws.
    stub.state.queue = [[{ id: '22222222-2222-2222-2222-222222222222' }]]
    stub.state.nextError = Object.assign(new Error('duplicate'), { code: '23505' })
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: 'dup', displayName: 'Dup' },
    })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatch(/already exists/)
  })
})

describe('GET /admin/tenants', () => {
  let fastify, stub
  beforeAll(async () => { ({ fastify, stub } = await build()) })
  afterAll(async () => { await fastify?.close() })
  beforeEach(() => {
    stub.state.queries.length = 0
    stub.state.queue.length   = 0
    stub.state.nextResult     = []
  })

  test('returns the rows pg returns, sorted by created_at desc', async () => {
    stub.state.nextResult = [
      {
        id: 't1', slug: 'one', display_name: 'One', status: 'active',
        schema_name: 'tenant_t1', neo4j_database: 'tenant_t1',
        created_at: new Date().toISOString(), created_by: 'sys', metadata: {},
      },
    ]
    const r = await fastify.inject({ method: 'GET', url: '/admin/tenants' })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body).toHaveLength(1)
    expect(body[0].slug).toBe('one')
  })

  test('passes the status filter param to pg when ?status=suspended', async () => {
    stub.state.nextResult = []
    const r = await fastify.inject({ method: 'GET', url: '/admin/tenants?status=suspended' })
    expect(r.statusCode).toBe(200)
    const lastQuery = stub.state.queries.at(-1)
    expect(lastQuery.sql).toMatch(/WHERE status = \$1/)
    expect(lastQuery.params).toEqual(['suspended'])
  })

  test('rejects an unknown status value at validation', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/admin/tenants?status=cosmic' })
    expect(r.statusCode).toBe(400)
  })
})

describe('PATCH /admin/tenants/:id', () => {
  let fastify, stub
  beforeAll(async () => { ({ fastify, stub } = await build()) })
  afterAll(async () => { await fastify?.close() })
  beforeEach(() => {
    stub.state.queries.length = 0
    stub.state.queue.length   = 0
    stub.state.nextResult     = []
  })

  test('returns 404 when the tenant does not exist', async () => {
    stub.state.nextResult = []
    const r = await fastify.inject({
      method: 'PATCH', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
      payload: { displayName: 'New Name' },
    })
    expect(r.statusCode).toBe(404)
  })

  test('refuses to patch a pending_delete tenant with 409', async () => {
    stub.state.queue = [[{ status: 'pending_delete' }]]
    const r = await fastify.inject({
      method: 'PATCH', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
      payload: { displayName: 'Doomed' },
    })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatch(/pending_delete/)
  })

  test('updates display_name + status and returns the row', async () => {
    stub.state.queue = [
      [{ status: 'active' }],                                         // existence probe
      [{                                                              // UPDATE … RETURNING
        id: 't1', slug: 'one', display_name: 'New', status: 'suspended',
        schema_name: 'tenant_t1', neo4j_database: 'tenant_t1',
        created_at: new Date().toISOString(), created_by: 'sys', metadata: {},
      }],
    ]
    const r = await fastify.inject({
      method: 'PATCH', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
      payload: { displayName: 'New', status: 'suspended' },
    })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.display_name).toBe('New')
    expect(body.status).toBe('suspended')
  })

  test('rejects PATCH status=pending_delete (must use DELETE)', async () => {
    const r = await fastify.inject({
      method: 'PATCH', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
      payload: { status: 'pending_delete' },
    })
    // Schema constrains status to active|suspended on PATCH; Ajv rejects.
    expect(r.statusCode).toBe(400)
  })
})

describe('DELETE /admin/tenants/:id', () => {
  let fastify, stub
  beforeAll(async () => { ({ fastify, stub } = await build()) })
  afterAll(async () => { await fastify?.close() })
  beforeEach(() => {
    stub.state.queries.length = 0
    stub.state.queue.length   = 0
    stub.state.nextResult     = []
  })

  test('returns 404 when the tenant does not exist', async () => {
    stub.state.queue = [[]]
    const r = await fastify.inject({
      method: 'DELETE', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
    })
    expect(r.statusCode).toBe(404)
  })

  test("refuses to delete the seeded 'default' tenant", async () => {
    stub.state.queue = [[{ slug: 'default', status: 'active' }]]
    const r = await fastify.inject({
      method: 'DELETE', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
    })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatch(/default/)
  })

  test('refuses to delete when active keys still bind to the tenant', async () => {
    stub.state.queue = [
      [{ slug: 'acme-corp', status: 'active' }],     // existence probe
      [{ active_keys: 2 }],                          // active-keys count
    ]
    const r = await fastify.inject({
      method: 'DELETE', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
    })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatch(/2 active API key/)
  })

  test('soft-deletes (status=pending_delete) when no active keys remain', async () => {
    stub.state.queue = [
      [{ slug: 'acme-corp', status: 'active' }],     // existence probe
      [{ active_keys: 0 }],                          // active-keys count
      [],                                            // UPDATE
    ]
    const r = await fastify.inject({
      method: 'DELETE', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
    })
    expect(r.statusCode).toBe(204)
    const updateQuery = stub.state.queries.at(-1)
    expect(updateQuery.sql).toMatch(/SET status = 'pending_delete'/)
  })

  test('rejects deleting an already-pending_delete tenant with 409', async () => {
    stub.state.queue = [[{ slug: 'acme-corp', status: 'pending_delete' }]]
    const r = await fastify.inject({
      method: 'DELETE', url: '/admin/tenants/00000000-0000-0000-0000-000000000000',
    })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatch(/already pending/)
  })
})
