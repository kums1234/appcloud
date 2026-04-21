import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import { neo4jPlugin } from './plugins/neo4j.js'
import { postgresPlugin } from './plugins/postgres.js'
import { authPlugin } from './plugins/auth.js'
import authRoutes from './routes/auth.js'
import applicationRoutes from './routes/applications.js'
import componentRoutes from './routes/components.js'
import infraRoutes from './routes/infra.js'
import changeRoutes from './routes/changes.js'
import userRoutes from './routes/users.js'
import graphRoutes from './routes/graph.js'
import integrationRoutes from './routes/integrations.js'
import cloudAccountRoutes from './routes/integrations-cloud.js'
import aiConfigRoutes from './routes/integrations-ai.js'
import integrationManagementRoutes, { connectorsRegistryRoutes } from './routes/integrations.management.js'
import complianceRoutes from './routes/compliance.js'
import { complianceSchedulerPlugin } from './plugins/compliance-scheduler.js'
import { connectorsPlugin } from './plugins/connectors.js'
import { otelAggregatorPlugin } from './plugins/otel-aggregator.js'
import { schedulerPlugin } from './plugins/scheduler.js'
import governanceRoutes from './routes/governance.js'
import workflowRoutes from './routes/workflows.js'
import discoveryRoutes from './routes/discovery.js'
import auditRoutes from './routes/audit.js'
import { aiPlugin } from './plugins/ai.js'
import aiRoutes from './routes/ai.js'

const fastify = Fastify({ logger: true })

// Core plugins (these use @fastify/cors and @fastify/sensible which handle
// their own scoping correctly via their built-in fastify-plugin wrappers)
await fastify.register(cors, { origin: true })
await fastify.register(sensible)

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

// Connector framework — loads registry, applies integrations-table evolution
// DDL, and registers push-style receivers (e.g. OTel ingest). Must come after
// pg + neo4j plugins and before routes that reference fastify.connectors.
await connectorsPlugin(fastify)

// OTel aggregator — periodic worker that drains otel_spans_raw into Neo4j.
// Tick interval via OTEL_AGG_INTERVAL_MS (default 60_000).
await otelAggregatorPlugin(fastify)

// Scheduler — starts after server ready, requires pg to be initialised
await schedulerPlugin(fastify)
await complianceSchedulerPlugin(fastify)

// Public routes (no auth required)
await fastify.register(authRoutes, { prefix: '/auth' })

// Protected routes — mutations require a valid JWT when JWT_SECRET is set.
// The fastify.authenticate decorator is a no-op when auth is disabled so
// the same preHandler works in both modes.
await fastify.register(applicationRoutes,  { prefix: '/applications' })
await fastify.register(componentRoutes,    { prefix: '/components' })
await fastify.register(infraRoutes,        { prefix: '/infra' })
await fastify.register(changeRoutes,       { prefix: '/changes' })
await fastify.register(userRoutes,         { prefix: '/users' })
await fastify.register(graphRoutes,        { prefix: '/graph' })
await fastify.register(integrationRoutes,          { prefix: '/integrations' })
await fastify.register(cloudAccountRoutes,         { prefix: '/integrations' })
await fastify.register(aiConfigRoutes,             { prefix: '/integrations' })
// Generic integrations CRUD — registered after the above so static paths
// (/terraform/*, /cloud/*, /ai/*) keep their priority over :id. Also exposes
// /connectors for the connector registry listing.
await fastify.register(integrationManagementRoutes, { prefix: '/integrations' })
await fastify.register(connectorsRegistryRoutes,    { prefix: '/connectors' })
await fastify.register(governanceRoutes,    { prefix: '/governance' })
await fastify.register(complianceRoutes,    { prefix: '/compliance' })
await fastify.register(workflowRoutes,      { prefix: '/workflows' })
await fastify.register(discoveryRoutes,     { prefix: '/discovery' })
await fastify.register(auditRoutes,         { prefix: '/audit' })
// AI plugin — direct call (like neo4j/postgres) so fastify.ai is on the root instance
// and visible to /ai routes. register(aiPlugin) would encapsulate and hide the decorator.
await aiPlugin(fastify)
// Next.js rewrites /api/* → API host without a second /api prefix (see ui/next.config.js).
await fastify.register(aiRoutes, { prefix: '/ai' })

fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))
fastify.get('/', async () => ({ name: 'AppCloud API', version: '1.1.0' }))

try {
  await fastify.listen({ port: parseInt(process.env.PORT || '3000'), host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
