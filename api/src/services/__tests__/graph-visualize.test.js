import { describe, test, expect } from '@jest/globals'
import { toMermaid, toDot } from '../graph-visualize.js'

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
