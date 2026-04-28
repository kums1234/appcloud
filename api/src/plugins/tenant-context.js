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

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasScope, SCOPES } from '../utils/api-keys.js'
import { applyMigrations } from '../utils/tenant-schema-runner.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Per-tenant template migrations live alongside the source. Same
// constant lives in routes/admin-tenants.js — keep them in sync.
const TENANT_MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations', 'tenant-schema')

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

// Idempotent default-tenant cutover. Mirrors
// postgres-init/{15,16}-*-cutover.sql so a deployment that didn't run
// init scripts (or pulled the migrations after a fresh boot) converges
// on next startup. Each step gates on "have we already done it?" so
// the SQL is safe to run repeatedly.
//
// The cutover moves the *default* tenant's data tables from `public`
// into `tenant_default` via `ALTER TABLE … SET SCHEMA`, then records a
// 'cutover' sentinel row in control.schema_migrations so the runner's
// re-migration sweep treats those template files as already-applied.
async function ensureDefaultTenantCutover(pg, log) {
  try {
    await pg.query(`CREATE SCHEMA IF NOT EXISTS tenant_default`)

    // Phase 1b: move cloud_accounts.
    await pg.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'cloud_accounts'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'tenant_default' AND table_name = 'cloud_accounts'
        ) THEN
          ALTER TABLE public.cloud_accounts SET SCHEMA tenant_default;
        END IF;
      END $$
    `)

    // Phase 1c: move integrations + sync_jobs together. The FK
    // sync_jobs.integration_id → integrations(id) preserves under
    // ALTER TABLE … SET SCHEMA (Postgres tracks FKs by OID, not by
    // schema-qualified name). Order doesn't matter, but moving the
    // referenced table first keeps the intermediate state cleaner.
    await pg.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'integrations'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'tenant_default' AND table_name = 'integrations'
        ) THEN
          ALTER TABLE public.integrations SET SCHEMA tenant_default;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'sync_jobs'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'tenant_default' AND table_name = 'sync_jobs'
        ) THEN
          ALTER TABLE public.sync_jobs SET SCHEMA tenant_default;
        END IF;
      END $$
    `)

    // Phase 1d: move terraform_imports + ai_jobs + discovery_schedule.
    // All three are FK-free so they move independently.
    await pg.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'terraform_imports'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'tenant_default' AND table_name = 'terraform_imports'
        ) THEN
          ALTER TABLE public.terraform_imports SET SCHEMA tenant_default;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'ai_jobs'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'tenant_default' AND table_name = 'ai_jobs'
        ) THEN
          ALTER TABLE public.ai_jobs SET SCHEMA tenant_default;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'discovery_schedule'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'tenant_default' AND table_name = 'discovery_schedule'
        ) THEN
          ALTER TABLE public.discovery_schedule SET SCHEMA tenant_default;
        END IF;
      END $$
    `)

    await pg.query(`
      UPDATE control.tenants
         SET schema_name = 'tenant_default'
       WHERE slug = 'default'
         AND schema_name = 'public'
    `)

    // Phase 1d: audit_log gains a tenant_id column (NOT NULL, FK to
    // control.tenants). Backfill goes to the default tenant so
    // pre-cutover rows aren't lost. The table stays in `public` —
    // see postgres-init/17-audit-tenant-id.sql for rationale.
    await pg.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name   = 'audit_log'
             AND column_name  = 'tenant_id'
        ) THEN
          ALTER TABLE audit_log ADD COLUMN tenant_id UUID;
        END IF;
        UPDATE audit_log
           SET tenant_id = (SELECT id FROM control.tenants WHERE slug = 'default')
         WHERE tenant_id IS NULL;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name   = 'audit_log'
             AND column_name  = 'tenant_id'
             AND is_nullable  = 'YES'
        ) THEN
          ALTER TABLE audit_log ALTER COLUMN tenant_id SET NOT NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_tenant_fk'
        ) THEN
          ALTER TABLE audit_log
            ADD CONSTRAINT audit_log_tenant_fk
              FOREIGN KEY (tenant_id) REFERENCES control.tenants(id)
              ON DELETE RESTRICT;
        END IF;
      END $$
    `)
    await pg.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created_at
        ON audit_log (tenant_id, created_at DESC)
    `)

    // Record cutover sentinels. The runner treats sha='cutover' as
    // already-applied (never recompares against the file content), so
    // the next sweep skips these for tenant_default.
    await pg.query(`
      INSERT INTO control.schema_migrations (schema_name, filename, sha256)
      VALUES
        ('tenant_default', '001-base-tables.sql',       'cutover'),
        ('tenant_default', '002-sync-jobs.sql',         'cutover'),
        ('tenant_default', '003-terraform-imports.sql', 'cutover'),
        ('tenant_default', '004-ai-jobs.sql',           'cutover'),
        ('tenant_default', '005-discovery-schedule.sql','cutover')
      ON CONFLICT (schema_name, filename) DO NOTHING
    `)
    log?.info?.('[tenant-context] default-tenant cutover ensured (1b + 1c)')
  } catch (err) {
    log?.error?.({ err }, '[tenant-context] cutover failed — leaving DB as-is, may need operator action')
  }
}

// Apply any unapplied template migrations to every active tenant
// schema on startup. Driven by control.schema_migrations: rows with
// `sha256 = 'cutover'` mean "already applied via SET SCHEMA, never
// re-run"; rows with a real sha mean the file was applied normally;
// missing rows trigger an apply.
//
// Each tenant runs in its own transaction so a failure on one (e.g. a
// migration that conflicts with manual operator changes) doesn't block
// other tenants. The runner already validates the schema name, so a
// pathological control.tenants row can't smuggle SQL.
async function runStartupReMigrationSweep(pg, log, migrationsDir) {
  let tenants
  try {
    tenants = await pg.query(`
      SELECT id, slug, schema_name FROM control.tenants
       WHERE status = 'active'
       ORDER BY created_at
    `)
  } catch (err) {
    log?.warn?.({ err: err.message }, '[tenant-context] re-migration sweep skipped — control.tenants unreadable')
    return
  }
  for (const t of tenants) {
    try {
      await pg.transaction(async (client) => {
        const applied = await applyMigrations({
          client,
          schemaName:    t.schema_name,
          migrationsDir,
          log,
        })
        if (applied.length > 0) {
          log?.info?.(
            { tenant: t.slug, schema: t.schema_name, applied: applied.length, files: applied },
            '[tenant-context] startup re-migration sweep applied new migrations',
          )
        }
      })
    } catch (err) {
      log?.error?.(
        { tenant: t.slug, schema: t.schema_name, err: err.message },
        '[tenant-context] re-migration failed for tenant — leaving as-is, manual intervention may be needed',
      )
    }
  }
}

export async function tenantContextPlugin(fastify) {
  const pg = fastify.pg
  if (!pg?.query) {
    fastify.log.error('[tenant-context] fastify.pg.query unavailable — tenant resolution disabled')
    throw new Error('tenantContextPlugin requires fastify.pg')
  }

  // Bring existing deployments forward without operator intervention:
  // run the idempotent default-tenant cutover (1b + 1c moves), then
  // sweep all active tenants and apply any unapplied template migrations.
  // pg.transaction is required for the sweep — fall through silently if
  // the postgres plugin isn't fully wired (e.g. test setups with a
  // bare stub that decorates only .query / .pool).
  await ensureDefaultTenantCutover(pg, fastify.log)
  if (typeof pg.transaction === 'function') {
    await runStartupReMigrationSweep(pg, fastify.log, TENANT_MIGRATIONS_DIR)
  } else {
    fastify.log.debug?.('[tenant-context] pg.transaction unavailable — skipping startup re-migration sweep')
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
      // Phase 1b guard: data routes route through the per-request
      // search_path mechanism for the default tenant only. Non-default
      // tenants have provisioned schemas with the *minimal* template
      // (integrations + cloud_accounts) but lack the rest of the
      // per-tenant table set; queries against missing tables would
      // either fail or — worse — fall through search_path to `public`
      // and read another tenant's data. Phase 1c expands the template
      // to cover all tables and lifts this guard.
      //
      // Control-plane routes (/admin/tenants*) are super-admin scope
      // and bypass this branch because super-admin-without-header
      // returns earlier without setting `tenant`.
      if (tenant.schemaName !== 'tenant_default') {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message:
            `tenant '${tenant.slug}' data isolation is partial — Phase 1c will expand ` +
            `the per-tenant template to cover all required tables. The tenant exists ` +
            `with a provisioned schema, but data routes are 503-gated until that work lands.`,
        })
      }
      req.tenant = tenant
      // Tenant-scoped pg surface: every query on req.pg opens a
      // connection with `SET LOCAL search_path = <tenant_schema>, public`
      // so unqualified table names resolve into the tenant's schema.
      // For multi-step atomicity, route handlers use req.pg.transaction(fn).
      if (typeof pg.forTenant === 'function') {
        req.pg = pg.forTenant(tenant.schemaName)
      }
      // Phase 1d: req.audit is the audit-write surface curried with
      // the request's tenant_id. Route handlers used to call
      // fastify.pg.audit(...).catch(); now they call
      // req.audit(...).catch() with the same arg shape minus the
      // tenant_id (the curry supplies it).
      if (typeof pg.auditFor === 'function') {
        req.audit = pg.auditFor(tenant.id)
      }
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
