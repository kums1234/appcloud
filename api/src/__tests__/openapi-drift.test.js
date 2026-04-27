// Drift test — fails when docs/openapi.{json,yaml} is out of sync with
// what the live route registrations would generate. Catches the case
// where someone adds / changes / removes a route without re-running
// `npm run openapi:export`.
//
// Why a unit test (not a CI script): tests run in CI automatically and
// also run locally before commit, so developers see the failure at the
// moment they introduce the drift, with no extra setup.
//
// The test imports the same export logic the CLI script uses, builds
// the spec in-process against a stub Fastify (no DB connections), and
// diffs the output against the committed file. If you intentionally
// changed the API, run `npm run openapi:export` to refresh both the
// JSON and YAML artefacts and commit them alongside the route change.

import { describe, test, expect, beforeAll } from '@jest/globals'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { autoTagRoute } from '../utils/openapi-tags.js'
import { registerAllRoutes } from '../utils/route-modules.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot  = path.resolve(__dirname, '..', '..', '..')
const docsDir   = path.join(repoRoot, 'docs')

async function buildSpec() {
  const fastify = Fastify({
    logger: false,
    ajv: { customOptions: { strict: false, keywords: ['example', 'xml'] } },
  })

  // Stubs mirroring scripts/export-openapi.js so route registrations
  // succeed without real DB connections.
  fastify.decorate('authenticate',   async () => {})
  fastify.decorate('pg',             { pool: null, query: async () => [], audit: async () => {}, ping: async () => true })
  fastify.decorate('neo4j',          { write: async () => [], query: async () => [], ping: async () => true })
  fastify.decorate('ai',             { localAvailable: false, cloudAvailable: false })
  fastify.decorate('connectors',     { list: () => [], get: () => null })
  fastify.decorate('cmdbAssessment', { markDirty: () => {}, run: async () => ({}) })

  const swagger = (await import('@fastify/swagger')).default
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
      components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
      security:   [{ ApiKey: [] }],
    },
    transform: autoTagRoute,
  })

  await registerAllRoutes(fastify)

  // metricsPlugin registers /metrics — part of the live route surface
  // but structured as a plugin in server.js, so the export script and
  // this drift test need to invoke it explicitly to keep parity.
  const { metricsPlugin } = await import('../plugins/metrics.js')
  await metricsPlugin(fastify)

  fastify.get('/health', { schema: { tags: ['Health'], summary: 'Liveness probe', security: [] } },
    async () => ({ status: 'ok', timestamp: new Date().toISOString() }))
  fastify.get('/ready', { schema: { tags: ['Health'], summary: 'Readiness probe', security: [] } },
    async () => ({ status: 'ready', postgres: 'ok', neo4j: 'ok' }))
  fastify.get('/', { schema: { tags: ['Health'], summary: 'API banner', security: [] } },
    async () => ({ name: 'AppCloud API', version: '1.1.0' }))

  await fastify.ready()
  const json = fastify.swagger()
  const yaml = fastify.swagger({ yaml: true })
  await fastify.close()
  return { json, yaml }
}

describe('OpenAPI drift detection', () => {
  // buildSpec() boots a stub Fastify and registers every route — ~1.5s.
  // Both tests diff different artefacts of the same spec, so build once.
  let live
  beforeAll(async () => { live = await buildSpec() })

  test('docs/openapi.json matches live route registrations', async () => {
    const committed = await fs.readFile(path.join(docsDir, 'openapi.json'), 'utf8')
    const liveJson  = JSON.stringify(live.json, null, 2) + '\n'
    if (liveJson !== committed) {
      // Surface a useful diff hint: which path / method counts changed?
      const a = JSON.parse(committed)
      const b = live.json
      const aPaths = new Set(Object.keys(a.paths || {}))
      const bPaths = new Set(Object.keys(b.paths || {}))
      const removed = [...aPaths].filter(p => !bPaths.has(p))
      const added   = [...bPaths].filter(p => !aPaths.has(p))
      const hint    = added.length || removed.length
        ? `paths added: ${JSON.stringify(added)}; paths removed: ${JSON.stringify(removed)}`
        : 'paths match — schema/summary/description content drifted'
      throw new Error(
        `docs/openapi.json is out of sync with the route registrations.\n` +
        `Run: cd api && npm run openapi:export\n` +
        `Then commit the regenerated docs/openapi.{json,yaml} alongside your changes.\n\n` +
        `Hint: ${hint}`,
      )
    }
    expect(liveJson).toBe(committed)
  })

  test('docs/openapi.yaml matches live route registrations', async () => {
    const committed = await fs.readFile(path.join(docsDir, 'openapi.yaml'), 'utf8')
    if (live.yaml !== committed) {
      throw new Error(
        `docs/openapi.yaml is out of sync with the route registrations.\n` +
        `Run: cd api && npm run openapi:export — YAML is regenerated alongside JSON.`,
      )
    }
    expect(live.yaml).toBe(committed)
  })
})
