// plugins/auth.js
// DB-backed multi-key authentication.
//
// Every API key lives as a row in the api_keys table (postgres-init/10-api-keys.sql).
// We store SHA-256(plaintext) and look up by hash on every request — the
// plaintext is shown ONCE at creation and never recoverable.
//
// ── Scopes ───────────────────────────────────────────────────────────────────
// Hierarchy: admin > write > read.
//   - admin → key management, audit log, debug routes, plus everything below
//   - write → mutations on resources (apps, components, infra, scans, …)
//   - read  → GET endpoints
// Per-route requirement comes from `config.scope: 'admin' | 'write' | 'read'`,
// or falls back to a method-based default in stage 3 (this stage just keeps
// the existing `requireAdmin` decorator working as a thin wrapper).
//
// ── Bootstrap ────────────────────────────────────────────────────────────────
// On startup we upsert two rows from env vars (when set):
//   APPCLOUD_API_KEY{,_FILE}        → name='bootstrap-api-key'   scopes=['write']
//   APPCLOUD_ADMIN_API_KEY{,_FILE}  → name='bootstrap-admin-key' scopes=['admin']
// These are flagged is_bootstrap=true so future stages can refresh their
// hashes when the env value rotates without touching hand-created keys.
//
// ── Cache + DB unavailability ────────────────────────────────────────────────
// The hash → principal map is cached in memory and refreshed every CACHE_TTL_MS
// (default 60s). On a DB outage we keep serving from the last good snapshot,
// so a Postgres blip doesn't blackhole every request. If the cache is empty
// AND the DB is down, requests 503.
//
// ── Default-deny ─────────────────────────────────────────────────────────────
// Unchanged from prior slices: the onRoute hook attaches `authenticate` to
// every route except those flagged `schema.security: []`. `requireAdmin` is
// still attached when `config.requireAdmin: true` is set on a route — kept
// as a backwards-compat alias for `config.scope: 'admin'` until stage 3.

import fs from 'fs'
import { hashKey, prefixOf, hasScope, SCOPES } from '../utils/api-keys.js'
import { warnIfLegacyKeyEnvSet } from '../utils/encrypt.js'

const MIN_KEY_LEN  = 32
const CACHE_TTL_MS = parseInt(process.env.APPCLOUD_AUTH_CACHE_TTL_MS || '60000', 10)

// Mirror of postgres-init/10-api-keys.sql so a fresh DB without the init
// file applied still gets the table. Keep schemas in sync.
const CREATE_TABLE_SQL = `
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
    is_bootstrap  BOOLEAN      NOT NULL DEFAULT false,
    CHECK (array_length(scopes, 1) >= 1)
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
    ON api_keys (key_hash) WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_api_keys_active
    ON api_keys (revoked_at) WHERE revoked_at IS NULL;
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
  const rows = await pg.query(`
    SELECT id, name, key_hash, key_prefix, scopes
    FROM api_keys
    WHERE revoked_at IS NULL
  `)
  const map = new Map()
  for (const r of rows) {
    map.set(r.key_hash, {
      id:     r.id,
      name:   r.name,
      scopes: r.scopes,
      prefix: r.key_prefix,
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
async function upsertBootstrapKey(pg, log, { plaintext, name, scopes }) {
  if (!plaintext) return
  if (plaintext.length < MIN_KEY_LEN) {
    log.warn(
      `[auth] ${name} env-var key is only ${plaintext.length} chars — recommend ${MIN_KEY_LEN}+ ` +
      `(generate via: openssl rand -hex 32)`,
    )
  }
  const key_hash   = hashKey(plaintext)
  const key_prefix = prefixOf(plaintext)
  await pg.query(`
    INSERT INTO api_keys (name, key_hash, key_prefix, scopes, is_bootstrap, created_by)
    VALUES ($1, $2, $3, $4, true, 'bootstrap')
    ON CONFLICT (name) DO UPDATE
      SET key_hash   = EXCLUDED.key_hash,
          key_prefix = EXCLUDED.key_prefix,
          scopes     = EXCLUDED.scopes,
          revoked_at = NULL
      WHERE api_keys.is_bootstrap = true
  `, [name, key_hash, key_prefix, scopes])
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

  // 2. Bootstrap rows from env vars. APPCLOUD_API_KEY → write, ADMIN → admin.
  //    Best-effort: log + continue if DB write fails (the cache refresh
  //    below will surface the problem at request time).
  const bootstrapPlain      = readBootstrapKey()
  const bootstrapAdminPlain = readBootstrapAdminKey()
  try {
    await upsertBootstrapKey(pg, fastify.log, {
      plaintext: bootstrapPlain,
      name:      'bootstrap-api-key',
      scopes:    [SCOPES.WRITE],
    })
    await upsertBootstrapKey(pg, fastify.log, {
      plaintext: bootstrapAdminPlain,
      name:      'bootstrap-admin-key',
      scopes:    [SCOPES.ADMIN],
    })
  } catch (err) {
    fastify.log.error({ err }, '[auth] bootstrap upsert failed — keys created via /admin/api-keys still work')
  }

  // 3. Initial cache fill.
  const cache = makeKeyCache()
  await refreshIfStale(cache, pg, fastify.log)
  const shouldWarnXActor = makeXActorWarnGate()

  // 4. Decorate fastify with the auth + scope-check primitives.
  const authDisabled = !bootstrapPlain && !bootstrapAdminPlain && cache.map.size === 0
  if (authDisabled) {
    fastify.log.warn('[auth] no bootstrap env keys + no DB keys — authentication disabled, all routes open')
  }

  const authenticate = async (req, reply) => {
    if (authDisabled) {
      // No DB keys + no env vars — local-dev convenience matching the
      // previous build's "auth disabled, all routes open" path. As soon
      // as ANY key is created (env-var bootstrap or via /admin/api-keys
      // once stage 4 lands), this branch goes cold.
      req.principal = { id: null, name: 'anonymous', scopes: [SCOPES.ADMIN], prefix: '' }
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
    [SCOPES.ADMIN]: requireScope(SCOPES.ADMIN),
    [SCOPES.WRITE]: requireScope(SCOPES.WRITE),
    [SCOPES.READ]:  requireScope(SCOPES.READ),
  }
  const requireAdmin = scopeHandlers[SCOPES.ADMIN]   // backwards-compat alias

  fastify.decorate('authenticate', authenticate)
  fastify.decorate('requireAdmin', requireAdmin)
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
  // legacy config.requireAdmin: true maps to admin, otherwise method-default.
  function resolveScope(routeOptions) {
    const explicit = routeOptions.config?.scope
    if (explicit) {
      if (!scopeHandlers[explicit]) {
        throw new Error(`unknown route scope '${explicit}' — use one of admin, write, read`)
      }
      return explicit
    }
    if (routeOptions.config?.requireAdmin) return SCOPES.ADMIN
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
    (bootstrapAdminPlain ? ', APPCLOUD_ADMIN_API_KEY bootstrap=admin' : ''),
  )
}
