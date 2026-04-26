#!/usr/bin/env node
//
// Boots a minimal Fastify instance that registers every route, asks
// @fastify/swagger for the generated spec, writes it to docs/openapi.yaml +
// docs/openapi.json, and exits. Run via `npm run openapi:export` from the
// api/ directory.
//
// We intentionally do NOT initialise the database plugins — they connect to
// real Neo4j / Postgres which we don't need here. The route handlers
// reference fastify.pg.pool and fastify.neo4j at request time, so registering
// without those decorators is fine for spec generation.

import Fastify from 'fastify'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot  = path.resolve(__dirname, '..', '..')
const docsDir   = path.join(repoRoot, 'docs')

const fastify = Fastify({
  logger: false,
  ajv: { customOptions: { strict: false, keywords: ['example', 'xml'] } },
})

// Stub the decorators that the auth plugin and route handlers expect, so
// route registration doesn't blow up on missing fastify.authenticate /
// fastify.pg / fastify.neo4j / fastify.ai / fastify.connectors.
fastify.decorate('authenticate',     async () => {})
fastify.decorate('pg',               { pool: null, query: async () => [], audit: async () => {} })
fastify.decorate('neo4j',            { write: async () => [], query: async () => [] })
fastify.decorate('ai',               { localAvailable: false, cloudAvailable: false })
fastify.decorate('connectors',       { list: () => [], get: () => null })
fastify.decorate('cmdbAssessment',   { markDirty: () => {}, run: async () => ({}) })

// Register Swagger first so subsequent route registrations are picked up.
const swagger   = (await import('@fastify/swagger')).default
const swaggerUI = (await import('@fastify/swagger-ui')).default

const PATH_SEG_TO_TAG = {
  applications: 'Applications', components: 'Components', infra: 'Infra',
  graph: 'Graph', ai: 'AI', audit: 'Audit', cmdb: 'CMDB',
  discovery: 'Discovery', integrations: 'Integrations',
  connectors: 'Connectors', health: 'Health', docs: 'OpenAPI', openapi: 'OpenAPI',
  admin: 'Admin',
}
function autoTagRoute({ schema, url }) {
  if (schema?.tags?.length) return { schema, url }
  const seg = url.split('/').filter(Boolean)[0]
  return { schema: { ...(schema || {}), tags: [PATH_SEG_TO_TAG[seg] || 'Other'] }, url }
}

await fastify.register(swagger, {
  openapi: {
    openapi: '3.0.3',
    info: {
      title:       'AppCloud API',
      description: 'Knowledge graph platform for infrastructure dependency mapping and blast-radius analysis.',
      version:     '1.1.0',
    },
    servers: [
      { url: 'http://localhost:3000' },
      { url: 'http://appcloud.local'  },
    ],
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
    security: [{ ApiKey: [] }],
  },
  transform: autoTagRoute,
})
await fastify.register(swaggerUI, { routePrefix: '/docs' })

// Register every route module.
const apiSrc = path.join(repoRoot, 'api', 'src')
const modules = [
  ['./routes/applications.js',          { prefix: '/applications' }],
  ['./routes/components.js',            { prefix: '/components'   }],
  ['./routes/infra.js',                 { prefix: '/infra'        }],
  ['./routes/graph.js',                 { prefix: '/graph'        }],
  ['./routes/integrations.js',          { prefix: '/integrations' }],
  ['./routes/integrations-cloud.js',    { prefix: '/integrations' }],
  ['./routes/integrations-ai.js',       { prefix: '/integrations' }],
  ['./routes/integrations.management.js', { prefix: '/integrations' }],
  ['./routes/discovery.js',             { prefix: '/discovery'    }],
  ['./routes/discovery.metadata.js',    { prefix: '/discovery'    }],
  ['./routes/audit.js',                 { prefix: '/audit'        }],
  ['./routes/cmdb.js',                  { prefix: '/cmdb'         }],
  ['./routes/ai.js',                    { prefix: '/ai'           }],
  ['./routes/admin-api-keys.js',        { prefix: '/admin'        }],
]
for (const [rel, opts] of modules) {
  try {
    const mod = await import(path.join(apiSrc, rel))
    await fastify.register(mod.default, opts)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[export-openapi] skipped ${rel}: ${err.message}`)
  }
}
// Connectors registry
try {
  const m = await import(path.join(apiSrc, './routes/integrations.management.js'))
  if (m.connectorsRegistryRoutes) await fastify.register(m.connectorsRegistryRoutes, { prefix: '/connectors' })
} catch {}

// Health endpoints — match server.js
fastify.get('/health', { schema: { tags: ['Health'], summary: 'Liveness probe', security: [] } },
  async () => ({ status: 'ok', timestamp: new Date().toISOString() }))
fastify.get('/', { schema: { tags: ['Health'], summary: 'API banner', security: [] } },
  async () => ({ name: 'AppCloud API', version: '1.1.0' }))

await fastify.ready()

// Generate, write, exit.
const spec = fastify.swagger()
const yamlBody = (await import('@fastify/swagger')).default
// fastify.swagger() returns the spec; @fastify/swagger also exposes
// swagger({ yaml: true }) for YAML form via the same function with
// `{ yaml: true }` arg.
const yamlSpec = fastify.swagger({ yaml: true })

await fs.mkdir(docsDir, { recursive: true })
await fs.writeFile(path.join(docsDir, 'openapi.json'), JSON.stringify(spec, null, 2) + '\n')
await fs.writeFile(path.join(docsDir, 'openapi.yaml'), yamlSpec)

const pathCount = Object.keys(spec.paths || {}).length
// eslint-disable-next-line no-console
console.log(`[export-openapi] wrote docs/openapi.{json,yaml} — ${pathCount} paths`)

// Convert OpenAPI → Postman v2.1 collection. Hand-curated Quickstart
// folder is prepended; otherwise content is mechanically derived from
// the spec. Use `Import → File` in Postman.
const postman = (await import('openapi-to-postmanv2')).default
const postmanSpec = await new Promise((resolve, reject) => {
  postman.convert(
    { type: 'json', data: JSON.stringify(spec) },
    {
      folderStrategy:        'Tags',                 // group by OpenAPI tag
      requestParametersResolution: 'Example',
      exampleParametersResolution: 'Example',
      includeAuthInfoInExample:    false,
      enableOptionalParameters:    true,
    },
    (err, result) => err ? reject(err) : resolve(result),
  )
})
if (!postmanSpec.result || !postmanSpec.output?.length) {
  throw new Error(`openapi-to-postmanv2 conversion failed: ${JSON.stringify(postmanSpec.reason || postmanSpec)}`)
}
const collection = postmanSpec.output[0].data

// Inject the human-curated Quickstart group so the generated collection
// keeps the same ergonomic onboarding the hand-curated one had.
const quickstart = {
  name: 'Quickstart',
  description: 'Start here. The first three requests confirm wiring; the rest are organised by OpenAPI tag (Discovery, Applications, Components, …).',
  item: [
    {
      name: 'GET /health',
      request: { method: 'GET', auth: { type: 'noauth' },
        url: { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] },
        description: 'Liveness probe. Open — no auth required.' },
    },
    {
      name: 'GET /openapi.json',
      request: { method: 'GET',
        url: { raw: '{{baseUrl}}/openapi.json', host: ['{{baseUrl}}'], path: ['openapi.json'] },
        description: 'Live OpenAPI spec. This collection is auto-derived from it.' },
    },
    {
      name: 'GET /graph/topology',
      request: { method: 'GET',
        url: { raw: '{{baseUrl}}/graph/topology', host: ['{{baseUrl}}'], path: ['graph', 'topology'] },
        description: 'Single-shot topology snapshot — apps, components, infra, connections.' },
    },
  ],
}
collection.item = [quickstart, ...(collection.item || [])]

// Override the auto-generated baseUrl variable with our preferred default
// and wire X-API-Key auth at the collection level.
collection.variable = [
  { key: 'baseUrl', value: 'http://localhost:3000', type: 'string' },
  { key: 'apiKey',  value: '',                       type: 'string' },
]
collection.auth = {
  type: 'apikey',
  apikey: [
    { key: 'key',   value: 'X-API-Key',   type: 'string' },
    { key: 'value', value: '{{apiKey}}',  type: 'string' },
    { key: 'in',    value: 'header',      type: 'string' },
  ],
}
collection.info = {
  ...collection.info,
  name:        'AppCloud API',
  description: 'Generated from docs/openapi.yaml via `npm run openapi:export`.\n\n## Setup\n1. Set `baseUrl` (default `http://localhost:3000`) and `apiKey`\n2. Hit `Quickstart → GET /health`\n3. Walk the per-tag folders for full CRUD coverage\n\nFor narrative workflow recipes, see `docs/api-guide.md §13`.',
  schema:      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
}

await fs.writeFile(
  path.join(docsDir, 'api-postman-collection.json'),
  JSON.stringify(collection, null, 2) + '\n',
)
const requestCount = (function count(items = []) {
  return items.reduce((n, it) => n + (it.request ? 1 : count(it.item || [])), 0)
})(collection.item)
// eslint-disable-next-line no-console
console.log(`[export-openapi] wrote docs/api-postman-collection.json — ${requestCount} requests across ${collection.item.length} folders`)

await fastify.close()
