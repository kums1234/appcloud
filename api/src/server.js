import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import { neo4jPlugin } from './plugins/neo4j.js'
import { postgresPlugin } from './plugins/postgres.js'
import applicationRoutes from './routes/applications.js'
import componentRoutes from './routes/components.js'
import infraRoutes from './routes/infra.js'
import changeRoutes from './routes/changes.js'
import userRoutes from './routes/users.js'
import graphRoutes from './routes/graph.js'
import integrationRoutes from './routes/integrations.js'

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

// Routes
await fastify.register(applicationRoutes,  { prefix: '/applications' })
await fastify.register(componentRoutes,    { prefix: '/components' })
await fastify.register(infraRoutes,        { prefix: '/infra' })
await fastify.register(changeRoutes,       { prefix: '/changes' })
await fastify.register(userRoutes,         { prefix: '/users' })
await fastify.register(graphRoutes,        { prefix: '/graph' })
await fastify.register(integrationRoutes,  { prefix: '/integrations' })

fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))
fastify.get('/', async () => ({ name: 'AppCloud API', version: '1.1.0' }))

try {
  await fastify.listen({ port: parseInt(process.env.PORT || '3000'), host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}