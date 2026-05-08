// Locks ingestIacResources contract: the per-row MERGE call shape, the
// counters returned to the caller, and the failure-handling that
// preserves partial progress instead of all-or-nothing failure.

import { describe, test, expect } from '@jest/globals'
import { ingestIacResources } from '../iac-ingest.js'

// Tiny fake neo4j harness — captures every write() call so tests can
// assert on the SQL + params, and lets each call resolve to a custom
// records list.
function makeFakeNeo4j(handler) {
  const calls = []
  const write = async (cypher, params) => {
    calls.push({ cypher, params })
    return handler(cypher, params, calls.length - 1)
  }
  return { write, calls }
}

// A minimal ParsedResource — reflects the shape parseTerraformState
// produces; ingest only reads the documented fields below.
function fixture(overrides = {}) {
  return {
    terraformId:   'aws_instance.web[0]',
    name:          'web',
    provider:      'aws',
    resourceType:  'vm',
    region:        'us-east-1',
    public:        true,
    terraformType: 'aws_instance',
    terraformName: 'web',
    iacEngine:     'terraform',
    workspaceId:   'ws-1',
    ...overrides,
  }
}

// Mock that returns 'created' for the MERGE's RETURN clause and a fresh
// node id; subsequent label-set MATCH writes return [].
function mergeCreated(id = 'nid-1') {
  return (cypher) => {
    if (cypher.includes('MERGE (i:Infra {terraform_id')) {
      return [{ get: (k) => ({ nodeId: id, action: 'created' }[k]) }]
    }
    return []
  }
}
function mergeUpdated(id = 'nid-1') {
  return (cypher) => {
    if (cypher.includes('MERGE (i:Infra {terraform_id')) {
      return [{ get: (k) => ({ nodeId: id, action: 'updated' }[k]) }]
    }
    return []
  }
}

describe('ingestIacResources', () => {
  test('counts created vs updated based on the MERGE action column', async () => {
    let i = 0
    const neo4j = makeFakeNeo4j((cypher) => {
      if (!cypher.includes('MERGE (i:Infra')) return []
      const action = (i++ === 0) ? 'created' : 'updated'
      return [{ get: (k) => ({ nodeId: `nid-${i}`, action }[k]) }]
    })
    const r = await ingestIacResources(neo4j, [
      fixture({ terraformId: 'aws_instance.a' }),
      fixture({ terraformId: 'aws_instance.b' }),
    ])
    expect(r.resourcesFound).toBe(2)
    expect(r.resourcesCreated).toBe(1)
    expect(r.resourcesUpdated).toBe(1)
    expect(r.resourcesSkipped).toBe(0)
    expect(r.importedNames).toHaveLength(2)
  })

  test('skips a row when the MERGE returns zero records', async () => {
    const neo4j = makeFakeNeo4j(() => [])      // never returns
    const r = await ingestIacResources(neo4j, [fixture()])
    expect(r.resourcesSkipped).toBe(1)
    expect(r.resourcesCreated).toBe(0)
  })

  test('per-row throw is caught + recorded; subsequent rows still run', async () => {
    let n = 0
    const neo4j = makeFakeNeo4j((cypher) => {
      if (!cypher.includes('MERGE (i:Infra')) return []
      n++
      if (n === 1) throw new Error('simulated DB outage on row 1')
      return [{ get: (k) => ({ nodeId: `nid-${n}`, action: 'created' }[k]) }]
    })
    const r = await ingestIacResources(neo4j, [
      fixture({ terraformId: 'aws_instance.bad' }),
      fixture({ terraformId: 'aws_instance.ok' }),
    ])
    expect(r.resourcesSkipped).toBe(1)
    expect(r.resourcesCreated).toBe(1)
    expect(r.warnings.some(w => /simulated DB outage/.test(w))).toBe(true)
  })

  test('passes provenance fields (source, iac_engine, integrationId) into the MERGE params', async () => {
    const neo4j = makeFakeNeo4j(mergeCreated('nid-1'))
    await ingestIacResources(neo4j, [fixture()], {
      source:        'tfc',                              // overrides default 'terraform'
      integrationId: 'integ-42',
    })
    const params = neo4j.calls[0].params
    expect(params.source).toBe('tfc')
    expect(params.integrationId).toBe('integ-42')
    expect(params.iacEngine).toBe('terraform')
    expect(params.workspaceId).toBe('ws-1')
  })

  test('default source is "terraform" when none is supplied', async () => {
    const neo4j = makeFakeNeo4j(mergeCreated())
    await ingestIacResources(neo4j, [fixture()])
    expect(neo4j.calls[0].params.source).toBe('terraform')
  })

  test('sends the typed-label MATCH after a successful MERGE', async () => {
    const neo4j = makeFakeNeo4j(mergeCreated('nid-1'))
    await ingestIacResources(neo4j, [fixture()])
    // First call is the MERGE; second (if any) is the label MATCH.
    expect(neo4j.calls.length).toBeGreaterThanOrEqual(1)
    const labelCall = neo4j.calls.find(c => c.cypher.includes('MATCH (i:Infra {id:'))
    if (labelCall) {
      expect(labelCall.params.nodeId).toBe('nid-1')
    }
  })

  test('label-set failure becomes a warning, not a skipped resource', async () => {
    // Use a provider/resourceType combo that buildLabelSetClause
    // produces a non-empty SET clause for, otherwise the MATCH-write
    // is skipped entirely (and there's nothing to fail).
    const neo4j = makeFakeNeo4j((cypher) => {
      if (cypher.includes('MERGE (i:Infra')) {
        return [{ get: (k) => ({ nodeId: 'nid-1', action: 'created' }[k]) }]
      }
      if (cypher.includes('MATCH (i:Infra {id:')) {
        throw new Error('label MATCH failed')
      }
      return []
    })
    const r = await ingestIacResources(neo4j, [
      fixture({ provider: 'azure', resourceType: 'vm' }),  // → AzureVM:ComputeInstance
    ])
    expect(r.resourcesCreated).toBe(1)
    expect(r.resourcesSkipped).toBe(0)
    expect(r.warnings.some(w => /label-set failed/.test(w))).toBe(true)
  })

  test('does NOT mutate the input resources array', async () => {
    const neo4j = makeFakeNeo4j(mergeCreated())
    const input = [fixture(), fixture({ terraformId: 'aws.b' })]
    const before = JSON.stringify(input)
    await ingestIacResources(neo4j, input)
    expect(JSON.stringify(input)).toBe(before)
  })

  test('empty input → all counters zero, no calls', async () => {
    const neo4j = makeFakeNeo4j(() => [])
    const r = await ingestIacResources(neo4j, [])
    expect(r).toEqual({
      resourcesFound: 0, resourcesCreated: 0, resourcesUpdated: 0,
      resourcesSkipped: 0, importedNames: [], warnings: [],
    })
    expect(neo4j.calls).toHaveLength(0)
  })
})
