// Smoke test for the DOT output: when Graphviz is installed locally
// (CI containers, dev machines with `dot` on $PATH), pipe a generated
// digraph through `dot -Tsvg -o /dev/null` and assert exit 0. Catches
// the failure mode where the unit tests pass (the string LOOKS like
// DOT) but Graphviz rejects it — bad quoting, malformed cluster, etc.
//
// Skips cleanly when `dot` is not available, matching the
// testcontainers integration tests in __tests__/integration/. Run via
// the normal `npm test` invocation — no separate target needed.

import { describe, test, expect } from '@jest/globals'
import { execSync, spawnSync } from 'node:child_process'
import { toDot, simplifyWalk } from '../graph-visualize.js'

let DOT_AVAILABLE = false
let DOT_VERSION   = null
try {
  DOT_VERSION = execSync('dot -V 2>&1', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 }).toString().trim()
  DOT_AVAILABLE = /graphviz/i.test(DOT_VERSION)
} catch { /* dot not installed — describe.skip below */ }

const maybeDescribe = DOT_AVAILABLE ? describe : describe.skip
if (!DOT_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn('[graph-visualize.dot-smoke] skipped: Graphviz (`dot`) not on $PATH')
}

function pipeThroughDot(dotSource, args = ['-Tsvg']) {
  const r = spawnSync('dot', args, {
    input:    dotSource,
    encoding: 'utf8',
    timeout:  5000,
  })
  return r
}

// A realistic Azure-shaped walk: per-app subgraphs, per-rollup
// clusters, mixed Component+Infra. Exercises the cluster machinery
// + edge quoting + ARN-shaped ids.
function realisticWalk() {
  return {
    root: { id: 'app-payments', label: 'Application', name: 'payments', tier: 1 },
    seeds: [
      { id: 'c-api',    name: 'api',    type: 'service' },
      { id: 'c-worker', name: 'worker', type: 'service' },
    ],
    nodes: [
      { id: 'inf-vm',     name: 'prod-vm-1',    label: 'Infra', provider: 'azure', depth: 1, rollupKind: 'azure-resource-group', rollupKey: 'rg-prod' },
      { id: 'inf-nic',    name: 'prod-vm-1-nic',label: 'Infra', provider: 'azure', depth: 2, rollupKind: 'azure-resource-group', rollupKey: 'rg-prod' },
      { id: 'inf-subnet', name: 'web-subnet',   label: 'Infra', provider: 'azure', depth: 3, rollupKind: 'azure-resource-group', rollupKey: 'rg-network' },
      { id: 'c-billing',  name: 'billing-svc',  label: 'Component', depth: 1,
        ownerAppId: 'app-billing', ownerAppName: 'Billing', ownerAppTier: 2 },
      // ARN-shaped Infra to verify slash + colon quoting survives Graphviz parse
      { id: 'arn:aws:rds:us-east-1:1234:db:prod-payment-rds', name: 'prod-payment-rds',
        label: 'Infra', provider: 'aws', depth: 1, rollupKind: 'aws-account-region', rollupKey: '1234-us-east-1' },
    ],
    edges: [
      { from: 'c-api',    to: 'inf-vm',     via: 'component-mapping' },
      { from: 'c-worker', to: 'inf-vm',     via: 'component-mapping' },
      { from: 'c-api',    to: 'c-billing',  via: 'otel-http' },
      { from: 'inf-vm',   to: 'inf-nic',    via: 'nic' },
      { from: 'inf-nic',  to: 'inf-subnet', via: 'subnet' },
      { from: 'c-api',    to: 'arn:aws:rds:us-east-1:1234:db:prod-payment-rds', via: 'component-mapping' },
    ],
    rollups: [
      { kind: 'azure-resource-group', key: 'rg-prod',    count: 2 },
      { kind: 'azure-resource-group', key: 'rg-network', count: 1 },
      { kind: 'aws-account-region',   key: '1234-us-east-1', count: 1 },
    ],
    truncated: false,
    stats: { nodesReturned: 5, edgesReturned: 6, reachedDepth: 3, maxDepth: 10, nodeCap: 500 },
  }
}

maybeDescribe('toDot → Graphviz round-trip smoke test', () => {
  test(`Graphviz reports a recognisable version (${DOT_VERSION})`, () => {
    expect(DOT_VERSION).toMatch(/graphviz/i)
  })

  test('outbound dependencies walk renders to SVG without errors', () => {
    const dotSource = toDot(realisticWalk(), { direction: 'outbound' })
    const r = pipeThroughDot(dotSource, ['-Tsvg'])
    if (r.status !== 0) {
      // Surface Graphviz stderr — this is the diagnostic we want.
      throw new Error(`dot failed (status ${r.status}); stderr: ${r.stderr}\n\nDOT source:\n${dotSource}`)
    }
    expect(r.stdout).toMatch(/^<\?xml/)
    expect(r.stdout).toMatch(/<svg/)
  })

  test('inbound impact walk renders to SVG without errors', () => {
    const dotSource = toDot(realisticWalk(), { direction: 'inbound' })
    const r = pipeThroughDot(dotSource, ['-Tsvg'])
    if (r.status !== 0) {
      throw new Error(`dot failed (status ${r.status}); stderr: ${r.stderr}\n\nDOT source:\n${dotSource}`)
    }
    expect(r.stdout).toMatch(/<svg/)
  })

  test('simplified walk (with collapsed cluster placeholders) renders to SVG', () => {
    // Force a collapse by building a high-fan-in walk.
    const seedComp = { id: 'c-root', name: 'root', type: 'service' }
    const k = 30
    const bigWalk = {
      root: { id: 'app-root', label: 'Application', name: 'root-app', tier: 1 },
      seeds: [seedComp],
      nodes: Array.from({ length: k }, (_, i) => ({
        id: `c-bil-${i}`, name: `bil-${i}`, label: 'Component', depth: 1,
        ownerAppId: 'app-billing', ownerAppName: 'billing-app', ownerAppTier: 2,
      })),
      edges: Array.from({ length: k }, (_, i) => ({
        from: 'c-root', to: `c-bil-${i}`, via: 'otel-http',
      })),
      rollups: [],
      truncated: false,
      stats: { nodesReturned: k, edgesReturned: k, reachedDepth: 1, maxDepth: 10, nodeCap: 500 },
    }
    const simplified = simplifyWalk(bigWalk, { collapseAt: 5 })
    const dotSource  = toDot(simplified, { direction: 'outbound' })
    const r = pipeThroughDot(dotSource, ['-Tsvg'])
    if (r.status !== 0) {
      throw new Error(`dot failed (status ${r.status}); stderr: ${r.stderr}\n\nDOT source:\n${dotSource}`)
    }
    expect(r.stdout).toMatch(/<svg/)
  })

  test('rejects non-DOT input (sanity — verifies the harness can detect failures)', () => {
    const r = pipeThroughDot('this is not dot { syntax }')
    expect(r.status).not.toBe(0)
  })

  test('PNG output works too (covers a second backend; bytes-mode read)', () => {
    const dotSource = toDot(realisticWalk(), { direction: 'outbound' })
    // PNG is binary — read stdout as a Buffer so we can check the
    // 8-byte file signature without UTF-8 mangling.
    const r = spawnSync('dot', ['-Tpng'], { input: dotSource, timeout: 5000 })
    if (r.status !== 0) {
      throw new Error(`dot -Tpng failed (status ${r.status}); stderr: ${r.stderr.toString()}`)
    }
    expect(r.stdout.length).toBeGreaterThan(8)
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect([...r.stdout.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  })
})
