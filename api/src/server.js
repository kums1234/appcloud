import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import neo4jPlugin from './plugins/neo4j.js'
import applicationRoutes from './routes/applications.js'
import componentRoutes from './routes/components.js'
import infraRoutes from './routes/infra.js'
import changeRoutes from './routes/changes.js'
import userRoutes from './routes/users.js'
import graphRoutes from './routes/graph.js'

const fastify = Fastify({
  logger: true
})

// Plugins
await fastify.register(cors, { origin: true })
await fastify.register(sensible)
await fastify.register(neo4jPlugin)

// Routes
await fastify.register(applicationRoutes, { prefix: '/applications' })
await fastify.register(componentRoutes,   { prefix: '/components' })
await fastify.register(infraRoutes,        { prefix: '/infra' })
await fastify.register(changeRoutes,       { prefix: '/changes' })
await fastify.register(userRoutes,         { prefix: '/users' })
await fastify.register(graphRoutes,        { prefix: '/graph' })

// Health check
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

// Root — list all routes
fastify.get('/', async () => ({
  name: 'Neo4j Infrastructure Graph API',
  version: '1.0.0',
  endpoints: {
    applications: '/applications',
    components:   '/components',
    infra:        '/infra',
    changes:      '/changes',
    users:        '/users',
    graph:        '/graph',
    health:       '/health'
  }
}))

try {
  await fastify.listen({
    port: parseInt(process.env.PORT || '3000'),
    host: process.env.HOST || '0.0.0.0'
  })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
