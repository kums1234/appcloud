// plugins/auth.js
// DB-backed multi-key authentication.
//
// Every API key lives as a row in the api_keys table (postgres-init/10-api-keys.sql).
// We store SHA-256(plaintext) and look up by hash on every request — the
// plaintext is shown ONCE at creation and never recoverable.
//
// ── Scopes ───────────────────────────────────────────────────────────────────
// Hierarchy: super-admin > admin > write > read.
//   - super-admin → cross-tenant ops: tenant CRUD, issuing keys for any
//                   tenant, cross-tenant admin queries. Not bound to a
//                   single tenant in the request flow.
//   - admin       → key management, audit log, debug routes within a tenant
//   - write       → mutations on resources (apps, components, infra, scans, …)
//   - read        → GET endpoints
// Per-route requirement comes from
// `config.scope: 'super-admin' | 'admin' | 'write' | 'read'`, or falls back
// to a method-based default (GET/HEAD → read, everything else → write).
//
// ── Bootstrap ────────────────────────────────────────────────────────────────
// On startup we upsert up to three rows from env vars (when set):
//   APPCLOUD_API_KEY{,_FILE}              → name='bootstrap-api-key'         scopes=['write']
//   APPCLOUD_ADMIN_API_KEY{,_FILE}        → name='bootstrap-admin-key'       scopes=['admin']
//   APPCLOUD_SUPER_ADMIN_API_KEY{,_FILE}  → name='bootstrap-super-admin-key' scopes=['super-admin']
// These are flagged is_bootstrap=true so future stages can refresh their
// hashes when the env value rotates without touching hand-created keys.
// All bootstrap keys bind to the tenant named by
// APPCLOUD_BOOTSTRAP_TENANT_SLUG (default: 'default'). super-admin keys
// are not tenant-scoped at the *request* level (they can act on any
// tenant via X-Tenant-Slug), but they still carry a tenant_id row in
// the DB to satisfy the api_keys.tenant_id NOT NULL constraint.
//
// ── Cache + DB unavailability ────────────────────────────────────────────────
// The hash → principal map is cached in memory and refreshed every CACHE_TTL_MS
// (default 60s). On a DB outage we keep serving from the last good snapshot,
// so a Postgres blip doesn't blackhole every request. If the cache is empty
// AND the DB is down, requests 503.
//
// ── Default-deny ─────────────────────────────────────────────────────────────
// The onRoute hook attaches `authenticate` to every route except those
// flagged `schema.security: []`, plus the per-scope handler resolved from
// `config.scope` (or the method-based default).

import fs from 'fs'
import { timingSafeEqual } from 'crypto'
import { hashKey, prefixOf, hasScope, SCOPES } from '../utils/api-keys.js'
import { warnIfLegacyKeyEnvSet } from '../utils/encrypt.js'

// Constant-time hex-string comparison. Both inputs are SHA-256 hex
// (64 chars) so length is fixed; the timingSafeEqual call works on
// equal-length Buffers.
function safeHashEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

const MIN_KEY_LEN  = 32
const CACHE_TTL_MS = parseInt(process.env.APPCLOUD_AUTH_CACHE_TTL_MS || '60000', 10)

// Mirror of postgres-init/{10-api-keys,13-tenants}.sql so a fresh DB without
// the init files applied still gets the table. Keep schemas in sync. The
// `ADD COLUMN IF NOT EXISTS expires_at` / `tenant_id` clauses are the
// upgrade path for deployments whose api_keys table predates those columns.
//
// The control schema + tenants table land here too so the auth plugin's
// bootstrap-upsert can FK api_keys.tenant_id to the seeded default tenant
// without depending on init-script ordering.
const CREATE_TABLE_SQL = `
  CREATE SCHEMA IF NOT EXISTS control;

  CREATE TABLE IF NOT EXISTS control.tenants (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT         NOT NULL UNIQUE,
    display_name    TEXT         NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'pending_delete')),
    schema_name     TEXT         NOT NULL UNIQUE,
    neo4j_database  TEXT         NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by      TEXT,
    metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE INDEX IF NOT EXISTS idx_tenants_status
    ON control.tenants (status) WHERE status != 'active';

  -- Seed the default tenant so existing deployments keep working.
  INSERT INTO control.tenants (slug, display_name, status, schema_name, neo4j_database, created_by, metadata)
  VALUES ('default', 'Default tenant', 'active', 'public', 'tenant_default', 'bootstrap',
          jsonb_build_object('seeded_at', now(), 'phase', 0))
  ON CONFLICT (slug) DO NOTHING;

  CREATE TABLE IF NOT EXISTS api_keys (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT         NOT NULL UNIQUE,
    key_hash      TEXT         NOT NULL UNIQUE,
    key_prefix    TEXT         NOT NULL,
    scopes        TEXT[]       NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by    TEXT,
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    is_bootstrap  BOOLEAN      NOT NULL DEFAULT false,
    CHECK (array_length(scopes, 1) >= 1)
  );
  ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
  ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tenant_id UUID;
  -- Backfill tenant_id on rows that predate the column.
  UPDATE api_keys
     SET tenant_id = (SELECT id FROM control.tenants WHERE slug = 'default')
   WHERE tenant_id IS NULL;
  -- Tighten and FK once the backfill is done. DO blocks keep the steps
  -- idempotent — re-running a partially-applied migration is safe.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'api_keys'
         AND column_name  = 'tenant_id'
         AND is_nullable  = 'YES'
    ) THEN
      ALTER TABLE api_keys ALTER COLUMN tenant_id SET NOT NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_tenant_fk'
    ) THEN
      ALTER TABLE api_keys
        ADD CONSTRAINT api_keys_tenant_fk
          FOREIGN KEY (tenant_id) REFERENCES control.tenants(id)
          ON DELETE RESTRICT;
    END IF;
  END $$;
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
    ON api_keys (key_hash) WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_api_keys_active
    ON api_keys (revoked_at) WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
    ON api_keys (tenant_id);
`

function readKeyFromFileOrEnv(fileVar, envVar) {
  const filePath = process.env[fileVar]
  if (filePath) {
    try { return fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  return (process.env[envVar] || '').trim()
}

function readBootstrapKey() {
  return readKeyFromFileOrEnv('APPCLOUD_API_KEY_FILE', 'APPCLOUD_API_KEY')
}

function readBootstrapAdminKey() {
  return readKeyFromFileOrEnv('APPCLOUD_ADMIN_API_KEY_FILE', 'APPCLOUD_ADMIN_API_KEY')
}

function readBootstrapSuperAdminKey() {
  return readKeyFromFileOrEnv('APPCLOUD_SUPER_ADMIN_API_KEY_FILE', 'APPCLOUD_SUPER_ADMIN_API_KEY')
}

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

function prependPreHandler(routeOptions, handler) {
  const existing = routeOptions.preHandler
  if (existing === handler) return
  if (Array.isArray(existing)) {
    if (existing.includes(handler)) return
    routeOptions.preHandler = [handler, ...existing]
  } else if (existing) {
    routeOptions.preHandler = [handler, existing]
  } else {
    routeOptions.preHandler = handler
  }
}

// In-memory hash → principal map. Refreshed lazily when older than TTL.
function makeKeyCache() {
  return {
    map:        new Map(),
    refreshedAt: 0,
    error:      null,
  }
}

async function loadKeysFromDb(pg) {
  // expires_at filter evaluated at query time (not in the partial index)
  // because now() is STABLE, not IMMUTABLE. Index probes by key_hash via
  // the revoked-only partial index; the planner adds an in-memory check
  // for expires_at on top.
  //
  // tenant_id is in the projection because every authenticated principal
  // carries a tenant binding; the tenantContext preHandler reads it to
  // resolve req.tenant on the request fast path.
  const rows = await pg.query(`
    SELECT id, name, key_hash, key_prefix, scopes, expires_at, tenant_id
    FROM api_keys
    WHERE revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
  `)
  const map = new Map()
  for (const r of rows) {
    map.set(r.key_hash, {
      id:        r.id,
      name:      r.name,
      scopes:    r.scopes,
      prefix:    r.key_prefix,
      expiresAt: r.expires_at,
      tenantId:  r.tenant_id,
      // Stash the hash so authenticate() can do an explicit
      // constant-time recheck after the Map.get hit. Map lookup itself
      // is constant-time on the hash key, but the recheck is belt-and-
      // braces against any future re-implementation that introduces
      // timing variance.
      keyHash:   r.key_hash,
    })
  }
  return map
}

async function refreshIfStale(cache, pg, log) {
  if (Date.now() - cache.refreshedAt < CACHE_TTL_MS) return
  try {
    cache.map         = await loadKeysFromDb(pg)
    cache.refreshedAt = Date.now()
    cache.error       = null
  } catch (err) {
    cache.error = err
    log?.error?.({ err }, '[auth] failed to refresh api_keys from DB — serving from last good snapshot')
  }
}

// Idempotent upsert of an env-var-derived bootstrap row. Refreshes the
// hash if the env value rotated; leaves hand-created rows untouched.
//
// tenant_id is bound to the default tenant. Operators who want a multi-
// tenant deployment with bootstrap keys for a *different* tenant should
// rotate the env-var keys after creating the tenant and issue normal
// (non-bootstrap) admin keys via /admin/tenants/:id/keys.
async function upsertBootstrapKey(pg, log, { plaintext, name, scopes, tenantId }) {
  if (!plaintext) return
  if (plaintext.length < MIN_KEY_LEN) {
    log.warn(
      `[auth] ${name} env-var key is only ${plaintext.length} chars — recommend ${MIN_KEY_LEN}+ ` +
      `(generate via: openssl rand -hex 32)`,
    )
  }
  if (!tenantId) {
    throw new Error(`[auth] upsertBootstrapKey('${name}'): tenantId is required`)
  }
  const key_hash   = hashKey(plaintext)
  const key_prefix = prefixOf(plaintext)
  await pg.query(`
    INSERT INTO api_keys (name, key_hash, key_prefix, scopes, tenant_id, is_bootstrap, created_by)
    VALUES ($1, $2, $3, $4, $5, true, 'bootstrap')
    ON CONFLICT (name) DO UPDATE
      SET key_hash   = EXCLUDED.key_hash,
          key_prefix = EXCLUDED.key_prefix,
          scopes     = EXCLUDED.scopes,
          tenant_id  = EXCLUDED.tenant_id,
          revoked_at = NULL
      WHERE api_keys.is_bootstrap = true
  `, [name, key_hash, key_prefix, scopes, tenantId])
}

// Fire-and-forget last_used_at update. We don't await it because it would
// add a round-trip to the auth fast path; loss of one update on a server
// crash isn't load-bearing.
function touchLastUsed(pg, id) {
  pg.query(
    `UPDATE api_keys SET last_used_at = now() WHERE id = $1`,
    [id],
  ).catch(() => {})
}

// Per-pair rate-limit gate for the "X-Actor on an authenticated request"
// warning. Returns true the first time we see a given (principalId,
// xActorValue) pair, then suppresses for `windowMs` so a misconfigured
// client sending the same header on every request doesn't flood the log.
//
// Map evicts oldest entries when it would otherwise exceed `maxEntries`,
// keeping memory bounded under adversarial inputs (e.g. an attacker
// spraying random X-Actor values to fill the map). 1024 entries × ~150
// bytes per entry ≈ 150KB worst case.
//
// Exported as a factory so tests can construct an isolated gate with a
// short window without poking the module's global state.
export function makeXActorWarnGate({ windowMs, maxEntries } = {}) {
  const WINDOW = windowMs   ?? parseInt(process.env.APPCLOUD_AUTH_WARN_WINDOW_MS || '60000', 10)
  const MAX    = maxEntries ?? 1024
  const state  = new Map()
  return function shouldWarn(principalId, xActorValue) {
    // Use NUL between the two parts so values can't collide via clever
    // packing — `'a:'` + `'b'` and `'a'` + `':b'` would otherwise hash to
    // the same key under a `:` separator.
    const key  = `${principalId}\0${xActorValue}`
    const now  = Date.now()
    const last = state.get(key)
    if (last !== undefined && now - last < WINDOW) return false
    if (state.size >= MAX) {
      // Map iteration is insertion-order — drop the oldest pair.
      const firstKey = state.keys().next().value
      state.delete(firstKey)
    }
    state.set(key, now)
    return true
  }
}

export async function authPlugin(fastify) {
  warnIfLegacyKeyEnvSet(fastify.log)

  const pg = fastify.pg
  if (!pg?.query) {
    fastify.log.error('[auth] fastify.pg.query unavailable — auth plugin requires Postgres')
    throw new Error('authPlugin requires fastify.pg')
  }

  // 1. Ensure schema exists.
  try { await pg.query(CREATE_TABLE_SQL) }
  catch (err) {
    fastify.log.error({ err }, '[auth] failed to ensure api_keys table — auth will be rejected until schema is fixed')
  }

  // 2. Resolve the default tenant id. Bootstrap keys bind here. The slug
  //    is overridable via APPCLOUD_BOOTSTRAP_TENANT_SLUG so an operator
  //    standing up a multi-tenant deployment can pin bootstrap keys to a
  //    specific tenant they've pre-seeded.
  const bootstrapTenantSlug = (process.env.APPCLOUD_BOOTSTRAP_TENANT_SLUG || 'default').trim()
  let bootstrapTenantId = null
  try {
    const rows = await pg.query(
      `SELECT id FROM control.tenants WHERE slug = $1`,
      [bootstrapTenantSlug],
    )
    bootstrapTenantId = rows[0]?.id || null
  } catch (err) {
    fastify.log.error({ err }, '[auth] tenant lookup failed — bootstrap key upsert will be skipped')
  }
  if (!bootstrapTenantId) {
    fastify.log.warn(
      `[auth] tenant '${bootstrapTenantSlug}' not found — skipping bootstrap key upsert. ` +
      `Either the migration didn't apply or APPCLOUD_BOOTSTRAP_TENANT_SLUG names a tenant that doesn't exist yet.`,
    )
  }

  // 3. Bootstrap rows from env vars. APPCLOUD_API_KEY → write, ADMIN →
  //    admin, SUPER_ADMIN → super-admin. Best-effort: log + continue if
  //    DB write fails (the cache refresh below will surface the problem
  //    at request time).
  const bootstrapPlain           = readBootstrapKey()
  const bootstrapAdminPlain      = readBootstrapAdminKey()
  const bootstrapSuperAdminPlain = readBootstrapSuperAdminKey()
  if (bootstrapTenantId) {
    try {
      await upsertBootstrapKey(pg, fastify.log, {
        plaintext: bootstrapPlain,
        name:      'bootstrap-api-key',
        scopes:    [SCOPES.WRITE],
        tenantId:  bootstrapTenantId,
      })
      await upsertBootstrapKey(pg, fastify.log, {
        plaintext: bootstrapAdminPlain,
        name:      'bootstrap-admin-key',
        scopes:    [SCOPES.ADMIN],
        tenantId:  bootstrapTenantId,
      })
      await upsertBootstrapKey(pg, fastify.log, {
        plaintext: bootstrapSuperAdminPlain,
        name:      'bootstrap-super-admin-key',
        scopes:    [SCOPES.SUPER_ADMIN],
        tenantId:  bootstrapTenantId,
      })
    } catch (err) {
      fastify.log.error({ err }, '[auth] bootstrap upsert failed — keys created via /admin/api-keys still work')
    }
  }

  // 4. Initial cache fill.
  const cache = makeKeyCache()
  await refreshIfStale(cache, pg, fastify.log)
  const shouldWarnXActor = makeXActorWarnGate()

  // 5. Decorate fastify with the auth + scope-check primitives.
  const authDisabled = !bootstrapPlain
    && !bootstrapAdminPlain
    && !bootstrapSuperAdminPlain
    && cache.map.size === 0
  if (authDisabled) {
    // Production-side hard gate: in NODE_ENV=production, refuse to start
    // unless the operator has explicitly opted into open-auth via
    // APPCLOUD_ALLOW_OPEN_AUTH=true. The trap we're closing: a deploy
    // that loses its bootstrap secret (deleted ConfigMap, expired
    // Secret, race during secret-mount) silently falls back to
    // anonymous-admin, and the audit log records every request as
    // 'anonymous' until someone notices.
    if (process.env.NODE_ENV === 'production'
        && !/^(true|1|yes)$/i.test(process.env.APPCLOUD_ALLOW_OPEN_AUTH || '')) {
      throw new Error(
        '[auth] refusing to start in NODE_ENV=production with no API keys — ' +
        'set APPCLOUD_API_KEY (or APPCLOUD_ADMIN_API_KEY) to bootstrap a key, ' +
        'or set APPCLOUD_ALLOW_OPEN_AUTH=true to acknowledge the open-auth risk.',
      )
    }
    fastify.log.warn('[auth] no bootstrap env keys + no DB keys — authentication disabled, all routes open')
    // Periodic re-warn so the warning doesn't scroll out of operator
    // view after boot. Every 60s (configurable) — long enough that a
    // local-dev session isn't drowned in noise, short enough that a
    // misconfigured deploy shows up in any reasonable log retention.
    const reWarnIntervalMs = parseInt(process.env.APPCLOUD_AUTH_DISABLED_WARN_MS || '60000', 10)
    if (reWarnIntervalMs > 0) {
      const timer = setInterval(() => {
        fastify.log.warn('[auth] STILL RUNNING WITH AUTH DISABLED — every request reaches handlers as anonymous-admin')
      }, reWarnIntervalMs)
      timer.unref?.()
      fastify.addHook('onClose', async () => clearInterval(timer))
    }
  }
  // Expose the auth-state flag so the metrics plugin can publish it as
  // a gauge — operators can alert on `appcloud_auth_disabled == 1`.
  fastify.decorate('authDisabled', authDisabled)

  const authenticate = async (req, reply) => {
    if (authDisabled) {
      // No DB keys + no env vars — local-dev convenience matching the
      // previous build's "auth disabled, all routes open" path. As soon
      // as ANY key is created (env-var bootstrap or via /admin/api-keys
      // once stage 4 lands), this branch goes cold.
      // tenantId is the default tenant when one exists — keeps tests
      // and local-dev requests resolving against the same data the
      // multi-tenant code paths see in production.
      req.principal = {
        id:       null,
        name:     'anonymous',
        scopes:   [SCOPES.SUPER_ADMIN],
        prefix:   '',
        tenantId: bootstrapTenantId,
      }
      return
    }
    await refreshIfStale(cache, pg, fastify.log)
    const provided = (req.headers['x-api-key'] || '').trim()
    if (!provided) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Valid X-API-Key header required' })
      return
    }
    // hashKey runs unconditionally so an attacker can't distinguish a
    // missing-header request from a bad-key request via timing. Map.get
    // on the resulting hex hash is O(1) and reveals nothing about which
    // bytes (if any) matched a stored key.
    const candidateHash = hashKey(provided)
    const principal     = cache.map.get(candidateHash)
    // Constant-time recheck against the stored hash. Defense in depth
    // — Map.get itself is already constant-time on the hash key, but a
    // future re-implementation (e.g. a custom Map with prefix-shortcut
    // matching) wouldn't be, and the explicit timingSafeEqual makes
    // the security intent visible.
    if (principal && !safeHashEqual(candidateHash, principal.keyHash)) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Valid X-API-Key header required' })
      return
    }
    if (!principal) {
      // Cache empty + DB last-fetch failed → 503, not 401, so an operator
      // sees the real cause instead of chasing a "bad key" red herring.
      if (cache.error && cache.map.size === 0) {
        reply.code(503).send({ error: 'Service Unavailable', message: 'auth backend unavailable' })
        return
      }
      reply.code(401).send({ error: 'Unauthorized', message: 'Valid X-API-Key header required' })
      return
    }
    // Per-request expiry guard. The cache only refreshes every CACHE_TTL_MS,
    // so a key whose expires_at falls between two refreshes would otherwise
    // remain usable for up to that window. Check now() against the
    // expires_at carried with the principal so the moment of expiry is
    // enforced exactly.
    if (principal.expiresAt && new Date(principal.expiresAt) <= new Date()) {
      reply.code(401).send({
        error:   'Unauthorized',
        message: 'API key has expired',
      })
      return
    }
    req.principal = principal
    touchLastUsed(pg, principal.id)
    // X-Actor used to be the audit identity; since slice 5 the principal
    // name is authoritative and X-Actor is silently ignored. Warn the
    // first time we see a (principal, xActor) pair, then suppress for
    // APPCLOUD_AUTH_WARN_WINDOW_MS (default 60s) — a misconfigured client
    // sending X-Actor on every request would otherwise flood the log.
    const xActor = req.headers['x-actor']
    if (xActor && shouldWarnXActor(principal.id, xActor)) {
      req.log.warn(
        { principal: principal.name, xActor },
        '[auth] X-Actor header is ignored on authenticated requests — audit actor comes from the API key (rate-limited per (principal, xActor) pair)',
      )
    }
  }

  const requireScope = (need) => async (req, reply) => {
    if (!req.principal) {
      reply.code(401).send({ error: 'Unauthorized', message: 'authentication required' })
      return
    }
    if (!hasScope(req.principal.scopes, need)) {
      reply.code(403).send({
        error:   'Forbidden',
        message: `scope '${need}' required (this key has: ${req.principal.scopes.join(', ')})`,
      })
    }
  }

  // Stable per-scope handlers, reused across every route so dedupe works
  // and tests can match by reference. New scopes added later go here.
  const scopeHandlers = {
    [SCOPES.SUPER_ADMIN]: requireScope(SCOPES.SUPER_ADMIN),
    [SCOPES.ADMIN]:       requireScope(SCOPES.ADMIN),
    [SCOPES.WRITE]:       requireScope(SCOPES.WRITE),
    [SCOPES.READ]:        requireScope(SCOPES.READ),
  }

  fastify.decorate('authenticate', authenticate)
  fastify.decorate('requireScope', requireScope)
  fastify.decorate('scopeHandlers', scopeHandlers)
  // Expose the cache so future stages (admin endpoints) can invalidate it
  // immediately on key create/revoke instead of waiting for TTL.
  fastify.decorate('apiKeyCache', cache)

  // Method-based scope default: GET / HEAD are read-only; everything else
  // mutates and needs write. Routes can override via config.scope.
  function defaultScopeForMethod(method) {
    const m = String(method || 'GET').toUpperCase()
    return (m === 'GET' || m === 'HEAD') ? SCOPES.READ : SCOPES.WRITE
  }

  // Resolve the required scope for a route: explicit config.scope wins,
  // otherwise method-default (GET/HEAD → read, everything else → write).
  function resolveScope(routeOptions) {
    const explicit = routeOptions.config?.scope
    if (explicit) {
      if (!scopeHandlers[explicit]) {
        throw new Error(`unknown route scope '${explicit}' — use one of super-admin, admin, write, read`)
      }
      return explicit
    }
    return defaultScopeForMethod(routeOptions.method)
  }

  fastify.addHook('onRoute', (routeOptions) => {
    if (isPublicRoute(routeOptions)) return
    prependPreHandler(routeOptions, authenticate)
    const scope   = resolveScope(routeOptions)
    const handler = scopeHandlers[scope]
    attachPreHandler(routeOptions, handler)
    // Stash the resolved scope for the auth-coverage test + diagnostic tooling.
    routeOptions.config = { ...(routeOptions.config || {}), _resolvedScope: scope }
  })

  fastify.log.info(
    `[auth] DB-backed authentication active — ${cache.map.size} key(s) loaded` +
    (bootstrapPlain ? ', APPCLOUD_API_KEY bootstrap=write' : '') +
    (bootstrapAdminPlain ? ', APPCLOUD_ADMIN_API_KEY bootstrap=admin' : '') +
    (bootstrapSuperAdminPlain ? ', APPCLOUD_SUPER_ADMIN_API_KEY bootstrap=super-admin' : ''),
  )
}
