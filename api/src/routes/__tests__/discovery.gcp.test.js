import { describe, test, expect, jest } from '@jest/globals'
import { __test__ } from '../discovery.gcp.js'

const {
  ASSET_TYPE_MAP,
  VIA_TO_CONFIDENCE,
  cloudIdFor,
  regionFor,
  isPublic,
  statusFor,
  extractRaw,
  statsKeyFor,
  saKey,
  emitStructuralEdges,
  writeStructuralEdge,
} = __test__

// ─── ASSET_TYPE_MAP ───────────────────────────────────────────────────────────

describe('ASSET_TYPE_MAP', () => {
  test('covers all 4 resource types the per-SDK scanner supported', () => {
    expect(ASSET_TYPE_MAP['compute.googleapis.com/Instance']).toBe('compute_instance')
    expect(ASSET_TYPE_MAP['container.googleapis.com/Cluster']).toBe('gke_cluster')
    expect(ASSET_TYPE_MAP['sqladmin.googleapis.com/Instance']).toBe('cloud_sql')
    expect(ASSET_TYPE_MAP['run.googleapis.com/Service']).toBe('cloud_run')
  })
  test('expands coverage to types CAI gives us for free', () => {
    expect(ASSET_TYPE_MAP['compute.googleapis.com/Network']).toBe('gcp_vpc')
    expect(ASSET_TYPE_MAP['compute.googleapis.com/Subnetwork']).toBe('gcp_subnet')
    expect(ASSET_TYPE_MAP['iam.googleapis.com/ServiceAccount']).toBe('gcp_service_account')
    expect(ASSET_TYPE_MAP['storage.googleapis.com/Bucket']).toBe('gcs_bucket')
    expect(ASSET_TYPE_MAP['pubsub.googleapis.com/Topic']).toBe('pubsub_topic')
    expect(ASSET_TYPE_MAP['bigquery.googleapis.com/Dataset']).toBe('bigquery_dataset')
  })
})

// ─── VIA_TO_CONFIDENCE — score-locking ────────────────────────────────────────
//
// Cross-cloud invariant: shared `via` keys keep the same score across clouds.
// If you change one of these, you must update both Azure and GCP scanners.

describe('VIA_TO_CONFIDENCE', () => {
  test('matches Azure cross-cloud shared keys', () => {
    expect(VIA_TO_CONFIDENCE['subnet']).toBe(65)
    expect(VIA_TO_CONFIDENCE['network']).toBe(65)
    expect(VIA_TO_CONFIDENCE['disk']).toBe(88)
    expect(VIA_TO_CONFIDENCE['service-account']).toBe(60)
  })
})

// ─── cloudIdFor — identity continuity ────────────────────────────────────────
//
// Critical: the new scanner must produce the same cloud_id as the per-SDK
// scanner did, so existing nodes don't get duplicated by MERGE.

describe('cloudIdFor', () => {
  test('prefers resource.data.selfLink (matches per-SDK scanner cloudId)', () => {
    expect(cloudIdFor({
      name: '//compute.googleapis.com/projects/p/zones/us-central1-a/instances/foo',
      resource: { data: { selfLink: 'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/foo' } },
    })).toBe('https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/foo')
  })
  test('falls back to resource.data.name (Cloud Run convention)', () => {
    expect(cloudIdFor({
      name: '//run.googleapis.com/projects/p/locations/us-central1/services/bar',
      resource: { data: { name: 'projects/p/locations/us-central1/services/bar' } },
    })).toBe('projects/p/locations/us-central1/services/bar')
  })
  test('falls back to asset.name when resource.data is empty', () => {
    expect(cloudIdFor({ name: '//compute.googleapis.com/foo', resource: {} })).toBe('//compute.googleapis.com/foo')
  })
})

// ─── regionFor ────────────────────────────────────────────────────────────────

describe('regionFor', () => {
  test('compute_instance: zone → region (strips trailing -a/-b/-c)', () => {
    expect(regionFor('compute_instance', { resource: { data: { zone: 'projects/p/zones/us-central1-a' } } })).toBe('us-central1')
  })
  test('gke_cluster: location is the region', () => {
    expect(regionFor('gke_cluster', { resource: { data: { location: 'us-central1' } } })).toBe('us-central1')
  })
  test('cloud_sql: prefers region, falls back to gceZone', () => {
    expect(regionFor('cloud_sql', { resource: { data: { region: 'us-central1' } } })).toBe('us-central1')
    expect(regionFor('cloud_sql', { resource: { data: { gceZone: 'us-central1-a' } } })).toBe('us-central1')
  })
  test('cloud_run: parses location from name', () => {
    expect(regionFor('cloud_run', { resource: { data: { name: 'projects/p/locations/europe-west1/services/bar' } } })).toBe('europe-west1')
  })
})

// ─── isPublic ────────────────────────────────────────────────────────────────

describe('isPublic', () => {
  test('compute_instance: external IP gate', () => {
    expect(isPublic('compute_instance', {
      networkInterfaces: [{ accessConfigs: [{ natIP: '1.2.3.4' }] }],
    })).toBe(true)
    expect(isPublic('compute_instance', {
      networkInterfaces: [{ accessConfigs: [{}] }],
    })).toBe(false)
  })
  test('gke_cluster: inverts enablePrivateEndpoint', () => {
    expect(isPublic('gke_cluster', { privateClusterConfig: { enablePrivateEndpoint: true } })).toBe(false)
    expect(isPublic('gke_cluster', { privateClusterConfig: { enablePrivateEndpoint: false } })).toBe(true)
    expect(isPublic('gke_cluster', {})).toBe(true)
  })
  test('cloud_sql: PRIMARY ipAddress', () => {
    expect(isPublic('cloud_sql', { ipAddresses: [{ type: 'PRIMARY', ipAddress: '1.2.3.4' }] })).toBe(true)
    expect(isPublic('cloud_sql', { ipAddresses: [{ type: 'OUTGOING', ipAddress: '1.2.3.4' }] })).toBe(false)
  })
  test('cloud_run: ingress = INGRESS_TRAFFIC_ALL', () => {
    expect(isPublic('cloud_run', { ingress: 'INGRESS_TRAFFIC_ALL' })).toBe(true)
    expect(isPublic('cloud_run', { ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' })).toBe(false)
  })
  test('gcp_address: EXTERNAL', () => {
    expect(isPublic('gcp_address', { addressType: 'EXTERNAL' })).toBe(true)
    expect(isPublic('gcp_address', { addressType: 'INTERNAL' })).toBe(false)
  })
})

// ─── statusFor ────────────────────────────────────────────────────────────────

describe('statusFor', () => {
  test('compute_instance: lowercases status', () => {
    expect(statusFor('compute_instance', { status: 'RUNNING' })).toBe('running')
  })
  test('gke_cluster: stringifies and lowercases', () => {
    expect(statusFor('gke_cluster', { status: 'RUNNING' })).toBe('running')
    expect(statusFor('gke_cluster', { status: 5 })).toBe('5')
  })
  test('cloud_sql: lowercases state', () => {
    expect(statusFor('cloud_sql', { state: 'RUNNABLE' })).toBe('runnable')
  })
  test('cloud_run: drills into terminalCondition.state', () => {
    expect(statusFor('cloud_run', { terminalCondition: { state: 'CONDITION_SUCCEEDED' } })).toBe('condition_succeeded')
  })
})

// ─── extractRaw — promoted-field continuity ──────────────────────────────────

describe('extractRaw', () => {
  test('compute_instance preserves all promoted fields used downstream', () => {
    const asset = {
      assetType: 'compute.googleapis.com/Instance',
      resource: { location: 'us-central1-a', data: {
        machineType:    'projects/p/zones/us-central1-a/machineTypes/n1-standard-4',
        zone:           'projects/p/zones/us-central1-a',
        networkInterfaces: [{
          networkIP:  '10.0.0.5',
          network:    'projects/p/global/networks/default',
          subnetwork: 'projects/p/regions/us-central1/subnetworks/default',
          accessConfigs: [{ natIP: '34.1.2.3' }],
        }],
        disks: [{ source: 'projects/p/zones/us-central1-a/disks/foo' }],
        serviceAccounts: [{ email: 'sa@p.iam.gserviceaccount.com' }],
        scheduling: { preemptible: true },
        creationTimestamp: '2024-01-01T00:00:00Z',
      } },
    }
    const raw = extractRaw('compute_instance', asset)
    expect(raw.machineType).toBe('n1-standard-4')
    expect(raw.zone).toBe('us-central1-a')
    expect(raw.internalIp).toBe('10.0.0.5')
    expect(raw.externalIp).toBe('34.1.2.3')
    expect(raw.diskCount).toBe(1)
    expect(raw.serviceAccount).toBe('sa@p.iam.gserviceaccount.com')
    expect(raw.preemptible).toBe(true)
    expect(raw.network).toBe('projects/p/global/networks/default')
    expect(raw.subnetwork).toBe('projects/p/regions/us-central1/subnetworks/default')
  })

  test('gke_cluster preserves network/subnet for edge resolution', () => {
    const asset = {
      assetType: 'container.googleapis.com/Cluster',
      resource: { data: {
        kubernetesVersion: '1.28',
        currentMasterVersion: '1.28.5',
        currentNodeCount: 3,
        endpoint: '1.2.3.4',
        network: 'default',
        subnetwork: 'projects/p/regions/us-central1/subnetworks/default',
        autopilot: { enabled: true },
      } },
    }
    const raw = extractRaw('gke_cluster', asset)
    expect(raw.network).toBe('default')
    expect(raw.subnetwork).toBe('projects/p/regions/us-central1/subnetworks/default')
    expect(raw.autopilot).toBe(true)
  })
})

// ─── statsKeyFor — wire-compat with old per-SDK scanner ──────────────────────

describe('statsKeyFor', () => {
  test('legacy types map to legacy keys (instances/gke/sql/cloudRun)', () => {
    expect(statsKeyFor('compute_instance')).toBe('instances')
    expect(statsKeyFor('gke_cluster')).toBe('gke')
    expect(statsKeyFor('cloud_sql')).toBe('sql')
    expect(statsKeyFor('cloud_run')).toBe('cloudRun')
  })
  test('new types use <type>Count pattern', () => {
    expect(statsKeyFor('gcp_vpc')).toBe('gcpvpcCount')
    expect(statsKeyFor('gcs_bucket')).toBe('gcsbucketCount')
    expect(statsKeyFor('pubsub_topic')).toBe('pubsubtopicCount')
  })
})

// ─── saKey — service-account self-link normalisation ─────────────────────────

describe('saKey', () => {
  test('builds a stable key from project + email (lowercased)', () => {
    expect(saKey('my-proj', 'sa@my-proj.iam.gserviceaccount.com'))
      .toBe('https://iam.googleapis.com/projects/my-proj/serviceaccounts/sa@my-proj.iam.gserviceaccount.com')
    expect(saKey('my-proj', 'SA@MY-PROJ.iam.gserviceaccount.com'))
      .toBe('https://iam.googleapis.com/projects/my-proj/serviceaccounts/sa@my-proj.iam.gserviceaccount.com')
  })
  test('returns empty when project or email is missing', () => {
    expect(saKey('', 'a@b')).toBe('')
    expect(saKey('p', '')).toBe('')
  })
})

// ─── writeStructuralEdge — single :CONNECTS_TO write ────────────────────────

describe('writeStructuralEdge', () => {
  test('writes a single :CONNECTS_TO edge with traceability properties', async () => {
    const calls = []
    const write = jest.fn(async (cypher, params) => { calls.push({ cypher, params }) })
    const n = await writeStructuralEdge(write, {
      from: 'A', to: 'B', via: 'subnet', source: 'gcp-cloud-asset-inventory', evidence: 'CAI: ... subnet',
    })
    expect(n).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].cypher).toMatch(/:CONNECTS_TO/)
    expect(calls[0].cypher).not.toMatch(/:CONNECTED_TO/)
    expect(calls[0].params.confidence).toBe(65) // VIA_TO_CONFIDENCE['subnet']
  })

  test('skips self-edges and missing endpoints', async () => {
    const write = jest.fn()
    expect(await writeStructuralEdge(write, { from: 'X', to: 'X', via: 'subnet', source: 's' })).toBe(0)
    expect(await writeStructuralEdge(write, { from: '',  to: 'B', via: 'subnet', source: 's' })).toBe(0)
    expect(await writeStructuralEdge(write, { from: 'A', to: '',  via: 'subnet', source: 's' })).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })
})

// ─── emitStructuralEdges ─────────────────────────────────────────────────────

describe('emitStructuralEdges — compute_instance', () => {
  test('emits subnet/network/disk/service-account links with ARG-derived evidence', async () => {
    const written = []
    const write = jest.fn(async (cypher, params) => { written.push({ via: params.via, source: params.source, evidence: params.evidence }) })
    const stats = { edges: 0, errors: [] }
    const cidToNid = {
      'https://compute.googleapis.com/v1/projects/p/zones/us-central1-a/instances/vm1': 'nid-vm1',
      'projects/p/global/networks/default':                                              'nid-net',
      'projects/p/regions/us-central1/subnetworks/default':                              'nid-subnet',
      'projects/p/zones/us-central1-a/disks/d1':                                         'nid-disk',
      'https://iam.googleapis.com/projects/p/serviceaccounts/sa@p.iam.gserviceaccount.com': 'nid-sa',
    }
    const resolve = (ref) => ref ? cidToNid[(ref || '').toLowerCase()] : undefined
    const asset = {
      assetType: 'compute.googleapis.com/Instance',
      resource: { data: {
        selfLink: 'https://compute.googleapis.com/v1/projects/p/zones/us-central1-a/instances/vm1',
        networkInterfaces: [{ network: 'projects/p/global/networks/default', subnetwork: 'projects/p/regions/us-central1/subnetworks/default' }],
        disks: [{ source: 'projects/p/zones/us-central1-a/disks/d1' }],
        serviceAccounts: [{ email: 'sa@p.iam.gserviceaccount.com' }],
      } },
    }
    await emitStructuralEdges({ asset, resourceType: 'compute_instance', projectId: 'p', resolve, write, stats })

    // 4 logical edges × 1 cypher write each = 4 cypher writes
    expect(written).toHaveLength(4)
    const vias = [...new Set(written.map(w => w.via))].sort()
    expect(vias).toEqual(['disk', 'network', 'service-account', 'subnet'])
    expect(written.every(w => w.source === 'gcp-cloud-asset-inventory')).toBe(true)
    expect(written.every(w => w.evidence.startsWith('CAI: compute.googleapis.com/Instance'))).toBe(true)
    expect(stats.edges).toBe(4) // counted once per logical edge
  })
})

describe('emitStructuralEdges — gke_cluster', () => {
  test('emits network and subnet edges only', async () => {
    const written = []
    const write = jest.fn(async (_, params) => { written.push(params.via) })
    const stats = { edges: 0, errors: [] }
    const cidToNid = {
      'https://container.googleapis.com/v1/projects/p/locations/us-central1/clusters/c1': 'nid-c1',
      'projects/p/global/networks/default':                                                 'nid-net',
      'projects/p/regions/us-central1/subnetworks/default':                                 'nid-subnet',
    }
    const resolve = (ref) => ref ? cidToNid[(ref || '').toLowerCase()] : undefined
    const asset = {
      assetType: 'container.googleapis.com/Cluster',
      resource: { data: {
        selfLink: 'https://container.googleapis.com/v1/projects/p/locations/us-central1/clusters/c1',
        network: 'projects/p/global/networks/default',
        subnetwork: 'projects/p/regions/us-central1/subnetworks/default',
      } },
    }
    await emitStructuralEdges({ asset, resourceType: 'gke_cluster', projectId: 'p', resolve, write, stats })
    const vias = [...new Set(written)].sort()
    expect(vias).toEqual(['network', 'subnet'])
    expect(stats.edges).toBe(2)
  })
})

describe('emitStructuralEdges — cloud_run', () => {
  test('emits service-account edge from template.serviceAccount', async () => {
    const written = []
    const write = jest.fn(async (_, params) => { written.push({ via: params.via, source: params.source }) })
    const stats = { edges: 0, errors: [] }
    const cidToNid = {
      'projects/p/locations/us-central1/services/svc1': 'nid-svc',
      'https://iam.googleapis.com/projects/p/serviceaccounts/runner@p.iam.gserviceaccount.com': 'nid-sa',
    }
    const resolve = (ref) => ref ? cidToNid[(ref || '').toLowerCase()] : undefined
    const asset = {
      assetType: 'run.googleapis.com/Service',
      resource: { data: {
        name: 'projects/p/locations/us-central1/services/svc1',
        template: { serviceAccount: 'runner@p.iam.gserviceaccount.com' },
      } },
    }
    await emitStructuralEdges({ asset, resourceType: 'cloud_run', projectId: 'p', resolve, write, stats })
    expect(stats.edges).toBe(1)
    expect(written.map(w => w.via)).toEqual(['service-account']) // single :CONNECTS_TO write
  })
})

describe('emitStructuralEdges — gcp_subnet', () => {
  test('emits network edge only', async () => {
    const written = []
    const write = jest.fn(async (_, params) => { written.push(params.via) })
    const stats = { edges: 0, errors: [] }
    const cidToNid = {
      'projects/p/regions/us-central1/subnetworks/default': 'nid-subnet',
      'projects/p/global/networks/default':                  'nid-net',
    }
    const resolve = (ref) => ref ? cidToNid[(ref || '').toLowerCase()] : undefined
    const asset = {
      assetType: 'compute.googleapis.com/Subnetwork',
      resource: { data: {
        selfLink: 'projects/p/regions/us-central1/subnetworks/default',
        network: 'projects/p/global/networks/default',
      } },
    }
    await emitStructuralEdges({ asset, resourceType: 'gcp_subnet', projectId: 'p', resolve, write, stats })
    expect(stats.edges).toBe(1)
    expect([...new Set(written)]).toEqual(['network'])
  })
})
