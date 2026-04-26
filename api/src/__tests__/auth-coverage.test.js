// Auth coverage invariant — proves every route registered after
// authPlugin gets `fastify.authenticate` wired in as a preHandler
// unless the route's schema explicitly marks it public via OpenAPI's
// `security: []` override.
//
// This test is the structural counterpart to the per-handler unit tests:
// even if a future PR forgets `withAuth(...)` on a new route, the
// default-deny onRoute hook in plugins/auth.js will catch it, and this
// test will fail loudly if either the hook stops working or the
// "intentionally public" set grows beyond what's documented here.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiSrc    = path.resolve(__dirname, '..')

// Lock the exact set of routes that may stay public. Adding to this set
// is a deliberate decision that should require updating this snapshot.
// HEAD pairs are auto-created by Fastify for every GET route — they're
// listed here explicitly so the snapshot is faithful to the actual route
// table rather than glossing over them.
const ALLOWED_PUBLIC_ROUTES = new Set([
  'GET /',
  'HEAD /',
  'GET /health',
  'HEAD /health',
])

function hasAuthPreHandler(routeOptions, auth) {
  const ph = routeOptions.preHandler
  if (ph === auth) return true
  if (Array.isArray(ph) && ph.includes(auth)) return true
  return false
}

function hasAdminPreHandler(routeOptions, requireAdmin) {
  const ph = routeOptions.preHandler
  if (ph === requireAdmin) return true
  if (Array.isArray(ph) && ph.includes(requireAdmin)) return true
  return false
}

function isAdminRoute(routeOptions) {
  return routeOptions.config?.requireAdmin === true
}

function isPublicByConvention(routeOptions) {
  return Array.isArray(routeOptions.schema?.security)
      && routeOptions.schema.security.length === 0
}

async function buildAndCollect() {
  const prevKey = process.env.APPCLOUD_API_KEY
  // 32+ chars so the auth plugin's bootstrap-key length warn does not
  // fire on every test run (MIN_KEY_LEN in plugins/auth.js is 32).
  process.env.APPCLOUD_API_KEY = 'test-default-deny-key-padded-to-32ch'

  const fastify = Fastify({
    // Cap the test logger at silent rather than disabling it outright —
    // the auth plugin's req.log.warn for stray X-Actor headers is one of
    // the things we don't want leaking into test output, and capping the
    // level keeps that local to the logger config instead of relying on
    // a per-warning override at the call site.
    logger: { level: 'silent' },
    ajv: { customOptions: { strict: false, keywords: ['example', 'xml'] } },
  })

  // Same decorator stubs the export script + drift test use, so route
  // registration succeeds without real DB connections.
  fastify.decorate('pg',             { pool: null, query: async () => [], audit: async () => {} })
  fastify.decorate('neo4j',          { write: async () => [], query: async () => [] })
  fastify.decorate('ai',             { localAvailable: false, cloudAvailable: false })
  fastify.decorate('connectors',     { list: () => [], get: () => null })
  fastify.decorate('cmdbAssessment', { markDirty: () => {}, run: async () => ({}) })

  // Install authPlugin BEFORE the route modules so its onRoute hook fires
  // for every subsequent registration. This mirrors server.js.
  const { authPlugin } = await import(path.join(apiSrc, 'plugins/auth.js'))
  await authPlugin(fastify)

  // Test-side collector hook — runs after authPlugin's hook so it observes
  // the post-attachment state of routeOptions.preHandler.
  const collected = []
  fastify.addHook('onRoute', (routeOptions) => {
    const ph = Array.isArray(routeOptions.preHandler) ? routeOptions.preHandler : (routeOptions.preHandler ? [routeOptions.preHandler] : [])
    const scopeHandler = Object.entries(fastify.scopeHandlers || {}).find(([, fn]) => ph.includes(fn))
    collected.push({
      method:        routeOptions.method,
      url:           routeOptions.url,
      hasAuth:       hasAuthPreHandler(routeOptions, fastify.authenticate),
      isAdmin:       isAdminRoute(routeOptions),
      hasAdminGuard: hasAdminPreHandler(routeOptions, fastify.requireAdmin),
      isPublic:      isPublicByConvention(routeOptions),
      attachedScope: scopeHandler?.[0] ?? null,
      resolvedScope: routeOptions.config?._resolvedScope ?? null,
      explicitScope: routeOptions.config?.scope ?? null,
    })
  })

  const modules = [
    ['./routes/applications.js',            { prefix: '/applications' }],
    ['./routes/components.js',              { prefix: '/components'   }],
    ['./routes/infra.js',                   { prefix: '/infra'        }],
    ['./routes/graph.js',                   { prefix: '/graph'        }],
    ['./routes/integrations.js',            { prefix: '/integrations' }],
    ['./routes/integrations-cloud.js',      { prefix: '/integrations' }],
    ['./routes/integrations-ai.js',         { prefix: '/integrations' }],
    ['./routes/integrations.management.js', { prefix: '/integrations' }],
    ['./routes/discovery.js',               { prefix: '/discovery'    }],
    ['./routes/discovery.metadata.js',      { prefix: '/discovery'    }],
    ['./routes/audit.js',                   { prefix: '/audit'        }],
    ['./routes/cmdb.js',                    { prefix: '/cmdb'         }],
    ['./routes/ai.js',                      { prefix: '/ai'           }],
    ['./routes/admin-api-keys.js',          { prefix: '/admin'        }],
  ]
  for (const [rel, opts] of modules) {
    const mod = await import(path.join(apiSrc, rel))
    await fastify.register(mod.default, opts)
  }
  try {
    const m = await import(path.join(apiSrc, './routes/integrations.management.js'))
    if (m.connectorsRegistryRoutes) await fastify.register(m.connectorsRegistryRoutes, { prefix: '/connectors' })
  } catch {}

  // /health and / — match server.js.
  fastify.get('/health', { schema: { security: [] } }, async () => ({ status: 'ok' }))
  fastify.get('/',       { schema: { security: [] } }, async () => ({ name: 'AppCloud API' }))

  await fastify.ready()
  await fastify.close()

  if (prevKey === undefined) delete process.env.APPCLOUD_API_KEY
  else                       process.env.APPCLOUD_API_KEY = prevKey

  return collected
}

describe('Auth coverage — default-deny invariant', () => {
  let routes
  beforeAll(async () => { routes = await buildAndCollect() })

  test('every non-public route has the authenticate preHandler attached', () => {
    const violations = routes
      .filter(r => !r.isPublic && !r.hasAuth)
      .map(r => `${r.method} ${r.url}`)
    expect(violations).toEqual([])
  })

  test('public routes do NOT have authenticate attached (mutual exclusion)', () => {
    const violations = routes
      .filter(r => r.isPublic && r.hasAuth)
      .map(r => `${r.method} ${r.url}`)
    expect(violations).toEqual([])
  })

  test('the set of public routes is exactly the documented allowlist', () => {
    const publicSet = new Set(routes.filter(r => r.isPublic).map(r => `${r.method} ${r.url}`))
    const unexpected = [...publicSet].filter(k => !ALLOWED_PUBLIC_ROUTES.has(k))
    const missing    = [...ALLOWED_PUBLIC_ROUTES].filter(k => !publicSet.has(k))
    expect({ unexpected, missing }).toEqual({ unexpected: [], missing: [] })
  })

  test('admin-flagged routes have the requireAdmin preHandler attached', () => {
    const adminRoutes = routes.filter(r => r.isAdmin)
    expect(adminRoutes.length).toBeGreaterThan(0) // sanity — at least /audit/*
    const violations = adminRoutes
      .filter(r => !r.hasAdminGuard)
      .map(r => `${r.method} ${r.url}`)
    expect(violations).toEqual([])
  })

  test('every /audit route is admin-tier', () => {
    const auditRoutes = routes.filter(r => r.url.startsWith('/audit'))
    expect(auditRoutes.length).toBeGreaterThan(0)
    const notAdmin = auditRoutes
      .filter(r => !r.isAdmin)
      .map(r => `${r.method} ${r.url}`)
    expect(notAdmin).toEqual([])
  })

  test('every non-public route has exactly one scope handler attached', () => {
    const violations = routes
      .filter(r => !r.isPublic && !r.attachedScope)
      .map(r => `${r.method} ${r.url}`)
    expect(violations).toEqual([])
  })

  test('the attached scope matches the resolved scope per route', () => {
    const mismatches = routes
      .filter(r => !r.isPublic && r.attachedScope !== r.resolvedScope)
      .map(r => `${r.method} ${r.url}: attached=${r.attachedScope}, resolved=${r.resolvedScope}`)
    expect(mismatches).toEqual([])
  })

  test('GET / HEAD routes default to the read scope (unless overridden)', () => {
    const wrongDefaults = routes
      .filter(r => !r.isPublic && (r.method === 'GET' || r.method === 'HEAD'))
      .filter(r => !r.explicitScope && !r.isAdmin)            // exclude explicit overrides
      .filter(r => r.attachedScope !== 'read')
      .map(r => `${r.method} ${r.url}: attached=${r.attachedScope}`)
    expect(wrongDefaults).toEqual([])
  })

  test('mutation routes default to the write scope (unless overridden)', () => {
    const wrongDefaults = routes
      .filter(r => !r.isPublic && r.method !== 'GET' && r.method !== 'HEAD')
      .filter(r => !r.explicitScope && !r.isAdmin)            // exclude admin overrides
      .filter(r => r.attachedScope !== 'write')
      .map(r => `${r.method} ${r.url}: attached=${r.attachedScope}`)
    expect(wrongDefaults).toEqual([])
  })

  test('admin-flagged routes resolve to the admin scope', () => {
    const violations = routes
      .filter(r => r.isAdmin && r.attachedScope !== 'admin')
      .map(r => `${r.method} ${r.url}: attached=${r.attachedScope}`)
    expect(violations).toEqual([])
  })
})
