import { describe, test, expect } from '@jest/globals'
import { toMermaid, toDot, simplifyWalk } from '../graph-visualize.js'

// Unit coverage for the two renderers (Mermaid + DOT). The job is
// "given a bfsWalk-shaped result, produce a string that a renderer
// will accept and that surfaces the structurally important
// information." We don't try to assert byte-for-byte output because
// both formats tolerate cosmetic whitespace shifts; instead we lock
// the contract:
//
//   - Mermaid identifiers are sanitised (no dashes/dots — Mermaid
//     treats those as operators and fails the parse).
//   - Subgraphs are emitted per Application for Components, and per
//     rollup bucket for Infra (when ≥2 share a bucket).
//   - Edges carry their `via` as the label, in the writer-emitted
//     direction.
//   - DOT identifiers are quoted (handles UUIDs, ARNs, ARM ids with
//     slashes).
//   - Both renderers tag root/seed nodes distinctly so the diagram
//     reads as "what the user asked about."

const sampleWalk = () => ({
  root: { id: 'app-payments', label: 'Application', name: 'payments', tier: 1 },
  seeds: [
    { id: 'c-api',    name: 'api',    label: 'Component', type: 'service' },
    { id: 'c-worker', name: 'worker', label: 'Component', type: 'service' },
  ],
  nodes: [
    { id: 'inf-vm',     name: 'vm-1',       label: 'Infra', provider: 'azure', depth: 1,
      rollupKind: 'azure-resource-group', rollupKey: 'rg-prod' },
    { id: 'inf-nic',    name: 'vm-1-nic',   label: 'Infra', provider: 'azure', depth: 2,
      rollupKind: 'azure-resource-group', rollupKey: 'rg-prod' },
    { id: 'inf-subnet', name: 'web-subnet', label: 'Infra', provider: 'azure', depth: 3,
      rollupKind: 'azure-resource-group', rollupKey: 'rg-network' },
    { id: 'c-billing',  name: 'billing',    label: 'Component', depth: 1,
      ownerAppId: 'app-billing', ownerAppName: 'billing-app', ownerAppTier: 2 },
  ],
  edges: [
    { from: 'c-api',    to: 'inf-vm',     via: 'component-mapping', source: 'auto-link',            confidence: 75 },
    { from: 'c-worker', to: 'inf-vm',     via: 'component-mapping', source: 'auto-link',            confidence: 75 },
    { from: 'c-api',    to: 'c-billing',  via: 'otel-http',         source: 'otel',                 confidence: 80, protocol: 'HTTPS', port: 443 },
    { from: 'inf-vm',   to: 'inf-nic',    via: 'nic',               source: 'azure-resource-graph', confidence: 90 },
    { from: 'inf-nic',  to: 'inf-subnet', via: 'subnet',            source: 'azure-resource-graph', confidence: 80 },
  ],
  rollups: [
    { kind: 'azure-resource-group', key: 'rg-prod',    count: 2 },
    { kind: 'azure-resource-group', key: 'rg-network', count: 1 },
  ],
  truncated: false,
  stats: { nodesReturned: 4, edgesReturned: 5, reachedDepth: 3, maxDepth: 10, nodeCap: 500 },
})

// ── Mermaid ──────────────────────────────────────────────────────────────────

describe('toMermaid', () => {
  test('starts with the flowchart header and includes a stats comment', () => {
    const out = toMermaid(sampleWalk(), { direction: 'outbound' })
    expect(out).toMatch(/^%%{init/m)
    expect(out).toMatch(/^flowchart LR$/m)
    expect(out).toMatch(/Dependencies walk from Application "payments"/)
    expect(out).toMatch(/4 nodes, 5 edges, reached depth 3/)
  })

  test('inbound direction is labelled "Impact" in the comment', () => {
    const out = toMermaid(sampleWalk(), { direction: 'inbound' })
    expect(out).toMatch(/Impact walk from Application/)
  })

  test('sanitises node ids so Mermaid does not interpret dashes as operators', () => {
    const out = toMermaid(sampleWalk())
    // Raw `c-api` would break the Mermaid parser; we emit `n_c_api`.
    expect(out).toMatch(/n_c_api/)
    expect(out).not.toMatch(/^\s*c-api\s*\[/m)
  })

  test('Components are grouped into per-Application subgraphs', () => {
    const out = toMermaid(sampleWalk())
    // Seeds belong to the root app (payments)
    expect(out).toMatch(/subgraph n_app__app_payments\["payments tier 1"\]/)
    expect(out).toMatch(/n_c_api\("api \(root\)"\)/)
    expect(out).toMatch(/n_c_worker\("worker \(root\)"\)/)
    // c-billing is owned by billing-app
    expect(out).toMatch(/subgraph n_app__app_billing\["billing-app tier 2"\]/)
    expect(out).toMatch(/n_c_billing\("billing \(d1\)"\)/)
  })

  test('Infra with ≥2 nodes in the same rollup bucket gets a subgraph; singletons stay flat', () => {
    const out = toMermaid(sampleWalk())
    // rg-prod has 2 members → subgraph
    expect(out).toMatch(/subgraph n_rg__azure_resource_group__rg_prod\["rg-prod \(azure-resource-group\)"\]/)
    expect(out).toMatch(/n_inf_vm\[\("vm-1 \(d1\)"\)\]/)
    expect(out).toMatch(/n_inf_nic\[\("vm-1-nic \(d2\)"\)\]/)
    // rg-network has 1 member → flat (no subgraph wrapper)
    expect(out).not.toMatch(/subgraph[^\n]*rg_network/)
    expect(out).toMatch(/n_inf_subnet\[\("web-subnet \(d3\)"\)\]/)
  })

  test('edges are emitted in writer direction with `via` as the label', () => {
    const out = toMermaid(sampleWalk())
    expect(out).toMatch(/n_c_api -->\|component-mapping\| n_inf_vm/)
    expect(out).toMatch(/n_inf_vm -->\|nic\| n_inf_nic/)
    expect(out).toMatch(/n_c_api -->\|otel-http\| n_c_billing/)
  })

  test('root + seeds get classDef rootNode applied for emphasis', () => {
    const out = toMermaid(sampleWalk())
    expect(out).toMatch(/classDef rootNode/)
    // Seed component ids end up in the rootNode class application line
    expect(out).toMatch(/class .*n_c_api.* rootNode/)
    expect(out).toMatch(/class .*n_c_worker.* rootNode/)
  })

  test('Infra cylinder syntax `[("…")]`; Component rounded `("…")`; Application box `["…"]`', () => {
    const out = toMermaid(sampleWalk())
    expect(out).toMatch(/n_inf_vm\[\("vm-1 \(d1\)"\)\]/)         // cylinder
    expect(out).toMatch(/n_c_billing\("billing \(d1\)"\)/)        // rounded box
    expect(out).toMatch(/subgraph n_app__app_payments\["payments tier 1"\]/) // app subgraph header is a box
  })
})

// ── DOT ──────────────────────────────────────────────────────────────────────

describe('toDot', () => {
  test('emits a valid digraph header with rankdir and node defaults', () => {
    const out = toDot(sampleWalk(), { direction: 'outbound' })
    expect(out).toMatch(/^digraph appcloud_outbound \{/)
    expect(out).toMatch(/^\s+rankdir=LR;/m)
    expect(out).toMatch(/\}\s*$/)   // closes
  })

  test('quotes node ids so dashes and slashes survive', () => {
    const out = toDot(sampleWalk())
    expect(out).toMatch(/"c-api" \[label=/)
    expect(out).toMatch(/"inf-vm" \[label=/)
    // ARN-shaped id should survive quoting (synthetic example)
    const arnWalk = {
      ...sampleWalk(),
      seeds: [],
      nodes: [{ id: 'arn:aws:ec2:us-east-1:111:instance/i-1', name: 'i-1', label: 'Infra', depth: 1 }],
      edges: [{ from: 'c-api', to: 'arn:aws:ec2:us-east-1:111:instance/i-1', via: 'component-mapping' }],
    }
    expect(toDot(arnWalk)).toMatch(/"arn:aws:ec2:us-east-1:111:instance\/i-1"/)
  })

  test('Component nodes get a box shape; Infra get cylinder', () => {
    const out = toDot(sampleWalk())
    expect(out).toMatch(/"inf-vm" \[label=[^\]]*shape=cylinder/)
    expect(out).toMatch(/"c-billing" \[label=[^\]]*shape=box/)
  })

  test('Applications emit subgraph cluster_N blocks', () => {
    const out = toDot(sampleWalk())
    expect(out).toMatch(/subgraph cluster_\d+ \{[\s\S]*label="payments \(tier 1\)"/)
    expect(out).toMatch(/subgraph cluster_\d+ \{[\s\S]*label="billing-app \(tier 2\)"/)
  })

  test('Rollup-bucket clusters appear only for multi-member buckets', () => {
    const out = toDot(sampleWalk())
    expect(out).toMatch(/label="rg-prod \(azure-resource-group\)"/)
    expect(out).not.toMatch(/label="rg-network \(azure-resource-group\)"/)
  })

  test('edges use `->` with via label', () => {
    const out = toDot(sampleWalk())
    expect(out).toMatch(/"c-api" -> "inf-vm" \[label="component-mapping"\]/)
    expect(out).toMatch(/"inf-vm" -> "inf-nic" \[label="nic"\]/)
  })

  test('root + seeds get peripheries=2 + ROOT_STROKE colour for emphasis', () => {
    const out = toDot(sampleWalk())
    // peripheries=2 marks the seeds; quoting tolerates the comma list
    expect(out).toMatch(/"c-api" \[label=[^\]]*peripheries=2/)
    expect(out).toMatch(/"c-worker" \[label=[^\]]*peripheries=2/)
    expect(out).toMatch(/"inf-vm" \[label=[^\]]*peripheries=1/)
  })

  test('inbound direction yields appcloud_inbound digraph name + Impact comment', () => {
    const out = toDot(sampleWalk(), { direction: 'inbound' })
    expect(out).toMatch(/^digraph appcloud_inbound \{/)
    expect(out).toMatch(/Impact walk/)
  })
})

// ── simplifyWalk ─────────────────────────────────────────────────────────────

// Builds a walk where one Application (billing-app) has K downstream
// Components reached, and one rollup bucket has M Infra. Used to verify
// collapse thresholds and edge dedup.
function bigFanWalk({ k = 20, m = 8 } = {}) {
  const seedComp = { id: 'c-root', name: 'root', type: 'service' }
  const downstreamComps = Array.from({ length: k }, (_, i) => ({
    id: `c-bil-${i}`, name: `bil-${i}`, label: 'Component', depth: 1,
    ownerAppId: 'app-billing', ownerAppName: 'billing-app', ownerAppTier: 2,
  }))
  const fatRollupInfra = Array.from({ length: m }, (_, i) => ({
    id: `inf-fat-${i}`, name: `fat-${i}`, label: 'Infra', provider: 'azure', depth: 1,
    rollupKind: 'azure-resource-group', rollupKey: 'rg-prod',
  }))
  return {
    root: { id: 'app-root', label: 'Application', name: 'root-app', tier: 1 },
    seeds: [seedComp],
    nodes: [...downstreamComps, ...fatRollupInfra],
    edges: [
      ...downstreamComps.map(c => ({ from: 'c-root', to: c.id, via: 'otel-http' })),
      ...fatRollupInfra.map(i => ({ from: 'c-root', to: i.id, via: 'component-mapping' })),
    ],
    rollups: [{ kind: 'azure-resource-group', key: 'rg-prod', count: m }],
    truncated: false,
    stats: { nodesReturned: k + m, edgesReturned: k + m, reachedDepth: 1, maxDepth: 10, nodeCap: 500 },
  }
}

describe('simplifyWalk', () => {
  test('passes through unchanged when no cluster exceeds collapseAt', () => {
    const walk = bigFanWalk({ k: 3, m: 3 })
    const out = simplifyWalk(walk, { collapseAt: 10 })
    expect(out).toBe(walk)
  })

  test('omitting collapseAt is a no-op', () => {
    const walk = bigFanWalk()
    expect(simplifyWalk(walk)).toBe(walk)
  })

  test('collapses an over-cap Application cluster into a placeholder Component', () => {
    const walk = bigFanWalk({ k: 20, m: 3 })
    const out = simplifyWalk(walk, { collapseAt: 5 })
    // 20 c-bil-* nodes folded into one placeholder; 3 fat infra stay.
    const placeholder = out.nodes.find(n => n._collapsed && n.ownerAppId === 'app-billing')
    expect(placeholder).toMatchObject({
      label:        'Component',
      _memberCount: 20,
      ownerAppId:   'app-billing',
      ownerAppName: 'billing-app',
      ownerAppTier: 2,
    })
    expect(placeholder.name).toMatch(/billing-app \(20 components\)/)
    // Originals are gone.
    expect(out.nodes.filter(n => n.id?.startsWith('c-bil-'))).toEqual([])
    // The 3 below-threshold infra survive un-collapsed.
    expect(out.nodes.filter(n => n.label === 'Infra').length).toBe(3)
  })

  test('collapses an over-cap rollup bucket into a placeholder Infra', () => {
    const walk = bigFanWalk({ k: 3, m: 20 })
    const out = simplifyWalk(walk, { collapseAt: 5 })
    const placeholder = out.nodes.find(n => n._collapsed && n.rollupKey === 'rg-prod')
    expect(placeholder).toMatchObject({
      label:        'Infra',
      _memberCount: 20,
      rollupKind:   'azure-resource-group',
      rollupKey:    'rg-prod',
      provider:     'azure',
    })
    expect(placeholder.name).toMatch(/rg-prod \(20 resources\)/)
    expect(out.nodes.filter(n => n.id?.startsWith('inf-fat-'))).toEqual([])
  })

  test('edges across the collapse boundary dedup to one labelled `via × N`', () => {
    const walk = bigFanWalk({ k: 20, m: 3 })
    const out = simplifyWalk(walk, { collapseAt: 5 })
    // All 20 c-root → c-bil-* otel-http edges should fold into a
    // single edge pointing at the placeholder.
    const placeholderId = out.nodes.find(n => n._collapsed && n.ownerAppId === 'app-billing').id
    const placeholderEdges = out.edges.filter(e => e.to === placeholderId)
    expect(placeholderEdges.length).toBe(1)
    expect(placeholderEdges[0]).toMatchObject({
      from: 'c-root',
      to:   placeholderId,
      via:  'otel-http × 20',
    })
  })

  test('stats are updated (simplified=true, collapseAt echoed, counts refreshed)', () => {
    const walk = bigFanWalk({ k: 20, m: 3 })
    const out = simplifyWalk(walk, { collapseAt: 5 })
    expect(out.stats).toMatchObject({
      simplified:    true,
      collapseAt:    5,
      nodesReturned: out.nodes.length,
      edgesReturned: out.edges.length,
    })
  })

  test('seeds are never collapsed — user always sees what they asked about', () => {
    // Root app has many seeds; collapseAt is very low. Seeds survive.
    const seeds = Array.from({ length: 20 }, (_, i) => ({ id: `c-seed-${i}`, name: `seed-${i}`, type: 'service' }))
    const walk = {
      root: { id: 'app-root', label: 'Application', name: 'root-app', tier: 1 },
      seeds,
      nodes: [],
      edges: [],
      rollups: [],
      truncated: false,
      stats: { nodesReturned: 0, edgesReturned: 0, reachedDepth: 0, maxDepth: 10, nodeCap: 500 },
    }
    const out = simplifyWalk(walk, { collapseAt: 2 })
    // Seeds are still seeds in the walk; nothing collapsed because
    // there were no non-seed Components.
    expect(out.seeds.length).toBe(20)
    expect(out.nodes).toEqual([])
  })

  test('renders cleanly through toMermaid after simplification', () => {
    const walk = bigFanWalk({ k: 30, m: 8 })
    const simplified = simplifyWalk(walk, { collapseAt: 6 })
    const out = toMermaid(simplified, { direction: 'outbound' })
    // Just sanity — header + the placeholder shows up + the dedup label
    expect(out).toMatch(/^flowchart LR$/m)
    expect(out).toMatch(/billing-app \(30 components\)/)
    expect(out).toMatch(/rg-prod \(8 resources\)/)
    expect(out).toMatch(/otel-http × 30/)
    expect(out).toMatch(/component-mapping × 8/)
  })
})
