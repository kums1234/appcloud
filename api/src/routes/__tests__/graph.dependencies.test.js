import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import graphRoutes from '../graph.js'

// Behavioural coverage for GET /graph/dependencies — the inverse-of-impact
// query the API guide calls out for incident response. The route does a
// JS-driven BFS over `:CONNECTS_TO`, so the contract worth locking is:
//
//   1. Root detection: Application id fans out to contained Components
//      as seeds; Component id seeds itself. Infra ids 404.
//   2. BFS shape: nodes carry `depth` (1 = direct), edges carry the full
//      :CONNECTS_TO property contract (source/via/confidence/evidence)
//      plus any writer-specific extras.
//   3. minConfidence threshold: low-confidence edges are filtered before
//      BFS visits the target.
//   4. nodeCap: BFS halts early and `truncated: true` is reported.
//   5. Owner Application join-back: every reached Component is annotated
//      with its owning Application (incident responders need this for
//      cross-app blast-context).

const node = (id, name, label, extra = {}) => ({
  properties: { id, name, ...extra },
  labels:     [label],
})
const rel = (props) => ({ properties: props })

function buildFastify({ rootRecords, layerResponses, ownerRecords = [] }) {
  // The route fires queries in this order:
  //   1) root resolution
  //   2..N) BFS layers (one per depth while frontier non-empty)
  //   N+1) owner Application join-back (only if ≥1 Component reached)
  //
  // We model that by returning rootRecords first, then peeling
  // layerResponses one at a time, then ownerRecords for the final call.
  const layers = [...layerResponses]
  const query = jest.fn(async (cypher) => {
    if (cypher.includes('WHERE root:Application OR root:Component')) return rootRecords
    if (cypher.includes('MATCH (a:Application)-[:CONTAINS]->(c:Component {id: cid})')) return ownerRecords
    if (cypher.includes('-[r:CONNECTS_TO]->(to)')) {
      return layers.shift() ?? []
    }
    return []
  })
  const fastify = Fastify({ logger: false })
  fastify.register(sensible)
  fastify.decorate('neo4j', { query, write: async () => [], ping: async () => true })
  fastify.register(graphRoutes, { prefix: '/graph' })
  return { fastify, query }
}

// Convenience: build a Neo4j-style record from a plain object.
const record = (obj) => ({ get: (k) => obj[k] })

describe('GET /graph/dependencies — root resolution', () => {
  test('404 when id matches nothing (also rejects Infra ids)', async () => {
    const { fastify } = buildFastify({ rootRecords: [], layerResponses: [] })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=11111111-1111-1111-1111-111111111111' })
    await fastify.close()
    expect(res.statusCode).toBe(404)
    // The 404 response schema only surfaces `error`; the human-readable
    // hint that Infra ids belong on /graph/impact is in the message but
    // gets serialized out. Asserting status + error suffices.
    expect(JSON.parse(res.body).error).toBe('Not Found')
  })

  test('400 when id is missing', async () => {
    const { fastify } = buildFastify({ rootRecords: [], layerResponses: [] })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies' })
    await fastify.close()
    expect(res.statusCode).toBe(400)
  })

  test('Component root seeds itself', async () => {
    const compNode = node('c-1', 'api-service', 'Component')
    const rootRecords = [record({ root: compNode, lbls: ['Component'], seeds: [compNode] })]
    const { fastify } = buildFastify({ rootRecords, layerResponses: [[]] })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=c-1' })
    await fastify.close()
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.root).toMatchObject({ id: 'c-1', label: 'Component', name: 'api-service' })
    expect(body.startComponents).toEqual([expect.objectContaining({ id: 'c-1' })])
    expect(body.nodes).toEqual([])
    expect(body.edges).toEqual([])
    expect(body.truncated).toBe(false)
    expect(body.stats.reachedDepth).toBe(0)
  })

  test('Application root fans out to contained Components', async () => {
    const appNode = node('app-1', 'payments', 'Application', { tier: 1 })
    const c1 = node('c-1', 'api', 'Component')
    const c2 = node('c-2', 'worker', 'Component')
    const rootRecords = [record({ root: appNode, lbls: ['Application'], seeds: [c1, c2] })]
    const { fastify } = buildFastify({ rootRecords, layerResponses: [[]] })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=app-1' })
    await fastify.close()
    const body = JSON.parse(res.body)
    expect(body.root).toMatchObject({ id: 'app-1', label: 'Application', name: 'payments', tier: 1 })
    expect(body.startComponents.map(c => c.id).sort()).toEqual(['c-1', 'c-2'])
  })
})

describe('GET /graph/dependencies — BFS shape and edge contract', () => {
  test('multi-hop walk produces depth-tagged nodes and full-contract edges', async () => {
    const comp   = node('c-1', 'api', 'Component')
    const vm     = node('inf-vm',     'vm-01',     'Infra', { provider: 'azure', resource_type: 'VirtualMachines' })
    const nic    = node('inf-nic',    'vm-01-nic', 'Infra', { provider: 'azure', resource_type: 'NetworkInterfaces' })
    const subnet = node('inf-subnet', 'web-subnet','Infra', { provider: 'azure', resource_type: 'Subnets' })

    const rootRecords = [record({ root: comp, lbls: ['Component'], seeds: [comp] })]
    const layerResponses = [
      // depth 1: api -> vm  (component-mapping, score 75)
      [record({
        fromId:   'c-1',
        to:       vm,
        r:        rel({ source: 'auto-link', via: 'component-mapping', confidence: 75, evidence: 'rule-r2', discovered_at: '2026-04-01T00:00:00Z' }),
        toLabels: ['Infra'],
      })],
      // depth 2: vm -> nic
      [record({
        fromId:   'inf-vm',
        to:       nic,
        r:        rel({ source: 'azure-resource-graph', via: 'nic', confidence: 90, evidence: 'arm-properties.networkProfile' }),
        toLabels: ['Infra'],
      })],
      // depth 3: nic -> subnet
      [record({
        fromId:   'inf-nic',
        to:       subnet,
        r:        rel({ source: 'azure-resource-graph', via: 'subnet', confidence: 80, evidence: 'arm-properties.ipConfigurations' }),
        toLabels: ['Infra'],
      })],
      // depth 4: subnet has no outbound -> empty halts the walk
      [],
    ]
    const ownerRecords = []   // no Components reached -> owner join is skipped

    const { fastify, query } = buildFastify({ rootRecords, layerResponses, ownerRecords })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=c-1' })
    await fastify.close()
    const body = JSON.parse(res.body)

    expect(res.statusCode).toBe(200)
    expect(body.nodes.map(n => ({ id: n.id, depth: n.depth, label: n.label }))).toEqual([
      { id: 'inf-vm',     depth: 1, label: 'Infra' },
      { id: 'inf-nic',    depth: 2, label: 'Infra' },
      { id: 'inf-subnet', depth: 3, label: 'Infra' },
    ])
    expect(body.edges).toEqual([
      expect.objectContaining({ from: 'c-1',     to: 'inf-vm',     via: 'component-mapping', source: 'auto-link',            confidence: 75 }),
      expect.objectContaining({ from: 'inf-vm',  to: 'inf-nic',    via: 'nic',               source: 'azure-resource-graph', confidence: 90 }),
      expect.objectContaining({ from: 'inf-nic', to: 'inf-subnet', via: 'subnet',            source: 'azure-resource-graph', confidence: 80 }),
    ])
    expect(body.truncated).toBe(false)
    expect(body.stats.reachedDepth).toBe(3)

    // Halts cleanly once a layer returns empty — no owner join is attempted
    // because no Components were reached at depth>0.
    const cypherCalls = query.mock.calls.map(c => c[0])
    expect(cypherCalls.some(c => c.includes('MATCH (a:Application)-[:CONTAINS]->(c:Component {id: cid})'))).toBe(false)
  })

  test('minConfidence is passed through to the BFS query', async () => {
    const comp = node('c-1', 'api', 'Component')
    const rootRecords = [record({ root: comp, lbls: ['Component'], seeds: [comp] })]
    const { fastify, query } = buildFastify({ rootRecords, layerResponses: [[]] })
    await fastify.ready()
    await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=c-1&minConfidence=75' })
    await fastify.close()
    const bfsCall = query.mock.calls.find(c => c[0].includes('-[r:CONNECTS_TO]->(to)'))
    expect(bfsCall[1]).toMatchObject({ minConfidence: 75 })
  })
})

describe('GET /graph/dependencies — nodeCap truncation', () => {
  test('halts BFS early and reports truncated=true', async () => {
    const comp = node('c-1', 'api', 'Component')
    // Three direct dependencies; nodeCap=2 should clip the third out.
    const i1 = node('i-1', 'i-1', 'Infra')
    const i2 = node('i-2', 'i-2', 'Infra')
    const i3 = node('i-3', 'i-3', 'Infra')
    const rootRecords = [record({ root: comp, lbls: ['Component'], seeds: [comp] })]
    const layerResponses = [
      [
        record({ fromId: 'c-1', to: i1, r: rel({ source: 'auto-link', via: 'component-mapping', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] }),
        record({ fromId: 'c-1', to: i2, r: rel({ source: 'auto-link', via: 'component-mapping', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] }),
        record({ fromId: 'c-1', to: i3, r: rel({ source: 'auto-link', via: 'component-mapping', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] }),
      ],
    ]
    const { fastify } = buildFastify({ rootRecords, layerResponses })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=c-1&nodeCap=2' })
    await fastify.close()
    const body = JSON.parse(res.body)
    expect(body.truncated).toBe(true)
    // The seed counts toward visited (depth 0), so a nodeCap of 2 admits one
    // dependency before tripping. The first record processed wins.
    expect(body.nodes.length).toBe(1)
  })
})

describe('GET /graph/dependencies — owner Application join-back', () => {
  test('reached Components are annotated with their owning Application', async () => {
    const comp = node('c-1', 'api', 'Component')
    const remoteComp = node('c-99', 'billing', 'Component')
    const rootRecords = [record({ root: comp, lbls: ['Component'], seeds: [comp] })]
    const layerResponses = [
      [record({
        fromId:   'c-1',
        to:       remoteComp,
        r:        rel({ source: 'otel', via: 'otel-http', confidence: 80, evidence: 'observed', protocol: 'HTTPS', port: 443 }),
        toLabels: ['Component'],
      })],
      [],   // c-99 has no outbound, halts
    ]
    const ownerRecords = [
      record({ id: 'c-99', appId: 'app-bil', appName: 'billing-app', appTier: 1 }),
    ]
    const { fastify } = buildFastify({ rootRecords, layerResponses, ownerRecords })
    await fastify.ready()
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=c-1' })
    await fastify.close()
    const body = JSON.parse(res.body)
    expect(body.nodes).toEqual([
      expect.objectContaining({
        id: 'c-99', label: 'Component', depth: 1,
        ownerAppId: 'app-bil', ownerAppName: 'billing-app', ownerAppTier: 1,
      }),
    ])
    // The edge carries telemetry-flavoured extras alongside the contract.
    expect(body.edges[0]).toMatchObject({
      from: 'c-1', to: 'c-99', via: 'otel-http', source: 'otel', confidence: 80,
      protocol: 'HTTPS', port: 443,
    })
  })
})
