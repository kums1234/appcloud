// Tests for plugins/tenant-context.js — req.tenant resolution from
// req.principal, status handling, and the X-Tenant-Slug super-admin
// override.
//
// We mount the plugin against a stub fastify with a hand-rolled
// fastify.pg, then exercise resolveTenant by registering a probe
// route that echoes req.tenant back as JSON. Auth is disabled
// (no bootstrap keys) so authenticate produces an anonymous
// super-admin principal — except where a test overrides req.principal
// in a route preHandler to simulate a non-super-admin key.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiSrc    = path.resolve(__dirname, '..', '..')

const TENANT_DEFAULT = {
  id:             '00000000-0000-0000-0000-000000000001',
  slug:           'default',
  display_name:   'Default tenant',
  status:         'active',
  schema_name:    'public',
  neo4j_database: 'tenant_default',
  created_at:     new Date().toISOString(),
  created_by:     'bootstrap',
  metadata:       {},
}
// Acme uses schema='public' in the test fixtures so the principal-bound
// resolution + super-admin override tests reach the handler. A dedicated
// fixture (TENANT_NEW below) covers the Phase 1a 503 guard for tenants
// whose schema differs from 'public'.
const TENANT_ACME = {
  id:             '00000000-0000-0000-0000-000000000002',
  slug:           'acme-corp',
  display_name:   'Acme Corp',
  status:         'active',
  schema_name:    'public',
  neo4j_database: 'tenant_acme',
  created_at:     new Date().toISOString(),
  created_by:     'admin',
  metadata:       {},
}
const TENANT_NEW = {
  id:             '00000000-0000-0000-0000-000000000005',
  slug:           'new-tenant',
  display_name:   'New tenant (Phase 1b pending)',
  status:         'active',
  schema_name:    'tenant_new',
  neo4j_database: 'tenant_new',
  created_at:     new Date().toISOString(),
  created_by:     'admin',
  metadata:       {},
}
const TENANT_SUSPENDED = { ...TENANT_ACME, id: '00000000-0000-0000-0000-000000000003', slug: 'paused', schema_name: 'tenant_paused', status: 'suspended' }
const TENANT_DOOMED    = { ...TENANT_ACME, id: '00000000-0000-0000-0000-000000000004', slug: 'doomed', schema_name: 'tenant_doomed', status: 'pending_delete' }

function makeStubPg(rows) {
  return {
    pool:        {},
    query:       async (sql) => {
      // Return tenant rows for the loadTenantsFromDb query. Other
      // queries (auth plugin's CREATE_TABLE_SQL, default-tenant
      // lookup, key cache) get an empty array which is fine.
      if (/FROM control\.tenants$/m.test(sql.trim())) return rows
      return []
    },
    audit:       async () => {},
    ping:        async () => true,
    auditBuffer: { pending: () => 0, stats: () => ({}) },
  }
}

async function build({ tenantRows, principal } = {}) {
  delete process.env.APPCLOUD_API_KEY
  delete process.env.APPCLOUD_ADMIN_API_KEY
  delete process.env.APPCLOUD_SUPER_ADMIN_API_KEY
  delete process.env.APPCLOUD_API_KEY_FILE
  delete process.env.APPCLOUD_ADMIN_API_KEY_FILE
  delete process.env.APPCLOUD_SUPER_ADMIN_API_KEY_FILE
  process.env.APPCLOUD_AUTH_DISABLED_WARN_MS = '0'

  const fastify = Fastify({ logger: false })
  const sensible = (await import('@fastify/sensible')).default
  await fastify.register(sensible)

  fastify.decorate('pg', makeStubPg(tenantRows || [TENANT_DEFAULT, TENANT_ACME, TENANT_NEW, TENANT_SUSPENDED, TENANT_DOOMED]))

  const { authPlugin } = await import(path.join(apiSrc, 'plugins/auth.js'))
  await authPlugin(fastify)

  const { tenantContextPlugin } = await import(path.join(apiSrc, 'plugins/tenant-context.js'))
  await tenantContextPlugin(fastify)

  // Probe route — echoes req.tenant + req.principal so the test can
  // assert on resolution behaviour. principal-override hook runs after
  // authenticate (prepended) so each test can pin a specific principal.
  fastify.get('/_probe', {
    preHandler: async (req) => {
      if (principal) req.principal = principal
    },
  }, async (req) => ({
    tenant: req.tenant
      ? { id: req.tenant.id, slug: req.tenant.slug, schemaName: req.tenant.schemaName, neo4jDatabase: req.tenant.neo4jDatabase, status: req.tenant.status }
      : null,
    principal: { name: req.principal?.name, scopes: req.principal?.scopes, tenantId: req.principal?.tenantId },
  }))

  await fastify.ready()
  return fastify
}

describe('tenantContextPlugin — principal-bound resolution', () => {
  let fastify
  beforeAll(async () => {
    fastify = await build({
      principal: {
        id: 'k1', name: 'tenant-key', scopes: ['admin'], prefix: 'ak_aa',
        tenantId: TENANT_ACME.id,
      },
    })
  })
  afterAll(async () => { await fastify?.close() })

  test('resolves req.tenant from principal.tenantId', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/_probe' })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.tenant.slug).toBe('acme-corp')
    // schema_name is 'public' in the fixture (Phase 1a test setup);
    // a real Phase 1+ tenant would have schema='tenant_<id>'.
    expect(body.tenant.schemaName).toBe('public')
    expect(body.tenant.neo4jDatabase).toBe('tenant_acme')
  })

  test('non-super-admin: X-Tenant-Slug is ignored, principal binding wins', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/_probe',
      headers: { 'x-tenant-slug': 'default' },
    })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    // Header asks for default, principal is bound to acme-corp — acme wins.
    expect(body.tenant.slug).toBe('acme-corp')
  })
})

describe('tenantContextPlugin — super-admin override', () => {
  let fastify
  beforeAll(async () => {
    fastify = await build({
      principal: {
        id: 'sk', name: 'super-key', scopes: ['super-admin'], prefix: 'ak_zz',
        tenantId: TENANT_DEFAULT.id,
      },
    })
  })
  afterAll(async () => { await fastify?.close() })

  test('without header: falls back to principal.tenantId', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/_probe' })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.tenant.slug).toBe('default')
  })

  test('with X-Tenant-Slug: resolves the named tenant', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/_probe',
      headers: { 'x-tenant-slug': 'acme-corp' },
    })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.tenant.slug).toBe('acme-corp')
  })

  test('rejects malformed slug header with 400', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/_probe',
      headers: { 'x-tenant-slug': 'BAD SLUG!!' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toMatch(/not a valid slug/)
  })

  test('returns 404 for unknown slug', async () => {
    const r = await fastify.inject({
      method: 'GET', url: '/_probe',
      headers: { 'x-tenant-slug': 'no-such-tenant' },
    })
    expect(r.statusCode).toBe(404)
    expect(r.body).toMatch(/not found/)
  })
})

describe('tenantContextPlugin — Phase 1a non-default-tenant guard', () => {
  test('non-default tenant 503s with a Phase-1b explanation', async () => {
    const fastify = await build({
      principal: {
        id: 'k', name: 'tenant-key', scopes: ['admin'], prefix: 'ak_aa',
        // TENANT_NEW.schema_name === 'tenant_new', NOT 'public' — triggers
        // the Phase 1a guard.
        tenantId: TENANT_NEW.id,
      },
    })
    try {
      const r = await fastify.inject({ method: 'GET', url: '/_probe' })
      expect(r.statusCode).toBe(503)
      expect(r.body).toMatch(/data isolation is pending/)
      expect(r.body).toMatch(/Phase 1b/)
    } finally {
      await fastify.close()
    }
  })

  test('default tenant (schema=public) passes through to the handler', async () => {
    const fastify = await build({
      principal: {
        id: 'k', name: 'tenant-key', scopes: ['admin'], prefix: 'ak_aa',
        tenantId: TENANT_DEFAULT.id,
      },
    })
    try {
      const r = await fastify.inject({ method: 'GET', url: '/_probe' })
      expect(r.statusCode).toBe(200)
      const body = JSON.parse(r.body)
      expect(body.tenant.slug).toBe('default')
      expect(body.tenant.schemaName).toBe('public')
    } finally {
      await fastify.close()
    }
  })
})

describe('tenantContextPlugin — status gating', () => {
  test('suspended tenant produces 423 Locked', async () => {
    const fastify = await build({
      principal: {
        id: 'k', name: 'tenant-key', scopes: ['admin'], prefix: 'ak_aa',
        tenantId: TENANT_SUSPENDED.id,
      },
    })
    try {
      const r = await fastify.inject({ method: 'GET', url: '/_probe' })
      expect(r.statusCode).toBe(423)
      expect(r.body).toMatch(/suspended/)
    } finally {
      await fastify.close()
    }
  })

  test('pending_delete tenant produces 410 Gone', async () => {
    const fastify = await build({
      principal: {
        id: 'k', name: 'tenant-key', scopes: ['admin'], prefix: 'ak_aa',
        tenantId: TENANT_DOOMED.id,
      },
    })
    try {
      const r = await fastify.inject({ method: 'GET', url: '/_probe' })
      expect(r.statusCode).toBe(410)
      expect(r.body).toMatch(/pending deletion/)
    } finally {
      await fastify.close()
    }
  })

  test('principal.tenantId pointing at a missing row produces 401', async () => {
    const fastify = await build({
      principal: {
        id: 'k', name: 'tenant-key', scopes: ['admin'], prefix: 'ak_aa',
        tenantId: '99999999-9999-9999-9999-999999999999',
      },
    })
    try {
      const r = await fastify.inject({ method: 'GET', url: '/_probe' })
      expect(r.statusCode).toBe(401)
      expect(r.body).toMatch(/no longer exists/)
    } finally {
      await fastify.close()
    }
  })
})
