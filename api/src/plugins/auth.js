// plugins/auth.js
// Headless API-key gate. Reads the expected key from (in order):
//   1. APPCLOUD_API_KEY_FILE  (file path — typical k8s secret mount)
//   2. APPCLOUD_API_KEY       (env var — typical docker-compose / local dev)
//
// When neither is set, auth is disabled and fastify.authenticate is a no-op
// so the same preHandler works in both modes. This matches the previous JWT
// plugin's behaviour and keeps local dev frictionless.
//
// Callers authenticate by sending:  X-API-Key: <key>
// A missing or mismatched key on a protected route returns 401.
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

// Recommended minimum key length. `openssl rand -hex 32` produces 64 chars.
// Shorter keys are accepted (don't break dev) but logged with a warning so
// the operator notices before going to production.
const MIN_KEY_LEN = 32

function readKey() {
  const filePath = process.env.APPCLOUD_API_KEY_FILE
  if (filePath) {
    try { return fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  return (process.env.APPCLOUD_API_KEY || '').trim()
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
  const expected = readKey()

  const authenticate = expected
    ? async (req, reply) => {
        const provided = (req.headers['x-api-key'] || '').trim()
        if (!provided || !safeKeyEqual(provided, expected)) {
          reply.code(401).send({ error: 'Unauthorized', message: 'Valid X-API-Key header required' })
        }
      }
    : async () => {}

  fastify.decorate('authenticate', authenticate)

  // Default-deny: wire the authenticate preHandler into every route registered
  // after this plugin. Even when auth is disabled (no API key configured),
  // installing the hook keeps behaviour identical between dev + prod and
  // means a key flipped on later doesn't depend on individual routes
  // remembering to opt in.
  fastify.addHook('onRoute', (routeOptions) => {
    if (isPublicRoute(routeOptions)) return
    attachAuth(routeOptions, authenticate)
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
}
