// Integration test — DB-backed auth plugin against real Postgres via
// Testcontainers. Locks the contract that:
//
//   1. The api_keys table is created on startup.
//   2. APPCLOUD_API_KEY / APPCLOUD_ADMIN_API_KEY env vars upsert
//      bootstrap rows with the right scopes.
//   3. A request with a valid bootstrap key gets req.principal set.
//   4. A request with an unknown key returns 401.
//   5. A revoked key stops working after a cache refresh.
//
// The unit-level auth-coverage test stays — it proves preHandlers are
// attached. This test exercises the actual DB lookup path the unit test
// can't reach.

import { test, expect, beforeAll, afterAll, jest } from '@jest/globals'
import Fastify from 'fastify'
import {
  getMaybeDescribe,
  startPostgres,
  applyPostgresInitFiles,
} from './helpers.js'
import { generateKey, hashKey, prefixOf } from '../../utils/api-keys.js'

jest.setTimeout(600_000)

const maybeDescribe = getMaybeDescribe('auth-plugin integration')

maybeDescribe('auth plugin → api_keys DB lookup (Testcontainers)', () => {
  let pgContainer, pgClient
  let fastify
  let bootstrapKey, bootstrapAdminKey

  beforeAll(async () => {
    ;({ container: pgContainer, client: pgClient } = await startPostgres())
    // 01-schema.sql sets up extensions; 10-api-keys.sql is the table this
    // plugin needs. The plugin's own CREATE TABLE IF NOT EXISTS would also
    // create it, but we apply the canonical file so any drift is loud.
    await applyPostgresInitFiles(pgClient, ['01-schema.sql', '10-api-keys.sql'])

    // Set env vars *before* the auth plugin starts — its bootstrap path
    // upserts rows from these.
    bootstrapKey      = generateKey()
    bootstrapAdminKey = generateKey()
    process.env.APPCLOUD_API_KEY       = bootstrapKey
    process.env.APPCLOUD_ADMIN_API_KEY = bootstrapAdminKey
    delete process.env.APPCLOUD_API_KEY_FILE
    delete process.env.APPCLOUD_ADMIN_API_KEY_FILE
    // Tighten the cache TTL so the revocation test doesn't have to sleep
    // for a minute.
    process.env.APPCLOUD_AUTH_CACHE_TTL_MS = '50'

    // Match production Ajv config so route schemas with `example:` parse.
    fastify = Fastify({
      logger: false,
      ajv: { customOptions: { strict: false, keywords: ['example', 'xml'] } },
    })
    // @fastify/sensible decorates reply with .conflict / .notFound / .badRequest
    // — admin-api-keys routes use these. The production server registers it
    // before any route plugin runs (server.js).
    const sensible = (await import('@fastify/sensible')).default
    await fastify.register(sensible)
    fastify.decorate('pg', {
      pool:  pgClient,
      query: async (sql, params = []) => (await pgClient.query(sql, params)).rows,
    })

    const { authPlugin } = await import('../../plugins/auth.js')
    await authPlugin(fastify)

    // A small set of test routes covering the three scope-resolution paths
    // the onRoute hook handles:
    //   GET    → defaults to read
    //   POST   → defaults to write
    //   admin  → explicit config.scope
    fastify.get('/whoami', async (req) => ({
      name:   req.principal?.name,
      scopes: req.principal?.scopes,
    }))
    fastify.post('/things', async () => ({ ok: true }))
    fastify.get('/admin/secret', { config: { scope: 'admin' } }, async () => ({ secret: 42 }))

    // Register the real admin-api-keys CRUD plugin so we can exercise it
    // end-to-end with the same auth + principal wiring it'll see in prod.
    const { default: adminApiKeyRoutes } = await import('../../routes/admin-api-keys.js')
    await fastify.register(adminApiKeyRoutes, { prefix: '/admin' })
    await fastify.ready()
  }, 180_000)

  afterAll(async () => {
    try { await fastify?.close() }    catch {}
    try { await pgClient?.end() }     catch {}
    try { await pgContainer?.stop() } catch {}
  })

  test('bootstrap rows are upserted with the right scopes', async () => {
    const rows = await pgClient.query(`
      SELECT name, scopes, key_prefix, is_bootstrap, revoked_at
      FROM api_keys
      ORDER BY name
    `)
    expect(rows.rows).toEqual([
      expect.objectContaining({
        name:         'bootstrap-admin-key',
        scopes:       ['admin'],
        key_prefix:   prefixOf(bootstrapAdminKey),
        is_bootstrap: true,
        revoked_at:   null,
      }),
      expect.objectContaining({
        name:         'bootstrap-api-key',
        scopes:       ['write'],
        key_prefix:   prefixOf(bootstrapKey),
        is_bootstrap: true,
        revoked_at:   null,
      }),
    ])
  })

  test('valid bootstrap key authenticates and gets the right scopes', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.payload)).toEqual({
      name:   'bootstrap-admin-key',
      scopes: ['admin'],
    })
  })

  test('valid write-tier key authenticates with write scope', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': bootstrapKey },
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.payload).scopes).toEqual(['write'])
  })

  test('unknown key returns 401', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': 'ak_does-not-exist' },
    })
    expect(r.statusCode).toBe(401)
  })

  test('missing X-API-Key returns 401', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/whoami' })
    expect(r.statusCode).toBe(401)
  })

  test('revoking a key stops it working after the cache TTL', async () => {
    // Insert a fresh hand-created key; verify it works, revoke it, wait
    // out the cache TTL, verify it's now 401.
    const fresh = generateKey()
    await pgClient.query(`
      INSERT INTO api_keys (name, key_hash, key_prefix, scopes)
      VALUES ('revocation-test-key', $1, $2, ARRAY['read'])
    `, [hashKey(fresh), prefixOf(fresh)])

    // Wait for the cache to pick up the new row.
    await new Promise(r => setTimeout(r, 80))
    let r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': fresh },
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.payload).scopes).toEqual(['read'])

    // Revoke it.
    await pgClient.query(`
      UPDATE api_keys SET revoked_at = now() WHERE name = 'revocation-test-key'
    `)
    await new Promise(r => setTimeout(r, 80))
    r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': fresh },
    })
    expect(r.statusCode).toBe(401)
  })

  test('scope enforcement: read key cannot POST (403)', async () => {
    const readKey = generateKey()
    await pgClient.query(`
      INSERT INTO api_keys (name, key_hash, key_prefix, scopes)
      VALUES ('scope-read-test', $1, $2, ARRAY['read'])
    `, [hashKey(readKey), prefixOf(readKey)])
    await new Promise(r => setTimeout(r, 80))

    // GET works.
    let r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': readKey },
    })
    expect(r.statusCode).toBe(200)

    // POST is blocked — the route resolves to write scope by default.
    r = await fastify.inject({
      method: 'POST', url: '/things',
      headers: { 'x-api-key': readKey, 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(r.statusCode).toBe(403)
    expect(JSON.parse(r.payload).message).toMatch(/scope 'write' required/)

    // Admin route is also blocked.
    r = await fastify.inject({
      method: 'GET', url: '/admin/secret',
      headers: { 'x-api-key': readKey },
    })
    expect(r.statusCode).toBe(403)
    expect(JSON.parse(r.payload).message).toMatch(/scope 'admin' required/)
  })

  test('scope enforcement: write key can POST but not access admin', async () => {
    const writeKey = bootstrapKey                         // bootstrap-api-key has write
    let r = await fastify.inject({
      method: 'POST', url: '/things',
      headers: { 'x-api-key': writeKey, 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(r.statusCode).toBe(200)

    r = await fastify.inject({
      method: 'GET', url: '/admin/secret',
      headers: { 'x-api-key': writeKey },
    })
    expect(r.statusCode).toBe(403)
  })

  test('scope enforcement: admin key reaches every scope tier', async () => {
    const adminKey = bootstrapAdminKey                    // bootstrap-admin-key has admin
    for (const url of ['/whoami', '/admin/secret']) {
      const r = await fastify.inject({
        method: 'GET', url,
        headers: { 'x-api-key': adminKey },
      })
      expect(r.statusCode).toBe(200)
    }
    const post = await fastify.inject({
      method: 'POST', url: '/things',
      headers: { 'x-api-key': adminKey, 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(post.statusCode).toBe(200)
  })

  test('admin-tier: POST /admin/api-keys creates, GET lists, DELETE revokes', async () => {
    // Create.
    const created = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'crud-test-key', scopes: ['read'] }),
    })
    expect(created.statusCode).toBe(201)
    const body = JSON.parse(created.payload)
    expect(body.name).toBe('crud-test-key')
    expect(body.scopes).toEqual(['read'])
    expect(body.is_bootstrap).toBe(false)
    expect(body.plaintext).toMatch(/^ak_/)
    expect(body.plaintext.length).toBeGreaterThanOrEqual(46)
    expect(body.created_by).toBe('bootstrap-admin-key')

    // The newly created key is immediately usable (cache invalidation).
    const newKey = body.plaintext
    const useFresh = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': newKey },
    })
    expect(useFresh.statusCode).toBe(200)
    expect(JSON.parse(useFresh.payload).name).toBe('crud-test-key')

    // List.
    const list = await fastify.inject({
      method: 'GET', url: '/admin/api-keys',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(list.statusCode).toBe(200)
    const rows = JSON.parse(list.payload)
    expect(rows.find(r => r.name === 'crud-test-key')).toBeTruthy()
    // Plaintext is never echoed back.
    for (const r of rows) expect(r.plaintext).toBeUndefined()

    // Revoke.
    const del = await fastify.inject({
      method: 'DELETE', url: `/admin/api-keys/${body.id}`,
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(del.statusCode).toBe(204)

    // Revoked key no longer authenticates (cache invalidation again).
    const denied = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': newKey },
    })
    expect(denied.statusCode).toBe(401)
  })

  test('admin-tier: write key cannot reach /admin/api-keys', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/admin/api-keys',
      headers: { 'x-api-key': bootstrapKey },          // write-tier
    })
    expect(r.statusCode).toBe(403)
  })

  test('admin-tier: bootstrap rows cannot be revoked via the API', async () => {
    // Use a fresh admin key (not the bootstrap one) so we hit the
    // is_bootstrap branch rather than the self-revoke branch.
    const created = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'bootstrap-revoke-tester', scopes: ['admin'] }),
    })
    expect(created.statusCode).toBe(201)
    const otherAdminKey   = JSON.parse(created.payload).plaintext
    const otherAdminKeyId = JSON.parse(created.payload).id

    const list = await fastify.inject({
      method: 'GET', url: '/admin/api-keys',
      headers: { 'x-api-key': otherAdminKey },
    })
    const bootstrapRow = JSON.parse(list.payload).find(r => r.name === 'bootstrap-admin-key')
    expect(bootstrapRow).toBeTruthy()

    const del = await fastify.inject({
      method: 'DELETE', url: `/admin/api-keys/${bootstrapRow.id}`,
      headers: { 'x-api-key': otherAdminKey },
    })
    expect(del.statusCode).toBe(409)
    expect(JSON.parse(del.payload).message).toMatch(/bootstrap/)

    // Cleanup the helper key.
    await fastify.inject({
      method: 'DELETE', url: `/admin/api-keys/${otherAdminKeyId}`,
      headers: { 'x-api-key': bootstrapAdminKey },
    })
  })

  test('admin-tier: cannot revoke the key authenticating the request', async () => {
    // Create a separate admin key, use it to authenticate, try to revoke
    // itself — should 409.
    const created = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'self-revoke-test', scopes: ['admin'] }),
    })
    expect(created.statusCode).toBe(201)
    const { id, plaintext } = JSON.parse(created.payload)

    const r = await fastify.inject({
      method: 'DELETE', url: `/admin/api-keys/${id}`,
      headers: { 'x-api-key': plaintext },
    })
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.payload).message).toMatch(/currently being used/)

    // Cleanup — revoke with the bootstrap admin key.
    await fastify.inject({
      method: 'DELETE', url: `/admin/api-keys/${id}`,
      headers: { 'x-api-key': bootstrapAdminKey },
    })
  })

  test('admin-tier: PATCH updates scopes', async () => {
    const created = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'patch-test', scopes: ['read'] }),
    })
    const { id } = JSON.parse(created.payload)

    const patched = await fastify.inject({
      method: 'PATCH', url: `/admin/api-keys/${id}`,
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ scopes: ['write'] }),
    })
    expect(patched.statusCode).toBe(200)
    expect(JSON.parse(patched.payload).scopes).toEqual(['write'])

    // Cleanup.
    await fastify.inject({
      method: 'DELETE', url: `/admin/api-keys/${id}`,
      headers: { 'x-api-key': bootstrapAdminKey },
    })
  })

  test('rotating the bootstrap env var refreshes the row hash', async () => {
    // Simulate rotation by changing the env value and re-running just the
    // bootstrap section of the plugin (in real deployment this happens
    // on the next process restart). We do it by re-importing the plugin
    // and registering it on a fresh fastify instance.
    const rotatedKey = generateKey()
    process.env.APPCLOUD_API_KEY = rotatedKey

    const f2 = Fastify({
      logger: false,
      ajv: { customOptions: { strict: false, keywords: ['example', 'xml'] } },
    })
    const sensible = (await import('@fastify/sensible')).default
    await f2.register(sensible)
    f2.decorate('pg', {
      pool:  pgClient,
      query: async (sql, params = []) => (await pgClient.query(sql, params)).rows,
    })
    const { authPlugin } = await import('../../plugins/auth.js')
    await authPlugin(f2)
    f2.get('/whoami', async (req) => ({ name: req.principal?.name, scopes: req.principal?.scopes }))
    await f2.ready()

    // Old key should now be invalid.
    let r = await f2.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': bootstrapKey },
    })
    expect(r.statusCode).toBe(401)

    // New key should work and resolve to the same name (bootstrap-api-key).
    r = await f2.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': rotatedKey },
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.payload).name).toBe('bootstrap-api-key')

    await f2.close()

    // Restore for any subsequent test that runs in the same suite.
    process.env.APPCLOUD_API_KEY = bootstrapKey
  })
})
