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
    await applyPostgresInitFiles(pgClient, ['01-schema.sql', '10-api-keys.sql', '11-audit-evolution.sql'])

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

    // Register the audit query routes too — needed for the audit-filter
    // integration tests that exercise the new actor_key_id / actor_scope
    // exposure + the ?keyId= / ?scope= filters.
    const { default: auditRoutes } = await import('../../routes/audit.js')
    await fastify.register(auditRoutes, { prefix: '/audit' })

    // Audit-emitter route — used by the audit-attribution test to write a
    // real audit_log row from inside an authenticated request, exercising
    // the actorFromReq → pg.audit pipeline. Registered here (before
    // ready()) because Fastify rejects route additions post-listen.
    const { actorFromReq } = await import('../../utils/audit.js')
    fastify.post('/audit-emitter', async (req) => {
      const a = actorFromReq(req)
      await pgClient.query(
        `INSERT INTO audit_log(actor, actor_key_id, actor_scope, action, resource_type, resource_id)
         VALUES ($1, $2, $3, 'test-emit', 'TestResource', 'test-id')`,
        [a.name, a.keyId, a.scope],
      )
      return { ok: true }
    })
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

  test('expiresAt: future expiry works, past expiry rejects, NULL = never', async () => {
    // Create three keys spanning the expiry-state matrix.
    //
    // Future-expiry timestamp: pin to "now + 1 hour" rather than +60s.
    // The +60s window was too tight against clock skew on slow CI
    // runners — the cache TTL alone is 50ms and the test does several
    // injections + DB roundtrips before reading the key back. An hour
    // is well outside any realistic skew + the rest of the test runs
    // synchronously enough that the key is still in its valid window
    // when the assertions fire.
    const ONE_HOUR_MS = 60 * 60 * 1000
    const futureCreate = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name:      'expiry-future',
        scopes:    ['read'],
        expiresAt: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
      }),
    })
    expect(futureCreate.statusCode).toBe(201)
    const future = JSON.parse(futureCreate.payload)
    expect(future.expires_at).toBeTruthy()

    // Create-time validation: expiresAt in the past → 400.
    const pastCreate = await fastify.inject({
      method: 'POST', url: '/admin/api-keys',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name:      'expiry-past-attempt',
        scopes:    ['read'],
        expiresAt: '2000-01-01T00:00:00Z',
      }),
    })
    expect(pastCreate.statusCode).toBe(400)
    expect(JSON.parse(pastCreate.payload).message).toMatch(/in the future/)

    // Future key works.
    let r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': future.plaintext },
    })
    expect(r.statusCode).toBe(200)

    // Force-expire it via PATCH (with a past expires_at) and verify it
    // stops working immediately — the per-request expiry guard catches
    // it without waiting for the cache to refresh.
    const patched = await fastify.inject({
      method: 'PATCH', url: `/admin/api-keys/${future.id}`,
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ expiresAt: '2000-01-01T00:00:00Z' }),
    })
    expect(patched.statusCode).toBe(200)
    expect(new Date(JSON.parse(patched.payload).expires_at) < new Date()).toBe(true)

    // Wait a tick for the cache invalidation kicked by PATCH to land,
    // then try the expired key.
    await new Promise(r => setTimeout(r, 80))
    r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': future.plaintext },
    })
    expect(r.statusCode).toBe(401)

    // PATCH back to NULL re-enables.
    await fastify.inject({
      method: 'PATCH', url: `/admin/api-keys/${future.id}`,
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ expiresAt: null }),
    })
    await new Promise(r => setTimeout(r, 80))
    r = await fastify.inject({
      method: 'GET', url: '/whoami',
      headers: { 'x-api-key': future.plaintext },
    })
    expect(r.statusCode).toBe(200)

    // Cleanup.
    await fastify.inject({
      method: 'DELETE', url: `/admin/api-keys/${future.id}`,
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

  test('audit row records actor_key_id + actor_scope when principal is set', async () => {
    // /audit-emitter is registered in beforeAll. Each call writes a row
    // built from actorFromReq(req), so this test verifies the end-to-end
    // path: auth plugin → req.principal → actorFromReq → audit_log
    // columns.
    const r = await fastify.inject({
      method: 'POST', url: '/audit-emitter',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(r.statusCode).toBe(200)

    const rows = await pgClient.query(`
      SELECT actor, actor_key_id, actor_scope
      FROM audit_log
      WHERE action = 'test-emit'
      ORDER BY created_at DESC
      LIMIT 1
    `)
    expect(rows.rows[0].actor).toBe('bootstrap-admin-key')
    expect(rows.rows[0].actor_scope).toBe('admin')
    expect(rows.rows[0].actor_key_id).toBeTruthy()                    // a real UUID

    // The recorded actor_key_id matches the api_keys row.
    const keyRow = await pgClient.query(
      `SELECT id FROM api_keys WHERE name = 'bootstrap-admin-key'`,
    )
    expect(rows.rows[0].actor_key_id).toBe(keyRow.rows[0].id)
  })

  test('GET /audit rows expose actorKeyId + actorScope', async () => {
    // Emit a fresh row so we have something to query.
    await fastify.inject({
      method: 'POST', url: '/audit-emitter',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: '{}',
    })
    const r = await fastify.inject({
      method: 'GET', url: '/audit?action=test-emit&pageSize=5',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.payload)
    expect(body.rows.length).toBeGreaterThan(0)
    const row = body.rows[0]
    expect(row.actor).toBe('bootstrap-admin-key')
    expect(row.actorScope).toBe('admin')
    expect(row.actorKeyId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('GET /audit?keyId= filters by actor_key_id', async () => {
    // Emit a couple of rows under the bootstrap admin key.
    await fastify.inject({
      method: 'POST', url: '/audit-emitter',
      headers: { 'x-api-key': bootstrapAdminKey, 'content-type': 'application/json' },
      payload: '{}',
    })
    // Find the bootstrap admin key's id.
    const adminRows = await pgClient.query(
      `SELECT id FROM api_keys WHERE name = 'bootstrap-admin-key'`,
    )
    const adminKeyId = adminRows.rows[0].id

    const matched = await fastify.inject({
      method: 'GET', url: `/audit?keyId=${adminKeyId}&pageSize=5`,
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(matched.statusCode).toBe(200)
    const matchedBody = JSON.parse(matched.payload)
    expect(matchedBody.rows.length).toBeGreaterThan(0)
    for (const row of matchedBody.rows) expect(row.actorKeyId).toBe(adminKeyId)

    // A bogus UUID returns zero rows but still 200.
    const empty = await fastify.inject({
      method: 'GET', url: '/audit?keyId=00000000-0000-0000-0000-000000000000',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(empty.statusCode).toBe(200)
    expect(JSON.parse(empty.payload).rows).toEqual([])
  })

  test('GET /audit?scope=admin filters by actor_scope', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/audit?scope=admin&pageSize=5',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.payload)
    for (const row of body.rows) expect(row.actorScope).toBe('admin')
  })

  test('GET /audit?scope=garbage returns 400', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/audit?scope=garbage',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(r.statusCode).toBe(400)
  })

  test('GET /audit?actor=… is exact-match by default; ?like=true opts into substring', async () => {
    // Insert two rows with similar but distinct actor names.
    await pgClient.query(`
      INSERT INTO audit_log (actor, action, resource_type, resource_id) VALUES
        ('ci-deploy-staging', 'test-actor-match', 'TestRow', 'a1'),
        ('ci-deploy-prod',    'test-actor-match', 'TestRow', 'a2')
    `)

    // Exact (default) — only the prefix-name row matches.
    const exact = await fastify.inject({
      method: 'GET', url: '/audit?actor=ci-deploy-staging&action=test-actor-match',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(exact.statusCode).toBe(200)
    const exactBody = JSON.parse(exact.payload)
    expect(exactBody.rows.length).toBe(1)
    expect(exactBody.rows[0].actor).toBe('ci-deploy-staging')

    // Opt-in substring — both rows match.
    const sub = await fastify.inject({
      method: 'GET', url: '/audit?actor=ci-deploy&like=true&action=test-actor-match',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(sub.statusCode).toBe(200)
    const subBody = JSON.parse(sub.payload)
    expect(subBody.rows.length).toBe(2)
    const actors = subBody.rows.map(r => r.actor).sort()
    expect(actors).toEqual(['ci-deploy-prod', 'ci-deploy-staging'])
  })

  test('GET /audit/actor/:name is exact by default; ?like=true returns substring matches', async () => {
    // The fixtures from the previous test are still in the DB.
    const exact = await fastify.inject({
      method: 'GET', url: '/audit/actor/ci-deploy-staging',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(exact.statusCode).toBe(200)
    const exactBody = JSON.parse(exact.payload)
    expect(exactBody.rows.every(r => r.actor === 'ci-deploy-staging')).toBe(true)

    const sub = await fastify.inject({
      method: 'GET', url: '/audit/actor/ci-deploy?like=true',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(sub.statusCode).toBe(200)
    const subBody = JSON.parse(sub.payload)
    expect(subBody.rows.length).toBeGreaterThanOrEqual(2)
  })

  test('GET /audit/stats topActors groups by (actor_key_id, actor)', async () => {
    // Insert two rows for the same actor name but different key_ids — they
    // should surface as two separate topActors entries, not one collapsed.
    const fakeKeyA = '11111111-1111-1111-1111-111111111111'
    const fakeKeyB = '22222222-2222-2222-2222-222222222222'
    // We need real api_keys rows for the FK; create two with the same display
    // name is blocked by the UNIQUE(name) constraint on api_keys, so simulate
    // the collision by inserting audit_log rows directly with NULL/non-NULL
    // key_ids under the same display name. The grouping should still split.
    await pgClient.query(`
      INSERT INTO audit_log (actor, actor_key_id, action, resource_type, resource_id) VALUES
        ('shared-name', NULL, 'topactors-fixture', 'TestRow', 's1'),
        ('shared-name', NULL, 'topactors-fixture', 'TestRow', 's2'),
        ('shared-name', NULL, 'topactors-fixture', 'TestRow', 's3')
    `)
    // Real key + same display-name fixture (write rows under bootstrap-admin).
    const adminKeyRow = await pgClient.query(
      `SELECT id FROM api_keys WHERE name = 'bootstrap-admin-key'`,
    )
    const adminKeyId = adminKeyRow.rows[0].id
    await pgClient.query(`
      INSERT INTO audit_log (actor, actor_key_id, action, resource_type, resource_id) VALUES
        ('shared-name', $1, 'topactors-fixture', 'TestRow', 's4'),
        ('shared-name', $1, 'topactors-fixture', 'TestRow', 's5')
    `, [adminKeyId])

    const r = await fastify.inject({
      method: 'GET', url: '/audit/stats?days=1',
      headers: { 'x-api-key': bootstrapAdminKey },
    })
    expect(r.statusCode).toBe(200)
    const stats = JSON.parse(r.payload)

    const sharedRows = stats.topActors.filter(a => a.actor === 'shared-name')
    // Two rows: one with NULL actorKeyId (3 events) and one with the admin
    // key id (2 events). Confirm the split + that actorKeyId is exposed.
    expect(sharedRows.length).toBe(2)
    const nullKeyEntry = sharedRows.find(a => a.actorKeyId === null)
    const realKeyEntry = sharedRows.find(a => a.actorKeyId === adminKeyId)
    expect(nullKeyEntry?.count).toBe(3)
    expect(realKeyEntry?.count).toBe(2)
  })

  test('X-Actor header on an authenticated request is ignored + warned', async () => {
    // The principal is determined by the API key (bootstrap-admin-key),
    // not by the X-Actor header. Verify (a) the audit row records the
    // principal, (b) the X-Actor value does NOT leak into actor.
    //
    // The req.log.warn that fires alongside is the operator-facing
    // signal; we don't assert on log output here (the test fastify uses
    // logger:false), but the audit-row check is the load-bearing part.
    const r = await fastify.inject({
      method: 'POST', url: '/audit-emitter',
      headers: {
        'x-api-key':   bootstrapAdminKey,
        'x-actor':     'imposter@evil.test',
        'content-type': 'application/json',
      },
      payload: '{}',
    })
    expect(r.statusCode).toBe(200)

    const rows = await pgClient.query(`
      SELECT actor, actor_key_id
      FROM audit_log
      WHERE action = 'test-emit'
      ORDER BY created_at DESC
      LIMIT 1
    `)
    expect(rows.rows[0].actor).toBe('bootstrap-admin-key')
    expect(rows.rows[0].actor).not.toBe('imposter@evil.test')
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
