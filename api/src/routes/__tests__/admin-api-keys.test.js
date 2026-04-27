// Handler-level tests for /admin/api-keys/*. The integration test
// `auth-plugin.test.js` already covers DB-backed lookup + bootstrap;
// these tests run against a stub fastify with auth disabled so we can
// fast-iterate on the request/response contract: validation paths,
// response shape, conflict handling, and the "plaintext shown once"
// invariant.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiSrc    = path.resolve(__dirname, '..', '..')

// Stateful pg stub. Each test resets `nextResult` and `lastQuery` so
// assertions can target the SQL/params and the canned rows.
function makeStubPg() {
  const state = {
    queries: [],
    nextResult: [],
    nextError:  null,
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
        return state.nextResult
      },
      audit:       async () => {},
      ping:        async () => true,
      auditBuffer: { pending: () => 0, stats: () => ({}) },
    },
  }
}

async function build() {
  // Auth-disabled mode so /admin/api-keys reaches the handler under
  // an anonymous-admin principal — no API key needed in test.
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

  const stub = makeStubPg()
  fastify.decorate('pg', stub.pg)

  const { authPlugin } = await import(path.join(apiSrc, 'plugins/auth.js'))
  await authPlugin(fastify)

  const adminApiKeyRoutes = (await import(path.join(apiSrc, 'routes/admin-api-keys.js'))).default
  await fastify.register(adminApiKeyRoutes, { prefix: '/admin' })
  await fastify.ready()

  return { fastify, stub }
}

describe('POST /admin/api-keys', () => {
  let fastify, stub
  beforeAll(async () => { ({ fastify, stub } = await build()) })
  afterAll(async () => { await fastify?.close() })
  beforeEach(() => {
    stub.state.queries.length = 0
    stub.state.nextResult     = []
    stub.state.nextError      = null
  })

  test('returns 201 + plaintext + row metadata on a valid create', async () => {
    stub.state.nextResult = [{
      id: 'uuid-1', name: 'ci-bot', key_prefix: 'ak_abcd',
      scopes: ['write'], created_at: new Date().toISOString(),
      created_by: 'anonymous', last_used_at: null, revoked_at: null,
      expires_at: null, is_bootstrap: false,
    }]
    const r = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      payload: { name: 'ci-bot', scopes: ['write'] },
    })
    expect(r.statusCode).toBe(201)
    const body = JSON.parse(r.body)
    expect(body.name).toBe('ci-bot')
    expect(body.scopes).toEqual(['write'])
    expect(body.plaintext).toMatch(/^ak_/)             // generated key, shown once
    expect(body.plaintext.length).toBeGreaterThan(20)
  })

  test('rejects names with special characters as 400', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      payload: { name: 'invalid name!', scopes: ['write'] },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toMatch(/name must match/)
  })

  test('rejects past expiresAt with a 400 + clear message', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      payload: {
        name: 'past-key',
        scopes: ['write'],
        expiresAt: '2020-01-01T00:00:00Z',
      },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toMatch(/expiresAt must be in the future/)
  })

  test('rejects malformed expiresAt with a 400 (Ajv format-validation or handler check)', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      payload: { name: 'bad-time', scopes: ['write'], expiresAt: 'not-a-date' },
    })
    expect(r.statusCode).toBe(400)
    // Either Ajv catches it via `format: date-time` ("must match format")
    // or the handler's explicit Number.isNaN guard catches it; both are
    // valid because both produce a 400 with a clear message.
    expect(r.body).toMatch(/expiresAt|date-time|ISO date-time/i)
  })

  test('translates Postgres unique_violation (23505) into 409 Conflict', async () => {
    stub.state.nextError = Object.assign(new Error('duplicate'), { code: '23505' })
    const r = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      payload: { name: 'dup', scopes: ['write'] },
    })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatch(/already exists/)
  })

  test('rejects unknown scope values in scopes[] array', async () => {
    const r = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      payload: { name: 'bad-scope', scopes: ['cosmic'] },
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('GET /admin/api-keys', () => {
  let fastify, stub
  beforeAll(async () => { ({ fastify, stub } = await build()) })
  afterAll(async () => { await fastify?.close() })
  beforeEach(() => {
    stub.state.queries.length = 0
    stub.state.nextResult     = []
  })

  test('returns the rows pg returns, with no plaintext field', async () => {
    stub.state.nextResult = [
      { id: 'k1', name: 'one', key_prefix: 'ak_aa', scopes: ['read'], created_at: new Date().toISOString(),
        created_by: 'sys', last_used_at: null, revoked_at: null, expires_at: null, is_bootstrap: false },
    ]
    const r = await fastify.inject({ method: 'GET', url: '/admin/api-keys' })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body).toHaveLength(1)
    expect(body[0]).not.toHaveProperty('plaintext')
    expect(body[0]).not.toHaveProperty('key_hash')
  })

  test('accepts the documented includeRevoked query flag', async () => {
    stub.state.nextResult = []
    const r = await fastify.inject({ method: 'GET', url: '/admin/api-keys?includeRevoked=true' })
    expect(r.statusCode).toBe(200)
  })
})

describe('DELETE /admin/api-keys/:id', () => {
  let fastify, stub
  beforeAll(async () => { ({ fastify, stub } = await build()) })
  afterAll(async () => { await fastify?.close() })
  beforeEach(() => {
    stub.state.queries.length = 0
    stub.state.nextResult     = []
  })

  // Every test uses a real-shaped UUID — the route schema enforces
  // `format: uuid` on :id, so non-UUID values 400 before the handler.
  const REVOKE_ID = '00000000-0000-0000-0000-000000000001'

  test('returns 204 (no content) on a successful revoke', async () => {
    // The handler does TWO queries: SELECT (load existing), then UPDATE.
    // First call returns the row to revoke, second is the UPDATE.
    let callCount = 0
    stub.state.nextResult = [{ is_bootstrap: false, revoked_at: null }]
    const origQuery = stub.pg.query
    stub.pg.query = async (sql, params) => {
      callCount++
      if (callCount === 1) return [{ is_bootstrap: false, revoked_at: null }]
      return [{ id: REVOKE_ID }]                          // UPDATE returns the row
    }
    const r = await fastify.inject({ method: 'DELETE', url: `/admin/api-keys/${REVOKE_ID}` })
    stub.pg.query = origQuery                             // restore for next test
    expect(r.statusCode).toBe(204)
  })

  test('404 when the SELECT returns no row', async () => {
    stub.state.nextResult = []                            // SELECT empty → 404
    const r = await fastify.inject({ method: 'DELETE', url: `/admin/api-keys/${REVOKE_ID}` })
    expect(r.statusCode).toBe(404)
  })

  test('400 when :id is not a UUID (schema gate)', async () => {
    const r = await fastify.inject({ method: 'DELETE', url: '/admin/api-keys/not-a-uuid' })
    expect(r.statusCode).toBe(400)
  })

  test('409 when revoking an already-revoked key', async () => {
    stub.state.nextResult = [{ is_bootstrap: false, revoked_at: new Date().toISOString() }]
    const r = await fastify.inject({ method: 'DELETE', url: `/admin/api-keys/${REVOKE_ID}` })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatch(/already revoked/)
  })

  test('409 when trying to revoke a bootstrap-derived key', async () => {
    stub.state.nextResult = [{ is_bootstrap: true, revoked_at: null }]
    const r = await fastify.inject({ method: 'DELETE', url: `/admin/api-keys/${REVOKE_ID}` })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatch(/bootstrap keys cannot be revoked/)
  })
})
