// plugins/tenant-context.js
//
// Resolves the request's tenant from `req.principal` (set by the auth
// plugin) and attaches it as `req.tenant`. Runs after `authenticate` on
// every non-public route.
//
// ── Resolution rules ─────────────────────────────────────────────────────────
// 1. Regular keys (read / write / admin scope): tenant comes from
//    `principal.tenantId`. The X-Tenant-Slug header is ignored — a tenant-
//    scoped key cannot impersonate another tenant.
//
// 2. super-admin keys: if X-Tenant-Slug is present, resolve that slug.
//    Otherwise fall back to `principal.tenantId` (typically the default
//    tenant for env-var-bootstrapped keys). This lets a super-admin
//    operate inside a specific tenant for ad-hoc work.
//
// 3. Open-auth (no keys configured, local dev only): principal.tenantId
//    is the default tenant if it exists. X-Tenant-Slug works as for
//    super-admin since open-auth grants super-admin scope.
//
// ── Status handling ──────────────────────────────────────────────────────────
// suspended       → 423 Locked
// pending_delete  → 410 Gone
// missing tenant  → 401 (key references a tenant row that no longer exists —
//                  treat as an invalid credential, not a server error)
//
// ── Cache ────────────────────────────────────────────────────────────────────
// Tenants change rarely. We hold a small in-process cache keyed by id +
// slug, refreshed lazily when older than CACHE_TTL_MS. /admin/tenants
// mutations bump `fastify.tenantCache.refreshedAt = 0` so changes take
// effect immediately rather than after TTL.

import { hasScope, SCOPES } from '../utils/api-keys.js'

const CACHE_TTL_MS = parseInt(process.env.APPCLOUD_TENANT_CACHE_TTL_MS || '60000', 10)

// Slug pattern enforced at the API surface (admin-tenants.js); duplicated
// here as a defense-in-depth check on the X-Tenant-Slug header so a
// malformed header value can't drive the cache key into pathological
// shapes (very long strings, control chars, etc.).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function isPublicRoute(routeOptions) {
  return Array.isArray(routeOptions.schema?.security)
      && routeOptions.schema.security.length === 0
}

function attachPreHandler(routeOptions, handler) {
  const existing = routeOptions.preHandler
  if (existing === handler) return
  if (Array.isArray(existing)) {
    if (existing.includes(handler)) return
    routeOptions.preHandler = [...existing, handler]
  } else if (existing) {
    routeOptions.preHandler = [existing, handler]
  } else {
    routeOptions.preHandler = handler
  }
}

function makeTenantCache() {
  return {
    byId:        new Map(),
    bySlug:      new Map(),
    refreshedAt: 0,
    error:       null,
  }
}

async function loadTenantsFromDb(pg) {
  const rows = await pg.query(`
    SELECT id, slug, display_name, status, schema_name, neo4j_database,
           created_at, created_by, metadata
    FROM control.tenants
  `)
  const byId   = new Map()
  const bySlug = new Map()
  for (const r of rows) {
    const tenant = {
      id:            r.id,
      slug:          r.slug,
      displayName:   r.display_name,
      status:        r.status,
      schemaName:    r.schema_name,
      neo4jDatabase: r.neo4j_database,
      createdAt:     r.created_at,
      createdBy:     r.created_by,
      metadata:      r.metadata,
    }
    byId.set(r.id, tenant)
    bySlug.set(r.slug, tenant)
  }
  return { byId, bySlug }
}

async function refreshIfStale(cache, pg, log) {
  if (Date.now() - cache.refreshedAt < CACHE_TTL_MS) return
  try {
    const { byId, bySlug } = await loadTenantsFromDb(pg)
    cache.byId        = byId
    cache.bySlug      = bySlug
    cache.refreshedAt = Date.now()
    cache.error       = null
  } catch (err) {
    cache.error = err
    log?.error?.({ err }, '[tenant-context] failed to refresh tenants — serving from last good snapshot')
  }
}

export async function tenantContextPlugin(fastify) {
  const pg = fastify.pg
  if (!pg?.query) {
    fastify.log.error('[tenant-context] fastify.pg.query unavailable — tenant resolution disabled')
    throw new Error('tenantContextPlugin requires fastify.pg')
  }

  const cache = makeTenantCache()
  await refreshIfStale(cache, pg, fastify.log)
  fastify.decorate('tenantCache', cache)

  const resolveTenant = async (req, reply) => {
    // authenticate must have run first. If it didn't (a route flagged
    // public, or a misconfigured route bypass), there's nothing to
    // resolve and req.tenant stays unset.
    if (!req.principal) return

    const isSuperAdmin = hasScope(req.principal.scopes, SCOPES.SUPER_ADMIN)
    const headerSlug   = (req.headers['x-tenant-slug'] || '').trim().toLowerCase()

    // Skip the cache refresh entirely when there's nothing to look up.
    // Super-admin requests to control-plane routes (no header, no
    // tenant binding) don't need a tenant — refreshing the cache would
    // be wasted DB I/O on every request to /admin/tenants.
    if (!req.principal.tenantId && !(isSuperAdmin && headerSlug)) return

    await refreshIfStale(cache, pg, fastify.log)

    let tenant = null
    if (isSuperAdmin && headerSlug) {
      // Super-admin override via header — slug must look right before we
      // even hit the cache, so a junk header doesn't pollute the lookup.
      if (!SLUG_RE.test(headerSlug)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `X-Tenant-Slug '${headerSlug}' is not a valid slug`,
        })
      }
      tenant = cache.bySlug.get(headerSlug)
      if (!tenant) {
        return reply.code(404).send({
          error: 'Not Found',
          message: `tenant '${headerSlug}' not found`,
        })
      }
    } else if (req.principal.tenantId) {
      tenant = cache.byId.get(req.principal.tenantId)
      if (!tenant) {
        // Cache empty + DB unreachable → 503 so the operator sees the
        // real cause; otherwise the principal references a tenant row
        // that's been deleted (treat as a credential problem).
        if (cache.error && cache.byId.size === 0) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'tenant backend unavailable',
          })
        }
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'API key references a tenant that no longer exists',
        })
      }
    }

    if (tenant) {
      if (tenant.status === 'suspended') {
        return reply.code(423).send({
          error: 'Locked',
          message: `tenant '${tenant.slug}' is suspended`,
        })
      }
      if (tenant.status === 'pending_delete') {
        return reply.code(410).send({
          error: 'Gone',
          message: `tenant '${tenant.slug}' is pending deletion`,
        })
      }
      // Phase 1a guard: data routes only work for the default tenant
      // (whose schema is still `public`). Non-default tenants exist as
      // metadata + provisioned schemas, but the per-request search_path
      // mechanism that makes their data reachable lands in Phase 1b.
      // Until then, route requests to non-default tenants 503 with a
      // clear message so the failure mode is visible rather than
      // mixing tenants' data via the wrong search_path.
      //
      // Control-plane routes (/admin/tenants*) are super-admin scope
      // and don't need a tenant resolved — they bypass this branch
      // because the super-admin-with-no-header path returned earlier
      // without setting tenant.
      if (tenant.schemaName !== 'public') {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message:
            `tenant '${tenant.slug}' data isolation is pending — Phase 1b will wire ` +
            `the per-request search_path. The tenant exists and its schema is provisioned, ` +
            `but data routes will not return its data until that work lands.`,
        })
      }
      req.tenant = tenant
    }
    // No tenant resolved (super-admin without header, no principal.tenantId):
    // leave req.tenant undefined. Tenant-scoped routes must check and
    // 400/403 when they need a tenant; control-plane routes (admin/tenants)
    // operate fine without one.
  }

  fastify.decorate('resolveTenant', resolveTenant)

  fastify.addHook('onRoute', (routeOptions) => {
    if (isPublicRoute(routeOptions)) return
    attachPreHandler(routeOptions, resolveTenant)
  })

  fastify.log.info(
    `[tenant-context] active — ${cache.byId.size} tenant(s) in cache`,
  )
}
