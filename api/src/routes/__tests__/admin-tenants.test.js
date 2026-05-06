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

// SQL the POST handler issues that doesn't need a queued response —
// transaction control, DDL, and the schema_migrations bookkeeping
// INSERT. The stub passes these through with `{ rows: [] }` and does
// not consume from the test's queue, so tests can queue only the
// "interesting" results (gen_random_uuid, INSERT RETURNING, lookups).
const PASSTHROUGH_RE =
  /^\s*(?:BEGIN|COMMIT|ROLLBACK|SET\s+LOCAL|CREATE\s+(?:SCHEMA|TABLE|INDEX))/i
const SCHEMA_MIGRATIONS_INSERT_RE =
  /^\s*INSERT\s+INTO\s+control\.schema_migrations/i

// Queue entries can be plain rows arrays *or* `{ __throw: Error }` to
// inject an error at a specific position in the sequence. This is how
// tests reproduce a 23505 unique_violation on the INSERT RETURNING
// step without affecting the BEGIN that comes before it.
const errResult = (err) => ({ __throw: err })

function makeStubPg() {
  const state = {
    queries: [],
    queue:        [],          // shifted by non-passthrough queries
    nextResult:   [],
    nextError:    null,        // legacy, applies to the very next pg.query
  }

  const consume = () => {
    const next = state.queue.length > 0 ? state.queue.shift() : state.nextResult
    if (next && next.__throw) throw next.__throw
    return next
  }

  const poolClientQuery = async (sql, params) => {
    state.queries.push({ sql, params })
    if (PASSTHROUGH_RE.test(sql) || SCHEMA_MIGRATIONS_INSERT_RE.test(sql)) {
      return { rows: [] }
    }
    return { rows: consume() }
  }

  const pgQuery = async (sql, params) => {
    state.queries.push({ sql, params })
    if (state.nextError) {
      const e = state.nextError
      state.nextError = null
      throw e
    }
    return consume()
  }

  // Mirror the production fastify.pg.transaction() helper — checks out
  // the fake client, BEGINs, runs fn, COMMITs (or ROLLBACKs on throw).
  // The POST /admin/tenants handler uses this; tests need it for the
  // handler to reach the stub.
  const transaction = async (fn) => {
    const client = { query: poolClientQuery, release: () => {} }
    await client.query('BEGIN')
    try {
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try { await client.query('ROLLBACK') } catch {}
      throw err
    }
  }

  return {
    state,
    pg: {
      pool: {
        // POST /admin/tenants checks out a client to bundle row-insert
        // and schema provisioning into one transaction. The fake client
        // shares state with pg.query so assertions work either way.
        connect: async () => ({
          query:   poolClientQuery,
          release: () => {},
        }),
      },
      query:       pgQuery,
      transaction,
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
    // gen_random_uuid → INSERT row → information_schema (no row) → sha
    // lookup (no row). The remaining DDL/SET/INSERT-bookkeeping calls
    // are passthrough and don't consume queue entries.
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

  test('rejects reserved slug `default` (the seeded tenant)', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: 'default', displayName: 'x' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toMatch(/reserved/)
  })

  test('rejects reserved slug `default-test` (owned by agents/seed.js)', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: 'default-test', displayName: 'x' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toMatch(/reserved/)
  })

  test('?allowReserved=true bypasses the reserved-slug guard for `default-test`', async () => {
    stub.state.queue = [
      [{ id: '44444444-4444-4444-4444-444444444444' }],
      [{
        id: '44444444-4444-4444-4444-444444444444',
        slug: 'default-test',
        display_name: 'Seed test tenant',
        status: 'active',
        schema_name: 'tenant_44444444444444444444444444444444',
        neo4j_database: 'tenant_44444444444444444444444444444444',
        created_at: new Date().toISOString(),
        created_by: 'anonymous',
        metadata: {},
      }],
    ]
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants?allowReserved=true',
      payload: { slug: 'default-test', displayName: 'Seed test tenant' },
    })
    expect(r.statusCode).toBe(201)
    expect(JSON.parse(r.body).slug).toBe('default-test')
  })

  test('rejects slug starting with underscore', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: '_internal', displayName: 'x' },
    })
    // Ajv pattern doesn't match `_…` either, so this fails at validation.
    expect(r.statusCode).toBe(400)
  })

  test('provisions the tenant schema on POST: CREATE SCHEMA + applies 001 + bookkeeping INSERT', async () => {
    stub.state.queue = [
      [{ id: '33333333-3333-3333-3333-333333333333' }],
      [{
        id: '33333333-3333-3333-3333-333333333333',
        slug: 'beta-corp',
        display_name: 'Beta Corp',
        status: 'active',
        schema_name: 'tenant_33333333333333333333333333333333',
        neo4j_database: 'tenant_33333333333333333333333333333333',
        created_at: new Date().toISOString(),
        created_by: 'anonymous',
        metadata: {},
      }],
      // information_schema.schemata lookup → schema does not exist yet
      [],
      // schema_migrations sha lookup for the one migration → no prior application
      [],
    ]
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: 'beta-corp', displayName: 'Beta Corp' },
    })
    expect(r.statusCode).toBe(201)
    const sqls = stub.state.queries.map(q => q.sql)
    // Bracketing transaction.
    expect(sqls[0]).toMatch(/^BEGIN/)
    expect(sqls.at(-1)).toMatch(/^COMMIT/)
    // Schema-provisioning fingerprint.
    expect(sqls.some(s => /CREATE SCHEMA "tenant_33333333333333333333333333333333"/.test(s))).toBe(true)
    expect(sqls.some(s => /SET LOCAL search_path = "tenant_33333333333333333333333333333333"/.test(s))).toBe(true)
    // The runner records its work in control.schema_migrations.
    expect(sqls.some(s => /INSERT INTO control\.schema_migrations/.test(s))).toBe(true)
  })

  test('rolls back the row insert when schema provisioning fails', async () => {
    stub.state.queue = [
      [{ id: '44444444-4444-4444-4444-444444444444' }],
      [{
        id: '44444444-4444-4444-4444-444444444444',
        slug: 'gamma',
        display_name: 'Gamma',
        status: 'active',
        schema_name: 'tenant_44444444444444444444444444444444',
        neo4j_database: 'tenant_44444444444444444444444444444444',
        created_at: new Date().toISOString(),
        created_by: 'anonymous',
        metadata: {},
      }],
      // information_schema lookup throws — simulates a permission error
      // while the runner is checking whether the schema exists.
      errResult(new Error('permission denied for schema control')),
    ]
    const r = await fastify.inject({
      method: 'POST', url: '/admin/tenants',
      payload: { slug: 'gamma', displayName: 'Gamma' },
    })
    expect(r.statusCode).toBe(500)
    const sqls = stub.state.queries.map(q => q.sql)
    expect(sqls.some(s => /^ROLLBACK/.test(s))).toBe(true)
    expect(sqls.some(s => /^COMMIT/.test(s))).toBe(false)
  })

  test('translates Postgres unique_violation (23505) into 409 Conflict', async () => {
    // gen_random_uuid succeeds; INSERT RETURNING throws (slug collision).
    // Passthrough SQL (BEGIN, etc.) doesn't consume from queue, so the
    // first interesting query is gen_random_uuid and the second is the
    // INSERT — exactly two queue entries.
    stub.state.queue = [
      [{ id: '22222222-2222-2222-2222-222222222222' }],
      errResult(Object.assign(new Error('duplicate'), { code: '23505' })),
    ]
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
