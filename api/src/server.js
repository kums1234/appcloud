import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import sensible from '@fastify/sensible'
import { neo4jPlugin } from './plugins/neo4j.js'
import { postgresPlugin } from './plugins/postgres.js'
import { authPlugin } from './plugins/auth.js'
import { auditCleanupPlugin } from './plugins/audit-cleanup.js'
import { connectorsPlugin } from './plugins/connectors.js'
import { otelAggregatorPlugin } from './plugins/otel-aggregator.js'
import { schedulerPlugin } from './plugins/scheduler.js'
import { cmdbAssessmentSchedulerPlugin } from './plugins/cmdb-assessment-scheduler.js'
import { aiPlugin } from './plugins/ai.js'
import { metricsPlugin } from './plugins/metrics.js'
import { autoTagRoute } from './utils/openapi-tags.js'
import { registerAllRoutes } from './utils/route-modules.js'

const fastify = Fastify({
  logger: true,
  // Request-ID propagation. Fastify mints a `req.id` per request and
  // includes it on every `req.log` entry. We also accept an inbound
  // `X-Request-Id` so a UI / load balancer can stitch traces across
  // service boundaries. The same id is echoed on the response and
  // forwarded by scheduler.js's internal fetches via the same header.
  requestIdHeader:    'x-request-id',
  requestIdLogLabel:  'reqId',
  genReqId:           (req) => req.headers['x-request-id'] || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
  // OpenAPI 3.0's `example` / `examples` / `xml` keywords aren't part of
  // the JSON Schema spec Ajv ships with — relax strict mode so we can
  // annotate routes with them. We still validate every body / param.
  ajv: { customOptions: { strict: false, keywords: ['example', 'xml'] } },
})

// Echo the resolved request id on every response so a UI client can
// quote it back in a bug report.
fastify.addHook('onSend', async (req, reply) => {
  reply.header('x-request-id', req.id)
})

// Core plugins (these use @fastify/cors and @fastify/sensible which handle
// their own scoping correctly via their built-in fastify-plugin wrappers).
//
// CORS allowlist: previously `origin: true` reflected any origin, which is
// a CSRF vector if a cross-origin script ever has access to the X-API-Key
// (e.g. via XSS in the UI or a leaked key in localStorage). The allowlist
// is configured via APPCLOUD_ALLOWED_ORIGINS (comma-separated). Falls back
// to the typical local-dev set so `npm run dev` doesn't need extra config.
// Production deploys MUST set APPCLOUD_ALLOWED_ORIGINS explicitly —
// the local-dev allowlist (Vite, port 8080, `appcloud.local`) is a
// misconfiguration if it ships to prod. Refusing to fall back when
// NODE_ENV=production stops a deploy that lost its CORS config from
// silently allowing the dev origins.
const FALLBACK_DEV_ORIGINS = 'http://localhost:3000,http://localhost:5173,http://localhost:8080,http://appcloud.local'
if (process.env.NODE_ENV === 'production' && !process.env.APPCLOUD_ALLOWED_ORIGINS) {
  throw new Error(
    '[server] NODE_ENV=production without APPCLOUD_ALLOWED_ORIGINS — refusing to start with the local-dev CORS allowlist. ' +
    'Set APPCLOUD_ALLOWED_ORIGINS to a comma-separated list of your real UI origins.',
  )
}
const ALLOWED_ORIGINS = (
  process.env.APPCLOUD_ALLOWED_ORIGINS || FALLBACK_DEV_ORIGINS
).split(',').map(s => s.trim()).filter(Boolean)
await fastify.register(cors, {
  origin: (origin, cb) => {
    // No origin header = same-origin / curl / server-to-server — always allow.
    if (!origin) return cb(null, true)
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
    cb(new Error(`origin ${origin} not in APPCLOUD_ALLOWED_ORIGINS`), false)
  },
  credentials: false,
})
await fastify.register(sensible)

// Baseline security headers via @fastify/helmet. Disabling CSP because the
// Swagger UI is served from /docs and would need a tailored policy; the rest
// of helmet's defaults (X-Frame-Options DENY, X-Content-Type-Options nosniff,
// Referrer-Policy, etc.) protect the API surface against clickjacking and
// MIME-type confusion. HSTS is enabled for production where TLS is terminated
// upstream — it's a no-op over HTTP so safe to leave on in dev.
await fastify.register(helmet, {
  contentSecurityPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
})

// Rate limiting — two-tier so an unauthenticated attacker can't rotate
// X-API-Key values to bypass the cap.
//
//   Authenticated request: bucket = `key:<x-api-key>`. The header is
//   present and the request will eventually succeed or fail auth, but
//   either way the per-key bucket caps spend per credential.
//
//   Unauthenticated request: bucket = `ip:<remote>`. The header is
//   absent or empty; we ignore whatever it might say (attackers
//   sending random keys all get the same `ip:…` bucket). The cap is
//   tighter than the authenticated one — pre-auth surface should not
//   absorb sustained traffic.
//
// AI + discovery routes opt into stricter per-route limits via
// `config.rateLimit` on their schema (see ai.js, discovery.js).
const RATE_LIMIT_AUTH_MAX   = parseInt(process.env.APPCLOUD_RATE_LIMIT_MAX        || '300', 10)
const RATE_LIMIT_UNAUTH_MAX = parseInt(process.env.APPCLOUD_RATE_LIMIT_UNAUTH_MAX || '60',  10)
await fastify.register(rateLimit, {
  global: true,
  max: (req) => {
    return (req.headers['x-api-key'] || '').trim() ? RATE_LIMIT_AUTH_MAX : RATE_LIMIT_UNAUTH_MAX
  },
  timeWindow: process.env.APPCLOUD_RATE_LIMIT_WINDOW || '1 minute',
  keyGenerator: (req) => {
    const key = (req.headers['x-api-key'] || '').trim()
    if (key) return `key:${key}`
    return `ip:${req.ip}`
  },
  // Don't throttle the liveness probe — k8s polls it constantly.
  skipOnError: false,
  allowList: ['127.0.0.1'],
})

// OpenAPI generation. @fastify/swagger derives the spec from each route's
// declared `schema` block; routes without one still appear in the doc with
// only path + method + tags. Hosted spec is at /openapi.json (machine
// readable) and /docs (Swagger UI). The doc is generated at startup;
// docs/openapi.yaml is exported by the `npm run openapi:export` script for
// offline / source-control usage.
const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title:       'AppCloud API',
    description: 'Knowledge graph platform for infrastructure dependency mapping and blast-radius analysis. See docs/api-guide.md for the working reference and docs/api-postman-collection.json for an importable Postman collection.',
    version:     '1.1.0',
    license:     { name: 'Proprietary' },
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local port-forward' },
    { url: 'http://appcloud.local',  description: 'Minikube tunnel / ingress' },
  ],
  components: {
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
  },
  security: [{ ApiKey: [] }],
  tags: [
    { name: 'Health',         description: 'Liveness — open, no auth' },
    { name: 'Discovery',      description: 'Cloud-account scans, mapping suggestions, supplements' },
    { name: 'Applications',   description: 'Application lifecycle' },
    { name: 'Components',     description: 'Component lifecycle + connections + deploy' },
    { name: 'Infra',          description: 'Infrastructure catalog + shared / exposed views' },
    { name: 'Graph',          description: 'Topology, blast-radius, cross-app dependencies' },
    { name: 'AI',             description: 'AI-assisted impact narratives, planning, drift remediation' },
    { name: 'Audit',          description: 'Mutation audit log' },
    { name: 'CMDB',           description: 'CMDB assessment + scoring' },
    { name: 'Integrations',   description: 'Cloud accounts, AI provider config, generic connector framework, Terraform import' },
    { name: 'Connectors',     description: 'Connector registry — schema discovery for the generic connector framework' },
    { name: 'OpenAPI',        description: 'API self-description' },
  ],
}
const swagger    = (await import('@fastify/swagger')).default
const swaggerUI  = (await import('@fastify/swagger-ui')).default

// `transform` runs per-route at registration time. autoTagRoute (shared
// with scripts/export-openapi.js + the drift test, see utils/openapi-tags.js)
// auto-tags every route by its first path segment so the Swagger UI groups
// Discovery / Applications / Components / etc. without per-route annotation.
// Routes that already declare `schema.tags` keep their explicit tag set.
await fastify.register(swagger, { openapi: openapiSpec, transform: autoTagRoute })
await fastify.register(swaggerUI, {
  routePrefix:    '/docs',
  uiConfig:       { docExpansion: 'list', deepLinking: true },
  staticCSP:      true,
})

// Expose the generated spec as JSON at /openapi.json (machine-readable).
// @fastify/swagger-ui serves the same spec at /docs/json + /docs/yaml,
// but /openapi.json is the conventional path callers expect.
fastify.get('/openapi.json', {
  schema: {
    tags:        ['OpenAPI'],
    summary:     'Generated OpenAPI specification',
    description: 'Returns the live OpenAPI 3.0 description of every registered route. Importable into Postman, Swagger UI, openapi-generator, etc. The companion human-readable guide is in docs/api-guide.md.',
    security:    [],
  },
}, async () => fastify.swagger())

// Optional multipart — graceful degradation if not installed
try {
  const { default: multipart } = await import('@fastify/multipart')
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } })
} catch {
  fastify.log.warn('@fastify/multipart not available — Terraform upload disabled')
}

// Database plugins — called DIRECTLY (not via register) so their decorators
// are set on the root fastify instance and visible everywhere
await neo4jPlugin(fastify)
await postgresPlugin(fastify)

// Auth plugin — must come after DB plugins (uses User nodes) and before routes
await authPlugin(fastify)

// Audit retention — periodic DELETE of audit_log rows older than
// APPCLOUD_AUDIT_RETENTION_DAYS (default 365). Direct call (not register())
// so it shares the root fastify decorators with no encapsulation barrier.
await auditCleanupPlugin(fastify)

// Connector framework — loads registry, applies integrations-table evolution
// DDL, and registers push-style receivers (e.g. OTel ingest). Must come after
// pg + neo4j plugins and before routes that reference fastify.connectors.
await connectorsPlugin(fastify)

// OTel aggregator — periodic worker that drains otel_spans_raw into Neo4j.
// Tick interval via OTEL_AGG_INTERVAL_MS (default 60_000).
await otelAggregatorPlugin(fastify)

// Scheduler — starts after server ready, requires pg to be initialised
await schedulerPlugin(fastify)

// CMDB assessment scheduler — periodic + dirty-flag-driven run of the
// relevance/quality engine. Decorates fastify.cmdbAssessment so scanners
// can call markDirty() after an ingest completes.
await cmdbAssessmentSchedulerPlugin(fastify)

// AI plugin — direct call (like neo4j/postgres) so fastify.ai lands on
// the root instance and is visible to /ai routes. register(aiPlugin)
// would encapsulate and hide the decorator. Must run before aiRoutes.
await aiPlugin(fastify)

// Prometheus metrics. Registers /metrics (public — see plugins/metrics.js
// header for the auth stance) and the audit-buffer gauges. Direct call
// rather than register() so the decorator (fastify.metricsRegistry) is
// visible at the root, mirroring the other infrastructure plugins.
await metricsPlugin(fastify)

// Protected routes — mutations require a valid X-API-Key header when
// APPCLOUD_API_KEY is set. The fastify.authenticate decorator is a no-op
// when auth is disabled so the same preHandler works in both modes. The
// registration list (and order — prefix-priority comments live there)
// is shared with scripts/export-openapi.js + the drift test via
// utils/route-modules.js.
await registerAllRoutes(fastify)

fastify.get('/health', {
  schema: {
    tags:        ['Health'],
    summary:     'Liveness probe',
    description: 'Open — no auth required. Returns 200 with `status: "ok"` and the server clock. Use this for the K8s livenessProbe — it stays green even when DBs are degraded so pods aren\'t killed unnecessarily. Use /ready for the readinessProbe (which actually probes DB connectivity).',
    security:    [],
    response: {
      200: {
        type: 'object',
        properties: {
          status:    { type: 'string', example: 'ok' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
}, async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

// /ready — K8s readinessProbe target. Returns 200 only when both Postgres
// AND Neo4j are reachable. A degraded DB (Neo4j stub mode after a failed
// connect, or Postgres pool can't ping) returns 503 so K8s routes traffic
// away from this pod. Distinct from /health so a transient DB blip
// doesn't cause the pod to be killed (livenessProbe → restart) when
// removing it from service (readinessProbe → no traffic) is enough.
fastify.get('/ready', {
  schema: {
    tags:        ['Health'],
    summary:     'Readiness probe (DB connectivity)',
    description: 'Returns 200 + per-DB status when both Postgres and Neo4j are reachable. Returns 503 with the same shape (status `unavailable` for the failing DB) when either is unreachable — point K8s readinessProbe here so traffic routes away from degraded pods. Public — no auth required.',
    security:    [],
    response: {
      200: {
        type: 'object',
        properties: {
          status:   { type: 'string', example: 'ready' },
          postgres: { type: 'string', example: 'ok' },
          neo4j:    { type: 'string', example: 'ok' },
        },
      },
      503: {
        type: 'object',
        properties: {
          status:   { type: 'string', example: 'unavailable' },
          postgres: { type: 'string' },
          neo4j:    { type: 'string' },
          error:    { type: 'string' },
        },
      },
    },
  },
}, async (req, reply) => {
  // Probe both in parallel — ~2× faster than serial when one is slow.
  // Per-probe timeout via Promise.race so a hung backend doesn't blow
  // past the readinessProbe deadline.
  const PROBE_TIMEOUT_MS = parseInt(process.env.APPCLOUD_READY_TIMEOUT_MS || '2000', 10)
  const probe = (fn) => Promise.race([
    fn().then(() => 'ok').catch(err => err.message || 'failed'),
    new Promise(r => setTimeout(() => r(`timeout after ${PROBE_TIMEOUT_MS}ms`), PROBE_TIMEOUT_MS)),
  ])
  const [pgStatus, neoStatus] = await Promise.all([
    probe(() => fastify.pg.ping()),
    probe(() => fastify.neo4j.ping()),
  ])
  if (pgStatus === 'ok' && neoStatus === 'ok') {
    return { status: 'ready', postgres: 'ok', neo4j: 'ok' }
  }
  reply.code(503)
  return { status: 'unavailable', postgres: pgStatus, neo4j: neoStatus }
})

fastify.get('/', {
  schema: {
    tags:        ['Health'],
    summary:     'API banner',
    description: 'Returns the API name and version. Useful for confirming you hit the right host.',
    security:    [],
    response: {
      200: {
        type: 'object',
        properties: {
          name:    { type: 'string' },
          version: { type: 'string' },
        },
      },
    },
  },
}, async () => ({ name: 'AppCloud API', version: '1.1.0' }))

// ── Global error handler ─────────────────────────────────────────────────────
// Default Fastify behaviour returns `err.message` to the client which leaks
// internal file paths and stack-trace fragments (e.g. ai.js's handleAIError
// passes err.message straight through). In production we swap that for a
// generic message keyed by the request id so operators can grep the server
// logs while clients see no internals; in dev we keep the verbose form so
// the test/inspect loop stays fast.
fastify.setErrorHandler((err, req, reply) => {
  // Validation errors and explicit Fastify-shaped errors (sensible's
  // reply.notFound / .badRequest / etc.) already carry safe messages and a
  // statusCode — pass them through untouched.
  if (err.validation || (err.statusCode && err.statusCode < 500)) {
    return reply.send(err)
  }
  fastify.log.error({ err, reqId: req.id, url: req.url }, 'unhandled error')
  const code = err.statusCode || 500
  if (process.env.NODE_ENV === 'production') {
    return reply.code(code).send({
      statusCode: code,
      error:      err.name || 'Internal Server Error',
      message:    `internal error (request id: ${req.id})`,
    })
  }
  return reply.code(code).send({
    statusCode: code,
    error:      err.name || 'Internal Server Error',
    message:    err.message,
    stack:      err.stack,
  })
})

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Without these, a SIGTERM (k8s pod kill, docker stop) drops in-flight
// requests and leaks DB connections. fastify.close() drains the connection
// queue, runs onClose hooks (which DB plugins use to close their pools), and
// returns once everything's flushed.
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true
    fastify.log.info(`[shutdown] ${signal} received — closing fastify + plugins`)
    const forceExit = setTimeout(() => {
      fastify.log.error('[shutdown] timed out after 30s — forcing exit')
      process.exit(1)
    }, 30_000)
    try {
      await fastify.close()
      clearTimeout(forceExit)
      process.exit(0)
    } catch (err) {
      fastify.log.error({ err }, '[shutdown] error during close')
      clearTimeout(forceExit)
      process.exit(1)
    }
  })
}

try {
  await fastify.listen({ port: parseInt(process.env.PORT || '3000'), host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
