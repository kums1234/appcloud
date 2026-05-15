import { describe, test, expect, jest } from '@jest/globals'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import graphRoutes from '../graph.js'

// Route-level test coverage for the two BFS-backed endpoints and the
// `/graph/summary` aggregate. Deep BFS-shape behaviour lives in
// services/__tests__/graph-walk.test.js — here we only assert what
// the route module adds on top:
//
//   - HTTP querystring → bfsWalk params plumbing
//   - 400 / 404 structured error envelopes (StandardErrorResponses)
//   - Polymorphic root acceptance (Infra rejected for /dependencies)
//   - One end-to-end smoke per endpoint to confirm wiring
//   - /graph/summary infraByRollup histogram

const node = (id, name, label, extra = {}) => ({
  properties: { id, name, ...extra },
  labels:     [label],
})
const rel = (props) => ({ properties: props })
const record = (obj) => ({ get: (k) => obj[k] })

function buildFastify({ rootRecords = [], layerResponses = [], ownerRecords = [], summaryRecords = {} }) {
  const layers = [...layerResponses]
  const query = jest.fn(async (cypher) => {
    // /graph/summary queries
    if (cypher.includes('count(DISTINCT a)') && cypher.includes('appCount')) {
      return summaryRecords.counts ?? [record({ appCount: 0, componentCount: 0, infraCount: 0, userCount: 0, publicInfra: 0 })]
    }
    if (cypher.includes('c.type AS type')) return summaryRecords.compTypes ?? []
    if (cypher.includes('i.provider AS provider, count(i) AS cnt')) return summaryRecords.infraProvider ?? []
    if (cypher.includes('count(r) AS connCount')) return summaryRecords.conn ?? [record({ connCount: 0 })]
    if (cypher.includes('i.provider AS provider, i.cloud_id AS cloud_id')) return summaryRecords.infraForRollup ?? []
    // bfsWalk queries
    if (cypher.includes('WHERE (root:Application')) return rootRecords
    if (cypher.includes('MATCH (a:Application)-[:CONTAINS]->(c:Component {id: cid})')) return ownerRecords
    if (cypher.includes('-[r:CONNECTS_TO]->(to)')) return layers.shift() ?? []
    if (cypher.includes('<-[r:CONNECTS_TO]-(to)')) return layers.shift() ?? []
    return []
  })
  const fastify = Fastify({ logger: false })
  fastify.register(sensible)
  fastify.decorate('neo4j', { query, write: async () => [], ping: async () => true })
  fastify.register(graphRoutes, { prefix: '/graph' })
  return { fastify, query }
}

// ── /graph/dependencies route plumbing ───────────────────────────────────────

describe('GET /graph/dependencies — route-level', () => {
  test('400 when id is missing', async () => {
    const { fastify } = buildFastify({})
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies' })
    await fastify.close()
    expect(res.statusCode).toBe(400)
  })

  test('404 envelope carries the diagnostic hint (StandardErrorResponses surfaces `message`)', async () => {
    const { fastify } = buildFastify({ rootRecords: [] })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=missing' })
    await fastify.close()
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('Not Found')
    expect(body.message).toMatch(/Infra ids use \/graph\/impact/)
  })

  test('smoke — Component root, returns 200 with the GraphWalkResponseSchema top-level shape', async () => {
    const comp = node('c-1', 'api', 'Component')
    const { fastify } = buildFastify({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [[]],
    })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=c-1' })
    await fastify.close()
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body).toMatchObject({
      root:      expect.objectContaining({ id: 'c-1', label: 'Component', name: 'api' }),
      seeds:     expect.any(Array),
      nodes:     expect.any(Array),
      edges:     expect.any(Array),
      rollups:   expect.any(Array),
      truncated: false,
      stats:     expect.objectContaining({ maxDepth: 10, nodeCap: 500 }),
    })
  })

  test('querystring overrides are plumbed through to bfsWalk', async () => {
    const comp = node('c-1', 'api', 'Component')
    const { fastify, query } = buildFastify({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [[]],
    })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=c-1&maxDepth=3&nodeCap=42&minConfidence=85' })
    await fastify.close()
    expect(JSON.parse(res.body).stats).toMatchObject({ maxDepth: 3, nodeCap: 42 })
    // minConfidence appears as a Cypher param on the per-layer query.
    const layerCall = query.mock.calls.find(c => c[0].includes('-[r:CONNECTS_TO]->(to)'))
    expect(layerCall[1]).toMatchObject({ minConfidence: 85 })
  })
})

// ── /graph/impact route plumbing ─────────────────────────────────────────────

describe('GET /graph/impact — route-level', () => {
  test('400 when id is missing', async () => {
    const { fastify } = buildFastify({})
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/impact' })
    await fastify.close()
    expect(res.statusCode).toBe(400)
  })

  test('404 envelope mentions all three valid root types', async () => {
    const { fastify } = buildFastify({ rootRecords: [] })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/impact?id=unknown' })
    await fastify.close()
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).message).toMatch(/Application, Component, or Infra/)
  })

  test('smoke — Infra root (the polymorphic shape) returns 200 with seeds=[Infra]', async () => {
    const inf = node('inf-1', 'subnet-1', 'Infra', { provider: 'azure' })
    const { fastify } = buildFastify({
      rootRecords: [record({ root: inf, lbls: ['Infra'], seeds: [inf] })],
      layerResponses: [[]],
    })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/impact?id=inf-1' })
    await fastify.close()
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.root).toMatchObject({ id: 'inf-1', label: 'Infra' })
    expect(body.seeds).toEqual([expect.objectContaining({ id: 'inf-1' })])
  })

  test('routes to inbound BFS Cypher (`<-` arrow)', async () => {
    const inf = node('inf-1', 'subnet-1', 'Infra')
    const { fastify, query } = buildFastify({
      rootRecords: [record({ root: inf, lbls: ['Infra'], seeds: [inf] })],
      layerResponses: [[]],
    })
    await fastify.ready()
    await fastify.inject({ method: 'GET', url: '/graph/impact?id=inf-1' })
    await fastify.close()
    expect(query.mock.calls.some(c => c[0].includes('<-[r:CONNECTS_TO]-(to)'))).toBe(true)
    expect(query.mock.calls.some(c => c[0].includes('-[r:CONNECTS_TO]->(to)'))).toBe(false)
  })
})

// ── /graph/summary infraByRollup ─────────────────────────────────────────────

describe('GET /graph/summary — infraByRollup aggregate', () => {
  test('every Infra is bucketed by its rollup; histogram sorted by count desc', async () => {
    const { fastify } = buildFastify({
      summaryRecords: {
        counts: [record({ appCount: 1, componentCount: 1, infraCount: 4, userCount: 0, publicInfra: 0 })],
        infraProvider: [record({ provider: 'azure', cnt: 4 })],
        infraForRollup: [
          record({ provider: 'azure', cloud_id: '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-1' }),
          record({ provider: 'azure', cloud_id: '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Compute/disks/d-1' }),
          record({ provider: 'azure', cloud_id: '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Network/networkInterfaces/n-1' }),
          record({ provider: 'azure', cloud_id: '/subscriptions/abc/resourceGroups/rg-network/providers/Microsoft.Network/virtualNetworks/vnet-1/subnets/s-1' }),
        ],
      },
    })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/summary' })
    await fastify.close()
    expect(JSON.parse(res.body).infraByRollup).toEqual([
      { kind: 'azure-resource-group', key: 'rg-prod',    count: 3 },
      { kind: 'azure-resource-group', key: 'rg-network', count: 1 },
    ])
  })

  test('Infra without a parseable cloud_id is dropped from the histogram (no nulls)', async () => {
    const { fastify } = buildFastify({
      summaryRecords: {
        counts: [record({ appCount: 0, componentCount: 0, infraCount: 2, userCount: 0, publicInfra: 0 })],
        infraForRollup: [
          record({ provider: 'azure',   cloud_id: '/subscriptions/abc/providers/Microsoft.Subscription/aliases/foo' }),
          record({ provider: 'unknown', cloud_id: 'whatever' }),
        ],
      },
    })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/summary' })
    await fastify.close()
    expect(JSON.parse(res.body).infraByRollup).toEqual([])
  })
})
