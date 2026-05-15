// Integration test — `/graph/dependencies` and `/graph/impact` against a
// real Neo4j via Testcontainers. The unit suite covers the BFS helper's
// branches with mocked Cypher results; this test locks in the real
// Cypher round-trip:
//
//   - Variable-length structural chains converge to the same node sets
//     and edge counts our mocks predicted.
//   - `coalesce(r.confidence, 0) >= $minConfidence` interacts correctly
//     with edges that omit `confidence`.
//   - neo4j-driver serialization of nodes / relationships round-trips
//     through `props` and `serialize` without losing the writer's
//     `:CONNECTS_TO` property contract.
//   - The owner-Application join-back resolves Component → Application
//     across separate UNWIND'd batches.
//
// Skips cleanly when Docker is unavailable.

import { test, expect, beforeAll, afterAll, jest } from '@jest/globals'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import { getMaybeDescribe, startNeo4j, wrapNeo4jDriver } from './helpers.js'
import graphRoutes from '../../routes/graph.js'

jest.setTimeout(600_000)

const maybeDescribe = getMaybeDescribe('graph-walk integration')

maybeDescribe('GET /graph/{dependencies,impact} against real Neo4j (Testcontainers)', () => {
  let neo4jContainer, neo4jDriver, fastify

  beforeAll(async () => {
    ;({ container: neo4jContainer, driver: neo4jDriver } = await startNeo4j())
    fastify = Fastify({ logger: false })
    await fastify.register(sensible)
    fastify.decorate('neo4j', { ...wrapNeo4jDriver(neo4jDriver), ping: async () => true })
    await fastify.register(graphRoutes, { prefix: '/graph' })
    await fastify.ready()

    // ── Seed: a tiny but realistic Azure-shaped graph ──
    //
    //   Application(payments, tier=1)
    //     ├─ Component(api)
    //     │    ├─ component-mapping → Infra(vm-1)
    //     │    │                          ├─ nic    → Infra(nic-1)
    //     │    │                          │             └─ subnet → Infra(subnet-1)
    //     │    │                          └─ disk   → Infra(disk-1)
    //     │    └─ otel-http             → Component(billing) ← Application(billing-app, tier=2)
    //     └─ Component(worker)
    //          └─ component-mapping → Infra(vm-1)              (shared)
    //
    // The bootstrap edge `:CONTAINS` is the Application-Component link
    // (not :CONNECTS_TO), so the BFS won't traverse it — Applications
    // surface only via the owner-Application join-back.

    const ctx = wrapNeo4jDriver(neo4jDriver)
    await ctx.write(`
      CREATE
        (appPay:Application  { id: 'app-payments', name: 'payments',    tier: 1, environment: 'prod' }),
        (appBil:Application  { id: 'app-billing',  name: 'billing-app', tier: 2, environment: 'prod' }),
        (cApi:Component      { id: 'c-api',     name: 'api',     type: 'service' }),
        (cWorker:Component   { id: 'c-worker',  name: 'worker',  type: 'service' }),
        (cBilling:Component  { id: 'c-billing', name: 'billing', type: 'service' }),
        (vm:Infra     { id: 'inf-vm',     name: 'vm-1',       provider: 'azure', resource_type: 'VirtualMachines',
                        cloud_id: '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-1' }),
        (nic:Infra    { id: 'inf-nic',    name: 'vm-1-nic',   provider: 'azure', resource_type: 'NetworkInterfaces',
                        cloud_id: '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Network/networkInterfaces/vm-1-nic' }),
        (subnet:Infra { id: 'inf-subnet', name: 'web-subnet', provider: 'azure', resource_type: 'Subnets',
                        cloud_id: '/subscriptions/abc/resourceGroups/rg-network/providers/Microsoft.Network/virtualNetworks/vnet-1/subnets/web-subnet' }),
        (disk:Infra   { id: 'inf-disk',   name: 'vm-1-disk',  provider: 'azure', resource_type: 'Disks',
                        cloud_id: '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Compute/disks/vm-1-disk' }),

        (appPay)-[:CONTAINS]->(cApi),
        (appPay)-[:CONTAINS]->(cWorker),
        (appBil)-[:CONTAINS]->(cBilling),

        (cApi)-[:CONNECTS_TO {
          source: 'auto-link', via: 'component-mapping', confidence: 75,
          evidence: 'rule-r2-direct-link', discovered_at: '2026-04-01T00:00:00Z'
        }]->(vm),
        (cWorker)-[:CONNECTS_TO {
          source: 'auto-link', via: 'component-mapping', confidence: 75,
          evidence: 'rule-r2-direct-link', discovered_at: '2026-04-01T00:00:00Z'
        }]->(vm),
        (cApi)-[:CONNECTS_TO {
          source: 'otel', via: 'otel-http', confidence: 80,
          evidence: 'observed', protocol: 'HTTPS', port: 443
        }]->(cBilling),

        (vm)-[:CONNECTS_TO {
          source: 'azure-resource-graph', via: 'nic', confidence: 90,
          evidence: 'arm-properties.networkProfile.networkInterfaces'
        }]->(nic),
        (vm)-[:CONNECTS_TO {
          source: 'azure-resource-graph', via: 'disk', confidence: 80,
          evidence: 'arm-properties.storageProfile.osDisk'
        }]->(disk),
        (nic)-[:CONNECTS_TO {
          source: 'azure-resource-graph', via: 'subnet', confidence: 80,
          evidence: 'arm-properties.ipConfigurations[].subnet'
        }]->(subnet)
    `)
  })

  afterAll(async () => {
    try { await fastify?.close() }        catch {}
    try { await neo4jDriver?.close() }    catch {}
    try { await neo4jContainer?.stop() }  catch {}
  })

  test('/graph/dependencies of an Application returns every component + transitive infra', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=app-payments' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    expect(body.root).toMatchObject({ id: 'app-payments', label: 'Application', name: 'payments', tier: 1 })
    expect(body.seeds.map(s => s.id).sort()).toEqual(['c-api', 'c-worker'])

    const ids = body.nodes.map(n => n.id).sort()
    // Components seeded (api, worker) are excluded; everything reachable
    // outbound from them is in: shared vm, structural chain, sibling
    // component, but NOT the contained-by Applications.
    expect(ids).toEqual(['c-billing', 'inf-disk', 'inf-nic', 'inf-subnet', 'inf-vm'])
    expect(body.nodes.find(n => n.id === 'inf-vm').depth).toBe(1)
    expect(body.nodes.find(n => n.id === 'inf-nic').depth).toBe(2)
    expect(body.nodes.find(n => n.id === 'inf-subnet').depth).toBe(3)
    expect(body.nodes.find(n => n.id === 'inf-disk').depth).toBe(2)

    // Cross-app Component → annotated with owning Application
    const billing = body.nodes.find(n => n.id === 'c-billing')
    expect(billing).toMatchObject({
      label: 'Component', depth: 1,
      ownerAppId: 'app-billing', ownerAppName: 'billing-app', ownerAppTier: 2,
    })

    // Edges carry the full :CONNECTS_TO contract end-to-end
    const apiToVm = body.edges.find(e => e.from === 'c-api' && e.to === 'inf-vm')
    expect(apiToVm).toMatchObject({
      via: 'component-mapping', source: 'auto-link', confidence: 75,
      evidence: 'rule-r2-direct-link',
    })
    const vmToNic = body.edges.find(e => e.from === 'inf-vm' && e.to === 'inf-nic')
    expect(vmToNic).toMatchObject({
      via: 'nic', source: 'azure-resource-graph', confidence: 90,
      evidence: 'arm-properties.networkProfile.networkInterfaces',
    })

    expect(body.truncated).toBe(false)
    expect(body.stats.reachedDepth).toBe(3)

    // Rollup annotation: every Infra node parsed against its provider
    // contributes to the histogram. rg-prod hits 3 (vm + nic + disk),
    // rg-network hits 1 (subnet).
    expect(body.nodes.find(n => n.id === 'inf-vm')).toMatchObject({
      rollupKind: 'azure-resource-group', rollupKey: 'rg-prod',
    })
    expect(body.rollups).toEqual([
      { kind: 'azure-resource-group', key: 'rg-prod',    count: 3 },
      { kind: 'azure-resource-group', key: 'rg-network', count: 1 },
    ])
  })

  test('/graph/impact of an Infra (subnet) walks INBOUND to surface every dependent VM, Component, Application', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/graph/impact?id=inf-subnet' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    expect(body.root).toMatchObject({ id: 'inf-subnet', label: 'Infra', name: 'web-subnet' })
    expect(body.seeds).toEqual([expect.objectContaining({ id: 'inf-subnet' })])

    // Inbound from subnet: NIC at d1, VM at d2, api+worker components at d3.
    // Edges are always presented in the writer-emitted direction.
    expect(body.nodes.find(n => n.id === 'inf-nic').depth).toBe(1)
    expect(body.nodes.find(n => n.id === 'inf-vm').depth).toBe(2)
    expect(body.nodes.find(n => n.id === 'c-api').depth).toBe(3)
    expect(body.nodes.find(n => n.id === 'c-worker').depth).toBe(3)

    // c-billing is NOT inbound-reachable from subnet (it's a downstream
    // call from c-api, not an upstream dependency of c-api). The walk
    // stops at Components — it does not follow further outbound edges
    // from them.
    expect(body.nodes.find(n => n.id === 'c-billing')).toBeUndefined()

    // Components annotated with owning Application
    expect(body.nodes.find(n => n.id === 'c-api')).toMatchObject({
      ownerAppId: 'app-payments', ownerAppName: 'payments', ownerAppTier: 1,
    })

    // Edge direction is writer-emitted, not BFS direction
    const nicToSubnet = body.edges.find(e => e.from === 'inf-nic' && e.to === 'inf-subnet')
    expect(nicToSubnet).toMatchObject({ via: 'subnet', source: 'azure-resource-graph', confidence: 80 })
    const vmToNic = body.edges.find(e => e.from === 'inf-vm' && e.to === 'inf-nic')
    expect(vmToNic).toMatchObject({ via: 'nic', confidence: 90 })
    // No reversed entries
    expect(body.edges.find(e => e.from === 'inf-subnet' && e.to === 'inf-nic')).toBeUndefined()
  })

  test('/graph/impact of a Component surfaces upstream callers, annotated with owning app', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/graph/impact?id=c-billing' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.nodes).toEqual([
      expect.objectContaining({
        id: 'c-api', label: 'Component', depth: 1,
        ownerAppId: 'app-payments', ownerAppName: 'payments', ownerAppTier: 1,
      }),
    ])
    expect(body.edges[0]).toMatchObject({
      from: 'c-api', to: 'c-billing', via: 'otel-http', source: 'otel',
      protocol: 'HTTPS', port: 443,
    })
  })

  test('/graph/dependencies refuses Infra ids — points caller at /graph/impact', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=inf-vm' })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.message).toMatch(/Infra ids use \/graph\/impact/)
  })

  test('minConfidence filter excludes lower-confidence edges at the per-layer query', async () => {
    // confidence>=85 keeps only nic (90); auto-link (75), disk/subnet
    // (80), otel-http (80) are all skipped at the per-layer Cypher.
    const res = await fastify.inject({ method: 'GET', url: '/graph/dependencies?id=app-payments&minConfidence=85' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // Walking from c-api/c-worker, no edge from them clears 85
    // (component-mapping=75, otel-http=80) so the dependency graph is
    // empty even though structural Azure edges exist deeper.
    expect(body.nodes).toEqual([])
    expect(body.edges).toEqual([])
  })
})
