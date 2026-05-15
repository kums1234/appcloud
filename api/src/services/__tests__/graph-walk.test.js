import { describe, test, expect, jest } from '@jest/globals'
import { bfsWalk, WALK_DEFAULTS } from '../graph-walk.js'

// Service-level unit tests for the shared BFS helper used by
// /graph/dependencies, /graph/impact, and /ai/infra/:id/impact. Lives
// here rather than in routes/__tests__ because the helper has multiple
// consumers now — testing through one route's HTTP layer makes failures
// harder to diagnose than a direct call with a mocked `query`. The
// route test file keeps a thin layer of route-plumbing coverage
// (querystring → params, error envelope, status codes) on top.
//
// Contract under test:
//
//   1. Root detection: Application fans out to contained Components as
//      seeds; Component/Infra seeds itself. Outbound walks reject Infra
//      roots; inbound walks accept all three. Missing root → null.
//   2. Direction shapes Cypher arrow (outbound `->`, inbound `<-`) but
//      edges are always presented in writer-emitted direction.
//   3. Per-layer Cypher pushes minConfidence into a parameter.
//   4. Node + edge dedup keys: from/to/via/source(+role+protocol).
//   5. Owner-Application join-back annotates reached Components.
//   6. Per-Infra rollup annotation + aggregate histogram (kind+key+count).
//   7. propagateLabels controls which labels seed the next frontier.
//   8. nodeCap halts BFS mid-layer; reports truncated=true.
//   9. maxDepth halts at depth; reports truncated=true when frontier non-empty.

const node = (id, name, label, extra = {}) => ({
  properties: { id, name, ...extra },
  labels:     [label],
})
const rel = (props) => ({ properties: props })
const record = (obj) => ({ get: (k) => obj[k] })

// Build a `query` mock that returns rootRecords first, then peels
// layerResponses one-by-one for each BFS layer, then ownerRecords for
// the post-walk Application join. Matches the order bfsWalk fires.
function makeQueryMock({ rootRecords = [], layerResponses = [], ownerRecords = [] }) {
  const layers = [...layerResponses]
  return jest.fn(async (cypher) => {
    if (cypher.includes('WHERE (root:Application')) return rootRecords
    if (cypher.includes('MATCH (a:Application)-[:CONTAINS]->(c:Component {id: cid})')) return ownerRecords
    if (cypher.includes('-[r:CONNECTS_TO]->(to)')) return layers.shift() ?? []
    if (cypher.includes('<-[r:CONNECTS_TO]-(to)')) return layers.shift() ?? []
    return []
  })
}

const callBfs = (opts) => bfsWalk({
  rootId:        opts.rootId       ?? 'r-1',
  direction:     opts.direction    ?? 'outbound',
  maxDepth:      opts.maxDepth     ?? WALK_DEFAULTS.maxDepth,
  nodeCap:       opts.nodeCap      ?? WALK_DEFAULTS.nodeCap,
  minConfidence: opts.minConfidence ?? 0,
  ...opts,
})

// ── Root resolution ──────────────────────────────────────────────────────────

describe('bfsWalk — root resolution', () => {
  test('returns null when root not found', async () => {
    const query = makeQueryMock({ rootRecords: [] })
    expect(await callBfs({ query, rootId: 'missing' })).toBeNull()
  })

  test('outbound walk uses (Application OR Component) root-label filter', async () => {
    const compNode = node('c-1', 'api', 'Component')
    const query = makeQueryMock({
      rootRecords: [record({ root: compNode, lbls: ['Component'], seeds: [compNode] })],
      layerResponses: [[]],
    })
    await callBfs({ query, direction: 'outbound', rootId: 'c-1' })
    const rootCall = query.mock.calls[0][0]
    expect(rootCall).toMatch(/root:Application OR root:Component/)
    expect(rootCall).not.toMatch(/root:Infra/)
  })

  test('inbound walk also accepts Infra roots', async () => {
    const infraNode = node('inf-1', 'subnet-1', 'Infra')
    const query = makeQueryMock({
      rootRecords: [record({ root: infraNode, lbls: ['Infra'], seeds: [infraNode] })],
      layerResponses: [[]],
    })
    await callBfs({ query, direction: 'inbound', rootId: 'inf-1' })
    const rootCall = query.mock.calls[0][0]
    expect(rootCall).toMatch(/root:Application OR root:Component OR root:Infra/)
  })

  test('Application root fans out to contained Components as seeds', async () => {
    const appNode = node('app-1', 'payments', 'Application', { tier: 1 })
    const c1 = node('c-1', 'api', 'Component')
    const c2 = node('c-2', 'worker', 'Component')
    const query = makeQueryMock({
      rootRecords: [record({ root: appNode, lbls: ['Application'], seeds: [c1, c2] })],
      layerResponses: [[]],
    })
    const result = await callBfs({ query, rootId: 'app-1' })
    expect(result.root).toMatchObject({ id: 'app-1', label: 'Application', name: 'payments', tier: 1 })
    expect(result.seeds.map(s => s.id).sort()).toEqual(['c-1', 'c-2'])
  })

  test('seeds are excluded from nodes (depth 0)', async () => {
    const compNode = node('c-1', 'api', 'Component')
    const query = makeQueryMock({
      rootRecords: [record({ root: compNode, lbls: ['Component'], seeds: [compNode] })],
      layerResponses: [[]],
    })
    const result = await callBfs({ query, rootId: 'c-1' })
    expect(result.nodes).toEqual([])
    expect(result.stats.reachedDepth).toBe(0)
  })
})

// ── Direction & edge presentation ────────────────────────────────────────────

describe('bfsWalk — direction & edge presentation', () => {
  test('outbound uses `->` Cypher arrow', async () => {
    const compNode = node('c-1', 'api', 'Component')
    const query = makeQueryMock({
      rootRecords: [record({ root: compNode, lbls: ['Component'], seeds: [compNode] })],
      layerResponses: [[]],
    })
    await callBfs({ query, direction: 'outbound', rootId: 'c-1' })
    expect(query.mock.calls.some(c => c[0].includes('-[r:CONNECTS_TO]->(to)'))).toBe(true)
    expect(query.mock.calls.some(c => c[0].includes('<-[r:CONNECTS_TO]-(to)'))).toBe(false)
  })

  test('inbound uses `<-` Cypher arrow', async () => {
    const compNode = node('c-1', 'api', 'Component')
    const query = makeQueryMock({
      rootRecords: [record({ root: compNode, lbls: ['Component'], seeds: [compNode] })],
      layerResponses: [[]],
    })
    await callBfs({ query, direction: 'inbound', rootId: 'c-1' })
    expect(query.mock.calls.some(c => c[0].includes('-[r:CONNECTS_TO]->(to)'))).toBe(false)
    expect(query.mock.calls.some(c => c[0].includes('<-[r:CONNECTS_TO]-(to)'))).toBe(true)
  })

  test('inbound walk presents edges in writer direction (VM→NIC), not BFS direction', async () => {
    const nicNode = node('inf-nic', 'vm-1-nic', 'Infra')
    const vmNode  = node('inf-vm',  'vm-1',     'Infra')
    const query = makeQueryMock({
      rootRecords: [record({ root: nicNode, lbls: ['Infra'], seeds: [nicNode] })],
      layerResponses: [
        [record({
          fromId:   'inf-nic',
          to:       vmNode,
          r:        rel({ source: 'azure-resource-graph', via: 'nic', confidence: 90, evidence: 'arm-properties.networkProfile' }),
          toLabels: ['Infra'],
        })],
        [],
      ],
    })
    const result = await callBfs({ query, direction: 'inbound', rootId: 'inf-nic' })
    // VM depends on NIC — writer-emitted direction is VM → NIC.
    expect(result.edges).toEqual([
      expect.objectContaining({ from: 'inf-vm', to: 'inf-nic', via: 'nic' }),
    ])
    expect(result.nodes).toEqual([
      expect.objectContaining({ id: 'inf-vm', label: 'Infra', depth: 1 }),
    ])
  })
})

// ── BFS shape: nodes, edges, depth ───────────────────────────────────────────

describe('bfsWalk — multi-hop walk', () => {
  test('produces depth-tagged nodes and full edge-contract pass-through', async () => {
    const comp   = node('c-1', 'api', 'Component')
    const vm     = node('inf-vm',     'vm-01',     'Infra', { provider: 'azure', resource_type: 'VirtualMachines' })
    const nic    = node('inf-nic',    'vm-01-nic', 'Infra', { provider: 'azure', resource_type: 'NetworkInterfaces' })
    const subnet = node('inf-subnet', 'web-subnet','Infra', { provider: 'azure', resource_type: 'Subnets' })

    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [
        [record({ fromId: 'c-1',     to: vm,     r: rel({ source: 'auto-link',            via: 'component-mapping', confidence: 75, evidence: 'rule-r2' }), toLabels: ['Infra'] })],
        [record({ fromId: 'inf-vm',  to: nic,    r: rel({ source: 'azure-resource-graph', via: 'nic',               confidence: 90, evidence: 'arm-net' }), toLabels: ['Infra'] })],
        [record({ fromId: 'inf-nic', to: subnet, r: rel({ source: 'azure-resource-graph', via: 'subnet',            confidence: 80, evidence: 'arm-sub' }), toLabels: ['Infra'] })],
        [],
      ],
    })
    const result = await callBfs({ query, rootId: 'c-1' })
    expect(result.nodes.map(n => ({ id: n.id, depth: n.depth, label: n.label }))).toEqual([
      { id: 'inf-vm',     depth: 1, label: 'Infra' },
      { id: 'inf-nic',    depth: 2, label: 'Infra' },
      { id: 'inf-subnet', depth: 3, label: 'Infra' },
    ])
    expect(result.edges).toEqual([
      expect.objectContaining({ from: 'c-1',     to: 'inf-vm',     via: 'component-mapping', source: 'auto-link',            confidence: 75 }),
      expect.objectContaining({ from: 'inf-vm',  to: 'inf-nic',    via: 'nic',               source: 'azure-resource-graph', confidence: 90 }),
      expect.objectContaining({ from: 'inf-nic', to: 'inf-subnet', via: 'subnet',            source: 'azure-resource-graph', confidence: 80 }),
    ])
    expect(result.stats.reachedDepth).toBe(3)
    expect(result.truncated).toBe(false)
  })

  test('preserves writer-specific edge extras (protocol/port for OTEL flows)', async () => {
    const comp = node('c-1', 'api', 'Component')
    const remote = node('c-99', 'billing', 'Component')
    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [
        [record({ fromId: 'c-1', to: remote, r: rel({ source: 'otel', via: 'otel-http', confidence: 80, evidence: 'observed', protocol: 'HTTPS', port: 443 }), toLabels: ['Component'] })],
        [],
      ],
    })
    const result = await callBfs({ query, rootId: 'c-1' })
    expect(result.edges[0]).toMatchObject({ protocol: 'HTTPS', port: 443 })
  })
})

// ── Filters & caps ───────────────────────────────────────────────────────────

describe('bfsWalk — filters & caps', () => {
  test('minConfidence is pushed into the per-layer Cypher params', async () => {
    const comp = node('c-1', 'api', 'Component')
    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [[]],
    })
    await callBfs({ query, rootId: 'c-1', minConfidence: 75 })
    const layerCall = query.mock.calls.find(c => c[0].includes('-[r:CONNECTS_TO]->(to)'))
    expect(layerCall[1]).toMatchObject({ minConfidence: 75 })
  })

  test('nodeCap halts BFS mid-layer; truncated=true', async () => {
    const comp = node('c-1', 'api', 'Component')
    const i1 = node('i-1', 'i-1', 'Infra')
    const i2 = node('i-2', 'i-2', 'Infra')
    const i3 = node('i-3', 'i-3', 'Infra')
    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [[
        record({ fromId: 'c-1', to: i1, r: rel({ source: 'x', via: 'component-mapping', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] }),
        record({ fromId: 'c-1', to: i2, r: rel({ source: 'x', via: 'component-mapping', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] }),
        record({ fromId: 'c-1', to: i3, r: rel({ source: 'x', via: 'component-mapping', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] }),
      ]],
    })
    const result = await callBfs({ query, rootId: 'c-1', nodeCap: 2 })
    expect(result.truncated).toBe(true)
    // Seed counts toward visited (depth 0); nodeCap=2 admits one neighbour.
    expect(result.nodes.length).toBe(1)
  })

  test('maxDepth halts the walk; truncated=true when frontier non-empty at boundary', async () => {
    const comp = node('c-1', 'api', 'Component')
    const i1 = node('i-1', 'i-1', 'Infra')
    const i2 = node('i-2', 'i-2', 'Infra')
    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [
        [record({ fromId: 'c-1', to: i1, r: rel({ source: 'x', via: 'a', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] })],
        // BFS would normally fetch i1's outbound here; with maxDepth=1 it stops before doing so.
        [record({ fromId: 'i-1', to: i2, r: rel({ source: 'x', via: 'b', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] })],
      ],
    })
    const result = await callBfs({ query, rootId: 'c-1', maxDepth: 1 })
    expect(result.nodes.map(n => n.id)).toEqual(['i-1'])
    expect(result.truncated).toBe(true)
    expect(result.stats.reachedDepth).toBe(1)
  })
})

// ── Owner Application join-back ──────────────────────────────────────────────

describe('bfsWalk — owner Application join-back', () => {
  test('reached Components get ownerAppId / ownerAppName / ownerAppTier', async () => {
    const comp = node('c-1', 'api', 'Component')
    const remote = node('c-99', 'billing', 'Component')
    const ownerRecords = [record({ id: 'c-99', appId: 'app-bil', appName: 'billing-app', appTier: 1 })]
    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [
        [record({ fromId: 'c-1', to: remote, r: rel({ source: 'otel', via: 'otel-http', confidence: 80, evidence: 'x' }), toLabels: ['Component'] })],
        [],
      ],
      ownerRecords,
    })
    const result = await callBfs({ query, rootId: 'c-1' })
    expect(result.nodes[0]).toMatchObject({
      id: 'c-99', label: 'Component',
      ownerAppId: 'app-bil', ownerAppName: 'billing-app', ownerAppTier: 1,
    })
  })

  test('owner join is skipped entirely when no Component reached at depth>0', async () => {
    const comp = node('c-1', 'api', 'Component')
    const infra = node('inf-1', 'vm-1', 'Infra')
    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [
        [record({ fromId: 'c-1', to: infra, r: rel({ source: 'auto-link', via: 'component-mapping', confidence: 75, evidence: 'x' }), toLabels: ['Infra'] })],
        [],
      ],
    })
    await callBfs({ query, rootId: 'c-1' })
    expect(query.mock.calls.some(c =>
      c[0].includes('MATCH (a:Application)-[:CONTAINS]->(c:Component {id: cid})')
    )).toBe(false)
  })
})

// ── Infra rollup annotation ──────────────────────────────────────────────────

describe('bfsWalk — Infra rollup annotation', () => {
  test('every Infra carries rollupKind+rollupKey; rollups histogram counts buckets', async () => {
    const comp = node('c-1', 'api', 'Component')
    const vm = node('inf-vm', 'vm-1', 'Infra', {
      provider: 'azure',
      cloud_id: '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-1',
    })
    const subnet = node('inf-subnet', 'subnet-1', 'Infra', {
      provider: 'azure',
      cloud_id: '/subscriptions/abc/resourceGroups/rg-network/providers/Microsoft.Network/virtualNetworks/vnet/subnets/subnet-1',
    })
    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [
        [
          record({ fromId: 'c-1',    to: vm,     r: rel({ source: 'auto-link', via: 'component-mapping', confidence: 75, evidence: 'x' }), toLabels: ['Infra'] }),
        ],
        [
          record({ fromId: 'inf-vm', to: subnet, r: rel({ source: 'azure-resource-graph', via: 'subnet', confidence: 80, evidence: 'x' }), toLabels: ['Infra'] }),
        ],
        [],
      ],
    })
    const result = await callBfs({ query, rootId: 'c-1' })
    expect(result.nodes.find(n => n.id === 'inf-vm')).toMatchObject({
      rollupKind: 'azure-resource-group', rollupKey: 'rg-prod',
    })
    expect(result.nodes.find(n => n.id === 'inf-subnet')).toMatchObject({
      rollupKind: 'azure-resource-group', rollupKey: 'rg-network',
    })
    expect(result.rollups).toEqual([
      { kind: 'azure-resource-group', key: 'rg-network', count: 1 },
      { kind: 'azure-resource-group', key: 'rg-prod',    count: 1 },
    ])
  })

  test('Infra with unparseable cloud_id is omitted from histogram (no nulls)', async () => {
    const comp = node('c-1', 'api', 'Component')
    const vm = node('inf-vm', 'vm-1', 'Infra', {
      provider: 'azure',
      cloud_id: '/subscriptions/abc/providers/Microsoft.Subscription/aliases/foo',  // no rg
    })
    const query = makeQueryMock({
      rootRecords: [record({ root: comp, lbls: ['Component'], seeds: [comp] })],
      layerResponses: [
        [record({ fromId: 'c-1', to: vm, r: rel({ source: 'auto-link', via: 'component-mapping', confidence: 75, evidence: 'x' }), toLabels: ['Infra'] })],
        [],
      ],
    })
    const result = await callBfs({ query, rootId: 'c-1' })
    expect(result.nodes[0].rollupKey).toBeUndefined()
    expect(result.rollups).toEqual([])
  })
})

// ── propagateLabels ──────────────────────────────────────────────────────────

describe('bfsWalk — propagateLabels controls frontier propagation', () => {
  test('default exports the Component+Infra set', () => {
    expect(WALK_DEFAULTS.propagateLabels).toEqual(['Component', 'Infra'])
  })

  test('default propagates through Component and Infra, but NOT Application', async () => {
    const compRoot = node('c-1', 'api', 'Component')
    // Imagine the graph emits a (legacy / hypothetical) Component →
    // Application edge. With default propagateLabels, the Application
    // is recorded but the BFS does NOT push it as next frontier — so
    // the second layer query is never issued.
    const oddApp = node('app-x', 'odd-app', 'Application')
    const query = makeQueryMock({
      rootRecords: [record({ root: compRoot, lbls: ['Component'], seeds: [compRoot] })],
      layerResponses: [
        [record({ fromId: 'c-1', to: oddApp, r: rel({ source: 'manual-link', via: 'app-edge', confidence: 100, evidence: 'x' }), toLabels: ['Application'] })],
      ],
    })
    const result = await callBfs({ query, rootId: 'c-1' })
    expect(result.nodes.map(n => n.id)).toEqual(['app-x'])
    // Only one BFS-layer call was needed — the Application node didn't
    // join the next frontier, so the next layer wasn't fetched.
    const bfsCalls = query.mock.calls.filter(c => c[0].includes('-[r:CONNECTS_TO]->(to)'))
    expect(bfsCalls.length).toBe(1)
  })

  test('caller-supplied propagateLabels overrides the default', async () => {
    // Allow Application as a propagatable label.
    const compRoot = node('c-1', 'api', 'Component')
    const oddApp = node('app-x', 'odd-app', 'Application')
    const downstream = node('inf-y', 'thing-y', 'Infra')
    const query = makeQueryMock({
      rootRecords: [record({ root: compRoot, lbls: ['Component'], seeds: [compRoot] })],
      layerResponses: [
        [record({ fromId: 'c-1',    to: oddApp,    r: rel({ source: 'manual-link', via: 'app-edge', confidence: 100, evidence: 'x' }), toLabels: ['Application'] })],
        [record({ fromId: 'app-x',  to: downstream, r: rel({ source: 'manual-link', via: 'next',     confidence: 100, evidence: 'x' }), toLabels: ['Infra'] })],
        [],
      ],
    })
    const result = await callBfs({
      query, rootId: 'c-1',
      propagateLabels: ['Component', 'Infra', 'Application'],
    })
    // With Application now propagatable, the second layer fires and
    // we reach the downstream Infra.
    expect(result.nodes.map(n => n.id).sort()).toEqual(['app-x', 'inf-y'])
  })

  test('empty propagateLabels confines walk to depth 1 (frontier never repopulates)', async () => {
    const compRoot = node('c-1', 'api', 'Component')
    const direct = node('inf-1', 'vm-1', 'Infra')
    const twoHops = node('inf-2', 'nic-1', 'Infra')
    const query = makeQueryMock({
      rootRecords: [record({ root: compRoot, lbls: ['Component'], seeds: [compRoot] })],
      layerResponses: [
        [record({ fromId: 'c-1',    to: direct,   r: rel({ source: 'auto-link', via: 'component-mapping', confidence: 75, evidence: 'x' }), toLabels: ['Infra'] })],
        // Layer 2 mock — but should not be fetched because no label propagates.
        [record({ fromId: 'inf-1',  to: twoHops,  r: rel({ source: 'azure-resource-graph', via: 'nic',     confidence: 90, evidence: 'x' }), toLabels: ['Infra'] })],
      ],
    })
    const result = await callBfs({ query, rootId: 'c-1', propagateLabels: [] })
    expect(result.nodes.map(n => n.id)).toEqual(['inf-1'])
    const bfsCalls = query.mock.calls.filter(c => c[0].includes('-[r:CONNECTS_TO]->(to)'))
    expect(bfsCalls.length).toBe(1)
  })
})
