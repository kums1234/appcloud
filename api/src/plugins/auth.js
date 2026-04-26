// plugins/auth.js
// Headless API-key gate.
//
// Two key tiers:
//   - Regular  — APPCLOUD_API_KEY_FILE / APPCLOUD_API_KEY (existing).
//                Required for any non-public route.
//   - Admin    — APPCLOUD_ADMIN_API_KEY_FILE / APPCLOUD_ADMIN_API_KEY (new).
//                Required for routes that opt-in via `config.requireAdmin: true`
//                in their route options (today: every /audit/* route).
//
// When the regular key is unset, auth is disabled and fastify.authenticate is
// a no-op (existing dev-friendly behaviour). When the admin key is unset,
// admin-only routes 503 — fail loud so an operator notices before assuming
// audit reads are protected.
//
// Callers authenticate by sending:  X-API-Key: <key>
// A missing or mismatched key on a protected route returns 401; a missing
// admin requirement returns 403.
//
// ── Default-deny ─────────────────────────────────────────────────────────────
// Every route registered AFTER this plugin runs gets `fastify.authenticate`
// wired in as a preHandler automatically via an `onRoute` hook. Forgetting
// `withAuth(...)` on a new route can no longer accidentally expose it.
//
// Routes opt out by setting `schema.security = []` (the same OpenAPI
// convention already documented in api/src/schemas/openapi.js). The handful
// of intentionally public routes (`/health`, `/`, `/openapi.json`,
// Swagger UI under `/docs/*`) either set `security: []` or are registered
// BEFORE this plugin runs, so the hook never sees them.
import fs from 'fs'
import { timingSafeEqual } from 'crypto'
import { warnIfLegacyKeyEnvSet } from '../utils/encrypt.js'

// Recommended minimum key length. `openssl rand -hex 32` produces 64 chars.
// Shorter keys are accepted (don't break dev) but logged with a warning so
// the operator notices before going to production.
const MIN_KEY_LEN = 32

function readKeyFromFileOrEnv(fileVar, envVar) {
  const filePath = process.env[fileVar]
  if (filePath) {
    try { return fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  return (process.env[envVar] || '').trim()
}

function readKey() {
  return readKeyFromFileOrEnv('APPCLOUD_API_KEY_FILE', 'APPCLOUD_API_KEY')
}

function readAdminKey() {
  return readKeyFromFileOrEnv('APPCLOUD_ADMIN_API_KEY_FILE', 'APPCLOUD_ADMIN_API_KEY')
}

// Constant-time API-key comparison. A naive `provided !== expected` short-
// circuits on the first byte mismatch, leaking how far the guess matched via
// timing — over many requests an attacker can recover the key byte-by-byte.
//
// timingSafeEqual requires equal-length buffers. We pad the provided value to
// the expected length (with a fixed sentinel) and force-fail if the lengths
// differ — both branches still execute the full-length comparison, so the
// length check itself doesn't leak.
function safeKeyEqual(provided, expected) {
  const expectedBuf = Buffer.from(expected, 'utf8')
  const providedBuf = Buffer.alloc(expectedBuf.length, 0)
  Buffer.from(provided, 'utf8').copy(providedBuf, 0, 0, expectedBuf.length)
  const equal = timingSafeEqual(providedBuf, expectedBuf)
  return equal && provided.length === expected.length
}

// Treat a route as public when the schema explicitly opts out via the OpenAPI
// security override. Anything else is auth-gated by default.
function isPublicRoute(routeOptions) {
  return Array.isArray(routeOptions.schema?.security)
      && routeOptions.schema.security.length === 0
}

// Compose `auth` with whatever preHandler the route already declared, without
// duplicating if it's already there. Auth runs first so unauthorised callers
// short-circuit before any other validation work.
function attachAuth(routeOptions, auth) {
  const existing = routeOptions.preHandler
  if (existing === auth) return
  if (Array.isArray(existing)) {
    if (existing.includes(auth)) return
    routeOptions.preHandler = [auth, ...existing]
  } else if (existing) {
    routeOptions.preHandler = [auth, existing]
  } else {
    routeOptions.preHandler = auth
  }
}

export async function authPlugin(fastify) {
  warnIfLegacyKeyEnvSet(fastify.log)
  const expected      = readKey()
  const expectedAdmin = readAdminKey()

  const authenticate = expected
    ? async (req, reply) => {
        const provided = (req.headers['x-api-key'] || '').trim()
        if (!provided || !safeKeyEqual(provided, expected)) {
          // Admin keys also satisfy regular auth — operator with an admin
          // key can hit normal routes without juggling two keys.
          if (expectedAdmin && safeKeyEqual(provided, expectedAdmin)) {
            req.appcloudKeyTier = 'admin'
            return
          }
          reply.code(401).send({ error: 'Unauthorized', message: 'Valid X-API-Key header required' })
          return
        }
        req.appcloudKeyTier = 'regular'
      }
    : async (req) => { req.appcloudKeyTier = 'disabled' }

  // Admin-tier check — used as a SECOND preHandler on routes that set
  // `config.requireAdmin: true`. Returns 403 when the caller authenticated
  // with the regular key, 503 when the admin key isn't configured at all.
  const requireAdmin = async (req, reply) => {
    if (!expectedAdmin) {
      reply.code(503).send({
        error:   'Service Unavailable',
        message: 'admin route — APPCLOUD_ADMIN_API_KEY{,_FILE} is not configured',
      })
      return
    }
    if (req.appcloudKeyTier !== 'admin') {
      reply.code(403).send({
        error:   'Forbidden',
        message: 'admin tier required — pass an X-API-Key matching APPCLOUD_ADMIN_API_KEY',
      })
    }
  }

  fastify.decorate('authenticate', authenticate)
  fastify.decorate('requireAdmin', requireAdmin)

  // Default-deny: wire the authenticate preHandler into every route registered
  // after this plugin. Even when auth is disabled (no API key configured),
  // installing the hook keeps behaviour identical between dev + prod and
  // means a key flipped on later doesn't depend on individual routes
  // remembering to opt in. Routes that flag `config.requireAdmin: true` get
  // the admin-tier preHandler attached too — order matters: regular auth
  // first (sets the tier), then the admin gate (reads it).
  fastify.addHook('onRoute', (routeOptions) => {
    if (isPublicRoute(routeOptions)) return
    attachAuth(routeOptions, authenticate)
    if (routeOptions.config?.requireAdmin) {
      const ph = routeOptions.preHandler
      if (Array.isArray(ph) && !ph.includes(requireAdmin)) {
        routeOptions.preHandler = [...ph, requireAdmin]
      } else if (typeof ph === 'function' && ph !== requireAdmin) {
        routeOptions.preHandler = [ph, requireAdmin]
      }
    }
  })

  if (expected) {
    fastify.log.info('[auth] API-key authentication enabled (X-API-Key header) — default-deny on all routes')
    if (expected.length < MIN_KEY_LEN) {
      fastify.log.warn(
        `[auth] APPCLOUD_API_KEY is only ${expected.length} chars — recommend ${MIN_KEY_LEN}+ ` +
        `(generate via: openssl rand -hex 32)`,
      )
    }
  } else {
    fastify.log.warn('[auth] APPCLOUD_API_KEY not set — authentication disabled, all routes open')
  }
  if (expectedAdmin) {
    fastify.log.info('[auth] admin-tier authentication enabled — admin routes require APPCLOUD_ADMIN_API_KEY')
    if (expectedAdmin.length < MIN_KEY_LEN) {
      fastify.log.warn(
        `[auth] APPCLOUD_ADMIN_API_KEY is only ${expectedAdmin.length} chars — recommend ${MIN_KEY_LEN}+`,
      )
    }
    if (expectedAdmin === expected) {
      fastify.log.warn('[auth] APPCLOUD_ADMIN_API_KEY equals APPCLOUD_API_KEY — admin tier provides no additional protection in this configuration')
    }
  } else {
    fastify.log.warn('[auth] APPCLOUD_ADMIN_API_KEY not set — routes flagged config.requireAdmin will return 503')
  }
}
