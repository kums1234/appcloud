import { describe, test, expect, jest } from '@jest/globals'
import { supplementAzureDiscovery, __test__ } from '../discovery.azure.supplement.js'

const { rgFromId, normId, writeObservedEdge, viaConfidence } = __test__

// ─── helpers ──────────────────────────────────────────────────────────────────

describe('rgFromId', () => {
  test('extracts resourceGroup segment from ARM ids', () => {
    expect(rgFromId('/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm1'))
      .toBe('rg-prod')
    expect(rgFromId('/subscriptions/abc/resourceGroups/RG-PROD/providers/…'))
      .toBe('rg-prod') // case-normalised
    expect(rgFromId('')).toBe('')
    expect(rgFromId('/no-rg/here')).toBe('')
  })
})

describe('normId', () => {
  test('lowercases and strips trailing slash', () => {
    expect(normId('/Subscriptions/ABC/')).toBe('/subscriptions/abc')
    expect(normId('ALREADY-LOWER')).toBe('already-lower')
    expect(normId('')).toBe('')
  })
})

describe('viaConfidence', () => {
  test('locks supplement layer scores', () => {
    expect(viaConfidence('contains')).toBe(70)     // Network Watcher Contains
    expect(viaConfidence('associated')).toBe(60)   // Network Watcher Associated
    expect(viaConfidence('observed-tcp')).toBe(75) // VM Insights flows
    expect(viaConfidence('unknown')).toBe(60)      // default
  })
})

// ─── writeObservedEdge (single :CONNECTS_TO write per logical edge) ─────────

describe('writeObservedEdge', () => {
  test('writes a single :CONNECTS_TO edge carrying extraProps (e.g. connection_count)', async () => {
    const write = jest.fn(async () => [])
    const n = await writeObservedEdge(write, {
      from: 'vm-a', to: 'vm-b', via: 'observed-tcp', source: 'azure-vm-insights',
      extraProps: {
        connection_count: 42,
        ports:   JSON.stringify([443, 8443]),
        process: 'curl',
        evidence: 'VMInsights: 42 outbound conn(s)',
      },
    })
    expect(n).toBe(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toContain(':CONNECTS_TO')
    expect(write.mock.calls[0][0]).not.toContain(':CONNECTED_TO')
    expect(write.mock.calls[0][1]).toMatchObject({
      from: 'vm-a', to: 'vm-b', via: 'observed-tcp', source: 'azure-vm-insights',
      confidence: 75, connection_count: 42, process: 'curl',
    })
  })

  test('skips self-loops', async () => {
    const write = jest.fn()
    expect(await writeObservedEdge(write, { from: 'a', to: 'a', via: 'observed-tcp', source: 's' })).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })
})

// ─── supplementAzureDiscovery ────────────────────────────────────────────────

describe('supplementAzureDiscovery', () => {
  test('no-ops when no layers and autoLink=false', async () => {
    const write = jest.fn()
    const query = jest.fn()
    const log   = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
    const result = await supplementAzureDiscovery({
      cred: {}, subId: 'sub-1', write, query, log,
      layers: [], autoLink: false,
    })
    expect(result.totalRelationships).toBe(0)
    expect(result.totalLinked).toBe(0)
    expect(write).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  test('silently skips the legacy "resource-graph" layer with a warning', async () => {
    const write = jest.fn()
    const query = jest.fn()
    const warn  = jest.fn()
    const log   = { info: jest.fn(), warn, debug: jest.fn() }
    await supplementAzureDiscovery({
      cred: {}, subId: 'sub-1', write, query, log,
      layers: ['resource-graph'], autoLink: false,
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resource-graph'))
    expect(write).not.toHaveBeenCalled()
  })
})

// ─── autoLink — single :CONNECTS_TO[via='component-mapping'] write ──────────

describe('autoLinkFromStructure', () => {
  // Build a mock `query` that returns canned data based on the Cypher text it
  // receives. Mirrors the three queries autoLink issues in sequence:
  //   1. unmapped nodes
  //   2. RG-mapped reference index
  //   3. per-node direct structural connections (via :CONNECTS_TO)
  // and optionally the 2-hop fallback if no candidate ≥ minScore.
  function makeNeo4jRow(obj) {
    return { get: (k) => obj[k] }
  }

  function makeQueryMock({ unmapped, rgMapped, direct, twoHop = [] }) {
    return jest.fn(async (cypher) => {
      if (cypher.includes("NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)") &&
          cypher.includes('RETURN i.id AS infraId')) {
        return unmapped.map(makeNeo4jRow)
      }
      if (cypher.includes("MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i:Infra)") &&
          cypher.includes('RETURN i.cloud_id AS cid')) {
        return rgMapped.map(makeNeo4jRow)
      }
      if (cypher.includes('[r:CONNECTS_TO]-(mapped:Infra)') && !cypher.includes('*1..2')) {
        return direct.map(makeNeo4jRow)
      }
      if (cypher.includes('CONNECTS_TO*1..2')) {
        return twoHop.map(makeNeo4jRow)
      }
      return []
    })
  }

  test('writes a single :CONNECTS_TO[source=auto-link] edge above threshold', async () => {
    const write = jest.fn(async () => [])
    const log   = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
    const query = makeQueryMock({
      unmapped: [{
        infraId: 'nic-1',
        name:    'nic-prod-1',
        cloudId: '/subscriptions/a/resourceGroups/rg-prod/providers/Microsoft.Network/networkInterfaces/nic-1',
        rtype:   'network_interface',
        raw:     '{}',
        tags:    '{}',
      }],
      rgMapped: [
        {
          cid:      '/subscriptions/a/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-1',
          compId:   'comp-alpha',
          compName: 'alpha',
          rtype:    'vm',
        },
        {
          cid:      '/subscriptions/a/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-2',
          compId:   'comp-alpha',
          compName: 'alpha',
          rtype:    'vm',
        },
      ],
      direct: [
        { compId: 'comp-alpha', compName: 'alpha', via: 'nic' }, // score 90
      ],
    })

    await supplementAzureDiscovery({
      cred: {}, subId: 'sub', write, query, log,
      layers: [], autoLink: true, minScore: 60,
    })

    // Single :CONNECTS_TO write for the mapping; no :DEPLOYED_ON dual-write.
    const linkWrites = write.mock.calls.filter(([c]) => /MERGE \(c\)-\[rel:/.test(c))
    expect(linkWrites).toHaveLength(1)
    expect(linkWrites[0][0]).toMatch(/:CONNECTS_TO \{via: 'component-mapping'\}/)
    expect(linkWrites[0][0]).not.toMatch(/:DEPLOYED_ON/)
    expect(linkWrites[0][0]).toContain("rel.source          = 'auto-link'")
    expect(linkWrites[0][1]).toMatchObject({
      compId: 'comp-alpha', infraId: 'nic-1', score: 90, rule: expect.any(String),
      providerSource: 'azure-enrichment',
    })
  })

  test('surfaces a suggestion (no writes) when best score < minScore but ≥ 30', async () => {
    const write = jest.fn(async () => [])
    const log   = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
    const query = makeQueryMock({
      unmapped: [{
        infraId: 'stray-1', name: 'stray', cloudId: '/subscriptions/a/resourceGroups/rg-x/providers/Microsoft.Foo/things/stray-1',
        rtype: 'thing', raw: '{}', tags: '{}',
      }],
      rgMapped: [],  // no RG-co-location candidates
      direct:   [{ compId: 'comp-beta', compName: 'beta', via: 'nsg' }], // score 55 (< 60)
    })
    const result = await supplementAzureDiscovery({
      cred: {}, subId: 'sub', write, query, log,
      layers: [], autoLink: true, minScore: 60,
    })
    // No edge writes when below threshold
    expect(write.mock.calls.filter(([c]) => /MERGE \(c\)-\[rel:/.test(c))).toHaveLength(0)
    expect(result.autoLink.suggestions).toHaveLength(1)
    expect(result.autoLink.suggestions[0]).toMatchObject({
      infraId: 'stray-1',
      compId:  'comp-beta',
      score:   55,
    })
  })
})
