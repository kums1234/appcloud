import { describe, test, expect, jest } from '@jest/globals'
import { __test__, supplementGCPDiscovery } from '../discovery.gcp.supplement.js'

const { projectFromCloudId, saKey, writeIamEdge, discoverFromIamPolicy, autoLinkFromStructure } = __test__

// Mock @google-cloud/asset before any test that loads it. Each test sets
// __nextAssets to control what listAssetsAsync iterates over.
const __nextAssets = { value: [], throw: null }
jest.unstable_mockModule('@google-cloud/asset', () => ({
  AssetServiceClient: class {
    constructor(opts) { this.opts = opts }
    async *listAssetsAsync() {
      if (__nextAssets.throw) throw __nextAssets.throw
      for (const a of __nextAssets.value) yield a
    }
  },
}))

// ─── projectFromCloudId ──────────────────────────────────────────────────────

describe('projectFromCloudId', () => {
  test('extracts project from a Compute self-link', () => {
    expect(projectFromCloudId('https://www.googleapis.com/compute/v1/projects/my-proj/zones/us-central1-a/instances/vm1'))
      .toBe('my-proj')
  })
  test('extracts project from a CAI //service.googleapis.com/... name', () => {
    expect(projectFromCloudId('//run.googleapis.com/projects/My-Proj/locations/us-central1/services/svc1'))
      .toBe('my-proj')
  })
  test('returns empty string for non-project cloud_ids', () => {
    expect(projectFromCloudId('//iam.googleapis.com/organizations/123/roles/foo')).toBe('')
    expect(projectFromCloudId('')).toBe('')
  })
})

// ─── autoLinkFromStructure — single-write contract ──────────────────────────
//
// Verifies the supplement writes exactly one
// :CONNECTS_TO {via:'component-mapping'} edge with source='auto-link' when
// a candidate clears minScore.

function recordingNeo4j(unmappedRows = [], projMappedRows = [], directRows = []) {
  const writes = []
  const queries = []
  let directRowsConsumed = false

  const query = jest.fn(async (cypher) => {
    queries.push(cypher)
    // Unmapped-Infra sweep
    if (cypher.includes("NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)") &&
        cypher.includes('RETURN i.id AS infraId')) {
      return unmappedRows
    }
    // Co-location-bucket index
    if (cypher.includes("MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i:Infra)") &&
        cypher.includes('RETURN i.cloud_id AS cid')) {
      return projMappedRows
    }
    // Rule 2 — direct structural 1-hop on :CONNECTS_TO (excluding component-mapping)
    if (cypher.includes('[r:CONNECTS_TO]-(mapped:Infra)') && !cypher.includes('*1..2')) {
      if (!directRowsConsumed) { directRowsConsumed = true; return directRows }
      return []
    }
    return []
  })

  const write = jest.fn(async (cypher, params) => {
    writes.push({ cypher, params })
  })

  return { query, write, writes, queries }
}

function row(map) {
  return { get: (k) => map[k] }
}

describe('autoLinkFromStructure', () => {
  test('writes a single :CONNECTS_TO[via=component-mapping] when project-co-location is unanimous', async () => {
    const unmapped = [
      row({
        infraId: 'inf-vm-new',
        name:    'new-vm',
        cloudId: 'https://www.googleapis.com/compute/v1/projects/proj-a/zones/us-central1-a/instances/new-vm',
        rtype:   'compute_instance',
        raw:     '{}',
        tags:    '{}',
      }),
    ]
    const projMapped = [
      row({ cid: 'https://www.googleapis.com/compute/v1/projects/proj-a/zones/us-central1-a/instances/api-1', compId: 'comp-api',  compName: 'api-svc', rtype: 'compute_instance' }),
      row({ cid: 'https://www.googleapis.com/sql/v1beta4/projects/proj-a/instances/db1',                       compId: 'comp-api',  compName: 'api-svc', rtype: 'cloud_sql' }),
    ]
    const { query, write, writes } = recordingNeo4j(unmapped, projMapped, [])
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await autoLinkFromStructure({ write, query, log, minScore: 60 })

    expect(stats.linked).toBe(1)
    expect(stats.errors).toEqual([])

    // Single :CONNECTS_TO write — no more :DEPLOYED_ON dual-write
    const linkWrites = writes.filter(w => w.cypher.includes('MERGE (c)-[rel:'))
    expect(linkWrites).toHaveLength(1)
    expect(linkWrites[0].cypher).toMatch(/:CONNECTS_TO \{via: 'component-mapping'\}/)
    expect(linkWrites[0].cypher).not.toMatch(/:DEPLOYED_ON/)

    expect(linkWrites[0].params.compId).toBe('comp-api')
    expect(linkWrites[0].params.infraId).toBe('inf-vm-new')
    expect(linkWrites[0].params.evidence).toMatch(/auto-link/)

    // Score reflects project-unanimous rule
    expect(linkWrites[0].params.score).toBe(85)
    expect(linkWrites[0].params.rule).toBe('project-unanimous')
    expect(linkWrites[0].params.providerSource).toBe('gcp-enrichment')
  })

  test('uses direct-link rule (1-hop CONNECTS_TO) when project co-location is mixed', async () => {
    const unmapped = [
      row({
        infraId: 'inf-mixed',
        name:    'mixed-vm',
        cloudId: 'https://www.googleapis.com/compute/v1/projects/proj-mixed/zones/us-central1-a/instances/mixed-vm',
        rtype:   'compute_instance',
        raw:     '{}',
        tags:    '{}',
      }),
    ]
    // Mixed: 3 components in the same project, 1 each. Each ratio is 1/3,
    // below the 0.5 majority threshold — Rule 1 produces no candidate, so
    // Rule 2's direct-subnet candidate (score 65) wins on its own.
    const projMapped = [
      row({ cid: 'https://www.googleapis.com/compute/v1/projects/proj-mixed/zones/us-central1-a/instances/a', compId: 'comp-a', compName: 'A', rtype: 'compute_instance' }),
      row({ cid: 'https://www.googleapis.com/compute/v1/projects/proj-mixed/zones/us-central1-a/instances/b', compId: 'comp-b', compName: 'B', rtype: 'compute_instance' }),
      row({ cid: 'https://www.googleapis.com/compute/v1/projects/proj-mixed/zones/us-central1-a/instances/c', compId: 'comp-c', compName: 'C', rtype: 'compute_instance' }),
    ]
    const directConns = [row({ compId: 'comp-a', compName: 'A', via: 'subnet' })] // score 65
    const { query, write, writes } = recordingNeo4j(unmapped, projMapped, directConns)
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await autoLinkFromStructure({ write, query, log, minScore: 60 })

    expect(stats.linked).toBe(1)
    const linkWrites = writes.filter(w => w.cypher.includes('MERGE (c)-[rel:'))
    expect(linkWrites).toHaveLength(1)
    expect(linkWrites[0].params.score).toBe(65)
    expect(linkWrites[0].params.rule).toBe('direct-subnet')
  })

  test('puts low-score candidates in suggestions, not auto-link', async () => {
    const unmapped = [
      row({
        infraId: 'inf-low',
        name:    'lowscore-vm',
        cloudId: 'https://www.googleapis.com/compute/v1/projects/proj-low/zones/us-central1-a/instances/lowscore',
        rtype:   'compute_instance',
        raw:     '{}',
        tags:    '{}',
      }),
    ]
    // No project co-location, no direct connections — falls through to 2-hop
    // which scores 40+1*6=46 with 1 path.
    const { query, write, writes } = recordingNeo4j(unmapped, [], [])
    query.mockImplementationOnce(async () => unmapped) // unmapped query
                  .mockImplementationOnce(async () => []) // projMapped query
                  .mockImplementationOnce(async () => []) // direct (Rule 2)
                  .mockImplementationOnce(async () => [row({ compId: 'comp-low', compName: 'L', paths: 1 })]) // 2-hop (Rule 3)
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await autoLinkFromStructure({ write, query, log, minScore: 60 })

    expect(stats.linked).toBe(0)
    expect(stats.suggestions).toHaveLength(1)
    expect(stats.suggestions[0].score).toBe(46)
    expect(stats.suggestions[0].rule).toBe('2-hop-neighbourhood')
    // No DEPLOYED_ON / CONNECTS_TO writes — only stat reads
    expect(writes.filter(w => w.cypher.includes('MERGE (c)-[rel:'))).toHaveLength(0)
  })
})

// ─── writeIamEdge — single :CONNECTS_TO with role on MERGE key ──────────────

describe('writeIamEdge', () => {
  test('writes a single :CONNECTS_TO edge with role + via on the MERGE key', async () => {
    const calls = []
    const write = jest.fn(async (cypher, params) => { calls.push({ cypher, params }) })
    const n = await writeIamEdge(write, {
      from: 'sa-1', to: 'bucket-1', role: 'roles/storage.admin',
      source: 'gcp-iam-policy', evidence: 'IAM: roles/storage.admin on storage.googleapis.com/Bucket',
    })
    expect(n).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].cypher).toMatch(/:CONNECTS_TO \{via: \$via, role: \$role\}/)
    expect(calls[0].cypher).not.toMatch(/:CONNECTED_TO/)
    expect(calls[0].params.via).toBe('iam-binding')
    expect(calls[0].params.role).toBe('roles/storage.admin')
    expect(calls[0].params.source).toBe('gcp-iam-policy')
  })

  test('different roles on the same SA→resource produce separate edges (MERGE keyed on via+role)', async () => {
    const write = jest.fn()
    await writeIamEdge(write, { from: 'sa', to: 'b', role: 'roles/storage.admin',  source: 'gcp-iam-policy' })
    await writeIamEdge(write, { from: 'sa', to: 'b', role: 'roles/storage.viewer', source: 'gcp-iam-policy' })
    // 2 logical edges × 1 cypher write each = 2 cypher writes; the role on
    // the MERGE key ensures they don't collapse onto one edge.
    expect(write).toHaveBeenCalledTimes(2)
  })
})

// ─── discoverFromIamPolicy — IAM-bindings → graph ────────────────────────────

function makeQuery(infraRows) {
  return jest.fn(async (cypher) => {
    if (cypher.includes("i.provider = 'gcp' AND i.cloud_id IS NOT NULL") &&
        cypher.includes('i.cai_name AS cai')) {
      return infraRows
    }
    return []
  })
}

describe('discoverFromIamPolicy', () => {
  test('serviceAccount binding produces SA → resource edge resolved via cai_name and SA self-link', async () => {
    __nextAssets.value = [
      {
        name:      '//storage.googleapis.com/projects/_/buckets/my-bucket',
        assetType: 'storage.googleapis.com/Bucket',
        iamPolicy: { bindings: [{
          role: 'roles/storage.admin',
          members: ['serviceAccount:runner@my-proj.iam.gserviceaccount.com'],
        }] },
      },
    ]
    __nextAssets.throw = null

    const infraRows = [
      // gcp_service_account: cloud_id matches saKey('my-proj', email)
      { get: (k) => ({
          cid:   'https://iam.googleapis.com/projects/my-proj/serviceaccounts/runner@my-proj.iam.gserviceaccount.com',
          nid:   'sa-nid',
          cai:   '//iam.googleapis.com/projects/my-proj/serviceAccounts/runner@my-proj.iam.gserviceaccount.com',
          rtype: 'gcp_service_account',
        })[k] },
      // GCS bucket: cai_name matches the policy target
      { get: (k) => ({
          cid:   'https://www.googleapis.com/storage/v1/b/my-bucket',
          nid:   'bucket-nid',
          cai:   '//storage.googleapis.com/projects/_/buckets/my-bucket',
          rtype: 'gcs_bucket',
        })[k] },
    ]

    const writes = []
    const write = jest.fn(async (cypher, params) => { writes.push({ cypher, params }) })
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await discoverFromIamPolicy({ credentials: null, projectId: 'my-proj', write, query: makeQuery(infraRows), log })

    expect(stats.errors).toEqual([])
    expect(stats.policies).toBe(1)
    expect(stats.bindings).toBe(1)
    expect(stats.edges).toBe(1)
    expect(stats.publicResources).toBe(0)

    const edgeWrites = writes.filter(w => w.cypher.includes(':CONNECTS_TO'))
    expect(edgeWrites).toHaveLength(1)
    expect(edgeWrites[0].params.from).toBe('sa-nid')
    expect(edgeWrites[0].params.to).toBe('bucket-nid')
    expect(edgeWrites[0].params.via).toBe('iam-binding')
    expect(edgeWrites[0].params.role).toBe('roles/storage.admin')
    expect(edgeWrites[0].params.source).toBe('gcp-iam-policy')
  })

  test('allUsers binding flips public=true on the resource (Point 3 of slice 2 follow-ups)', async () => {
    __nextAssets.value = [
      {
        name:      '//storage.googleapis.com/projects/_/buckets/public-bucket',
        assetType: 'storage.googleapis.com/Bucket',
        iamPolicy: { bindings: [{ role: 'roles/storage.objectViewer', members: ['allUsers'] }] },
      },
    ]
    __nextAssets.throw = null

    const infraRows = [
      { get: (k) => ({
          cid:   'https://www.googleapis.com/storage/v1/b/public-bucket',
          nid:   'pub-bucket-nid',
          cai:   '//storage.googleapis.com/projects/_/buckets/public-bucket',
          rtype: 'gcs_bucket',
        })[k] },
    ]

    const writes = []
    const write = jest.fn(async (cypher, params) => { writes.push({ cypher, params }) })
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await discoverFromIamPolicy({ credentials: null, projectId: 'my-proj', write, query: makeQuery(infraRows), log })

    expect(stats.publicResources).toBe(1)
    expect(stats.edges).toBe(0) // allUsers is not a serviceAccount, no edge
    const flipWrite = writes.find(w => w.cypher.includes('SET i.public = true'))
    expect(flipWrite).toBeDefined()
    expect(flipWrite.params.nid).toBe('pub-bucket-nid')
    expect(flipWrite.params.role).toBe('roles/storage.objectViewer')
  })

  test('allAuthenticatedUsers also flips public=true', async () => {
    __nextAssets.value = [
      {
        name:      '//storage.googleapis.com/projects/_/buckets/auth-bucket',
        assetType: 'storage.googleapis.com/Bucket',
        iamPolicy: { bindings: [{ role: 'roles/storage.objectViewer', members: ['allAuthenticatedUsers'] }] },
      },
    ]
    __nextAssets.throw = null

    const infraRows = [
      { get: (k) => ({
          cid:   'https://www.googleapis.com/storage/v1/b/auth-bucket',
          nid:   'auth-nid',
          cai:   '//storage.googleapis.com/projects/_/buckets/auth-bucket',
          rtype: 'gcs_bucket',
        })[k] },
    ]
    const writes = []
    const write = jest.fn(async (cypher, params) => { writes.push({ cypher, params }) })
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await discoverFromIamPolicy({ credentials: null, projectId: 'p', write, query: makeQuery(infraRows), log })
    expect(stats.publicResources).toBe(1)
    expect(writes.some(w => w.cypher.includes('SET i.public = true'))).toBe(true)
  })

  test('only flips public once per resource even when multiple public bindings exist', async () => {
    __nextAssets.value = [
      {
        name:      '//storage.googleapis.com/projects/_/buckets/wide',
        assetType: 'storage.googleapis.com/Bucket',
        iamPolicy: { bindings: [
          { role: 'roles/storage.objectViewer', members: ['allUsers'] },
          { role: 'roles/storage.legacyObjectReader', members: ['allAuthenticatedUsers'] },
        ] },
      },
    ]
    __nextAssets.throw = null
    const infraRows = [
      { get: (k) => ({
          cid:   'https://www.googleapis.com/storage/v1/b/wide',
          nid:   'wide-nid',
          cai:   '//storage.googleapis.com/projects/_/buckets/wide',
          rtype: 'gcs_bucket',
        })[k] },
    ]
    const writes = []
    const write = jest.fn(async (cypher, params) => { writes.push({ cypher, params }) })
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await discoverFromIamPolicy({ credentials: null, projectId: 'p', write, query: makeQuery(infraRows), log })
    expect(stats.publicResources).toBe(1)
    expect(writes.filter(w => w.cypher.includes('SET i.public = true'))).toHaveLength(1)
  })

  test('user/group/domain principals are skipped (counted but no edges yet)', async () => {
    __nextAssets.value = [
      {
        name:      '//compute.googleapis.com/projects/p/zones/us-central1-a/instances/vm1',
        assetType: 'compute.googleapis.com/Instance',
        iamPolicy: { bindings: [{
          role: 'roles/compute.viewer',
          members: ['user:alice@example.com', 'group:eng@example.com', 'domain:example.com'],
        }] },
      },
    ]
    __nextAssets.throw = null
    const infraRows = [
      { get: (k) => ({
          cid:   'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/vm1',
          nid:   'vm-nid',
          cai:   '//compute.googleapis.com/projects/p/zones/us-central1-a/instances/vm1',
          rtype: 'compute_instance',
        })[k] },
    ]
    const writes = []
    const write = jest.fn(async (cypher, params) => { writes.push({ cypher, params }) })
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await discoverFromIamPolicy({ credentials: null, projectId: 'p', write, query: makeQuery(infraRows), log })
    expect(stats.bindings).toBe(1)
    expect(stats.skipped).toBe(3)
    expect(stats.edges).toBe(0)
    expect(writes.filter(w => w.cypher.includes(':CONNECTS_TO'))).toHaveLength(0)
  })

  test('records errors when CAI listAssets throws', async () => {
    __nextAssets.value = []
    __nextAssets.throw = new Error('PERMISSION_DENIED')
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await discoverFromIamPolicy({ credentials: null, projectId: 'p', write: jest.fn(), query: makeQuery([]), log })
    expect(stats.errors).toHaveLength(1)
    expect(stats.errors[0]).toMatch(/PERMISSION_DENIED/)
  })

  test('bails when projectId is missing', async () => {
    __nextAssets.value = []
    __nextAssets.throw = null
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await discoverFromIamPolicy({ credentials: null, projectId: '', write: jest.fn(), query: makeQuery([]), log })
    expect(stats.errors).toContain('IAM Policy supplement requires projectId')
  })
})

// ─── supplementGCPDiscovery — public entry ───────────────────────────────────

describe('supplementGCPDiscovery', () => {
  test('autoLink: false skips the autoLink pass', async () => {
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const result = await supplementGCPDiscovery({
      write: jest.fn(),
      query: jest.fn(async () => []),
      log,
      autoLink: false,
    })
    expect(result.autoLink).toBeNull()
    expect(result.totalLinked).toBe(0)
    expect(result.errors).toEqual([])
  })

  test('warns only on truly-unknown layer names, not on iam-policy', async () => {
    const warn = jest.fn()
    const log = { info: () => {}, warn, debug: () => {} }
    __nextAssets.value = []
    __nextAssets.throw = null
    // 'iam-policy' is supported; 'vpc-flow-logs' is not yet
    await supplementGCPDiscovery({
      credentials: null,
      projectId:   'p',
      write:       jest.fn(),
      query:       jest.fn(async () => []),
      log,
      layers:      ['iam-policy', 'vpc-flow-logs'],
      autoLink:    false,
    })
    const warnArgs = warn.mock.calls.map(c => c[0]).join('\n')
    expect(warnArgs).toContain('vpc-flow-logs')
    expect(warnArgs).not.toContain('iam-policy')
  })

  test('iam-policy layer plumbs results through to top-level result object', async () => {
    __nextAssets.value = [
      {
        name:      '//storage.googleapis.com/projects/_/buckets/b1',
        assetType: 'storage.googleapis.com/Bucket',
        iamPolicy: { bindings: [{ role: 'roles/storage.objectViewer', members: ['allUsers'] }] },
      },
    ]
    __nextAssets.throw = null
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const result = await supplementGCPDiscovery({
      credentials: null,
      projectId:   'p',
      write:       jest.fn(),
      query:       jest.fn(async () => [
        { get: (k) => ({ cid: 'https://www.googleapis.com/storage/v1/b/b1', nid: 'b1-nid',
                         cai: '//storage.googleapis.com/projects/_/buckets/b1',
                         rtype: 'gcs_bucket' })[k] },
      ]),
      log,
      layers:   ['iam-policy'],
      autoLink: false,
    })
    expect(result.iamPolicy).not.toBeNull()
    expect(result.iamPolicy.publicResources).toBe(1)
  })
})
