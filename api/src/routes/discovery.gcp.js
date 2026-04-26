/**
 * discovery.gcp.js
 *
 * Primary GCP discovery via Cloud Asset Inventory (CAI).
 *
 * Replaces the old per-product GCP SDK scanner (Compute Engine, GKE,
 * Cloud SQL, Cloud Run) with a single paginated `listAssets` call. The
 * scanner:
 *
 *   1. Pages through CAI's `listAssetsAsync` for the project (asset
 *      resource representation; `pageToken` exhausted before return).
 *   2. Upserts a (:Infra) node per asset whose type appears in
 *      ASSET_TYPE_MAP (matching the schema in discovery.schema.js).
 *   3. Emits structural `:CONNECTS_TO` edges for every unambiguous
 *      reference the resource carries (Instance→Subnet, GKE→Network,
 *      Compute→ServiceAccount, …).
 *
 * Edge-write policy: single `:CONNECTS_TO` edge per logical
 * relationship, carrying `source`, `via`, `confidence`, `evidence`,
 * `discovered_at`, `last_seen`. No typed relationships.
 *
 * High-fidelity signals CAI cannot surface (VPC flow logs, IAM Policy
 * Analyzer effective-access edges) live in
 * `discovery.gcp.supplement.js`. Slice 2 ships with auto-link as the
 * only supplement; observed-flow layers are scoped for a later slice.
 *
 * See `docs/gcp-cloud-asset-coverage.md` for the per-type field audit.
 */

import { upsertInfra } from './discovery.js'

// ─── CAI assetType → AppCloud resourceType ────────────────────────────────────
const ASSET_TYPE_MAP = {
  // Existing types covered by the per-SDK scanner today
  'compute.googleapis.com/Instance':           'compute_instance',
  'container.googleapis.com/Cluster':          'gke_cluster',
  'sqladmin.googleapis.com/Instance':          'cloud_sql',
  'run.googleapis.com/Service':                'cloud_run',
  // New types CAI gives us "for free"
  'compute.googleapis.com/Network':            'gcp_vpc',
  'compute.googleapis.com/Subnetwork':         'gcp_subnet',
  'compute.googleapis.com/Disk':               'gcp_disk',
  'compute.googleapis.com/Firewall':           'gcp_firewall',
  'compute.googleapis.com/Address':            'gcp_address',
  'compute.googleapis.com/Router':             'gcp_router',
  'iam.googleapis.com/ServiceAccount':         'gcp_service_account',
  'storage.googleapis.com/Bucket':             'gcs_bucket',
  'pubsub.googleapis.com/Topic':               'pubsub_topic',
  'pubsub.googleapis.com/Subscription':        'pubsub_subscription',
  'bigquery.googleapis.com/Dataset':           'bigquery_dataset',
  'dataproc.googleapis.com/Cluster':           'dataproc_cluster',
  'redis.googleapis.com/Instance':             'gcp_redis',
  'spanner.googleapis.com/Instance':           'spanner_instance',
}

// ─── Structural via → confidence ─────────────────────────────────────────────
// Shared keys keep the same score across clouds; see VIA_TO_CONFIDENCE in
// discovery.azure.js. GCP-specific keys are added here.
const VIA_TO_CONFIDENCE = {
  'subnet':           65,
  'network':          65,
  'disk':             88,
  'service-account':  60,
  // GKE → network/subnet: same score as compute instance — the relationship
  // is structural plumbing, not a deep coupling.
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normId(id = '') {
  return (id || '').toLowerCase().replace(/\/$/, '')
}

// CAI's `name` field is a fully-qualified path (`//compute.googleapis.com/...`).
// `resource.data.selfLink` is the REST API URL for the same object — what the
// per-SDK scanner already used as `cloudId`. Prefer selfLink when present so
// MERGE keys stay stable across the migration; fall back to `name` otherwise.
function cloudIdFor(asset) {
  return asset.resource?.data?.selfLink
    || asset.resource?.data?.name
    || asset.name
}

// CAI returns location at the asset level for most types; for some, look in
// resource.data instead. Normalise to the per-SDK scanner's convention.
function regionFor(resourceType, asset) {
  const data = asset.resource?.data || {}
  switch (resourceType) {
    case 'compute_instance':
      return (data.zone || '').split('/').pop()?.replace(/-[a-z]$/, '') || ''
    case 'gke_cluster':
      return data.location || asset.resource?.location || ''
    case 'cloud_sql':
      return data.region || (data.gceZone || '').replace(/-[a-z]$/, '') || ''
    case 'cloud_run':
      // svc.name = projects/X/locations/<loc>/services/<svc>
      return (data.name || '').split('/locations/')[1]?.split('/')[0] || ''
    case 'gcp_subnet':
      return (data.region || '').split('/').pop() || ''
    case 'gcp_disk':
      return (data.zone || '').split('/').pop()?.replace(/-[a-z]$/, '') || ''
    default:
      return asset.resource?.location || data.location || data.region || 'global'
  }
}

function isPublic(resourceType, data = {}) {
  switch (resourceType) {
    case 'compute_instance': {
      return !!data.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP
    }
    case 'gke_cluster':
      return !data.privateClusterConfig?.enablePrivateEndpoint
    case 'cloud_sql':
      return (data.ipAddresses || []).some(ip => ip.type === 'PRIMARY')
    case 'cloud_run':
      return data.ingress === 'INGRESS_TRAFFIC_ALL'
    case 'gcs_bucket':
      // public iff there's an `allUsers` IAM binding — that's not in
      // resource.data; CAI surfaces it via iamPolicy contentType. Default
      // false until we add the iamPolicy supplement.
      return false
    case 'gcp_address':
      return (data.addressType || '').toUpperCase() === 'EXTERNAL'
    default:
      return false
  }
}

function statusFor(resourceType, data = {}) {
  switch (resourceType) {
    case 'compute_instance': return (data.status || 'unknown').toLowerCase()
    case 'gke_cluster':      return (data.status || 'unknown').toString().toLowerCase()
    case 'cloud_sql':        return (data.state || 'unknown').toLowerCase()
    case 'cloud_run':        return (data.terminalCondition?.state || 'unknown').toLowerCase()
    case 'gcp_disk':         return (data.status || 'unknown').toLowerCase()
    default:                 return 'unknown'
  }
}

// Extract the `raw` blob. Shape matches what the old per-SDK scanners
// emitted so promoted fields (discovery.schema.js RAW_PROMOTED_FIELDS.gcp)
// keep working. `caiName` is added so the IAM-policy supplement can look
// up resource → node by CAI's canonical //svc.googleapis.com/... name
// (which differs from the REST self-link we use as cloud_id).
function extractRaw(resourceType, asset) {
  const data = asset.resource?.data || {}
  const common = {
    assetType: asset.assetType,
    caiName:   asset.name,
    location:  asset.resource?.location || data.location || data.region,
  }
  switch (resourceType) {
    case 'compute_instance': {
      const externalIp = data.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP
      return {
        ...common,
        machineType:    (data.machineType || '').split('/').pop(),
        zone:           (data.zone || '').split('/').pop(),
        internalIp:     data.networkInterfaces?.[0]?.networkIP,
        externalIp,
        diskCount:      data.disks?.length || 0,
        serviceAccount: data.serviceAccounts?.[0]?.email,
        preemptible:    data.scheduling?.preemptible,
        creationTimestamp: data.creationTimestamp,
        // CAI-only fields kept for edge resolution
        network:        data.networkInterfaces?.[0]?.network,
        subnetwork:     data.networkInterfaces?.[0]?.subnetwork,
      }
    }
    case 'gke_cluster':
      return {
        ...common,
        initialClusterVersion: data.initialClusterVersion,
        currentMasterVersion:  data.currentMasterVersion,
        nodeCount:             data.currentNodeCount,
        endpoint:              data.endpoint,
        network:               data.network,
        subnetwork:            data.subnetwork,
        loggingService:        data.loggingService,
        monitoringService:     data.monitoringService,
        autopilot:             !!data.autopilot?.enabled,
      }
    case 'cloud_sql':
      return {
        ...common,
        databaseVersion:   data.databaseVersion,
        tier:              data.settings?.tier,
        dataDiskSizeGb:    data.settings?.dataDiskSizeGb,
        backupEnabled:     data.settings?.backupConfiguration?.enabled,
        maintenanceWindow: data.settings?.maintenanceWindow,
        ipAddress:         data.ipAddresses?.find(ip => ip.type === 'PRIMARY')?.ipAddress,
        availabilityType:  data.settings?.availabilityType,
        privateNetwork:    data.settings?.ipConfiguration?.privateNetwork || '',
      }
    case 'cloud_run':
      return {
        ...common,
        uri:            data.uri,
        creator:        data.creator,
        lastModifier:   data.lastModifier,
        containers:     data.template?.containers?.map(c => c.image),
        minInstances:   data.template?.scaling?.minInstanceCount,
        maxInstances:   data.template?.scaling?.maxInstanceCount,
        ingress:        data.ingress,
        serviceAccount: data.template?.serviceAccount,
      }
    case 'gcp_vpc':
      return {
        ...common,
        autoCreateSubnetworks: data.autoCreateSubnetworks,
        routingMode:           data.routingConfig?.routingMode,
        mtu:                   data.mtu,
      }
    case 'gcp_subnet':
      return {
        ...common,
        ipCidrRange:           data.ipCidrRange,
        network:               data.network,
        privateIpGoogleAccess: data.privateIpGoogleAccess,
        purpose:               data.purpose,
      }
    case 'gcp_disk':
      return {
        ...common,
        sizeGb:    data.sizeGb,
        type:      (data.type || '').split('/').pop(),
        sourceImage: data.sourceImage,
      }
    default:
      return common
  }
}

// Map AppCloud resourceType → stats counter key. Wire-compatible with the
// old per-SDK GCP scanner shape so response totaling keeps working.
function statsKeyFor(resourceType) {
  switch (resourceType) {
    case 'compute_instance': return 'instances'
    case 'gke_cluster':      return 'gke'
    case 'cloud_sql':        return 'sql'
    case 'cloud_run':        return 'cloudRun'
    default:                 return resourceType.replace(/_/g, '') + 'Count'
  }
}

// Service-account "email" comes from compute/cloud-run resource.data; the
// matching ServiceAccount asset is keyed on its self-link
// (`projects/X/serviceAccounts/<email>`). Build a normalised key for the
// in-memory cidToNid lookup so cross-resource SA references resolve.
function saKey(projectId, email) {
  if (!email || !projectId) return ''
  return `https://iam.googleapis.com/projects/${projectId}/serviceaccounts/${email.toLowerCase()}`
}

// ─── Edge writer (single :CONNECTS_TO write per logical edge) ────────────────

async function writeStructuralEdge(write, { from, to, via, source, evidence }) {
  if (!from || !to || from === to) return 0
  const confidence = VIA_TO_CONFIDENCE[via] ?? 60
  const params = { from, to, via, source, confidence, evidence }
  try {
    await write(`
      MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
      MERGE (a)-[r:CONNECTS_TO {via: $via}]->(b)
      ON CREATE SET r.discovered_at = datetime(),
                    r.source        = $source,
                    r.confidence    = $confidence,
                    r.evidence      = $evidence
      ON MATCH  SET r.last_seen     = datetime(),
                    r.source        = $source,
                    r.confidence    = $confidence,
                    r.evidence      = $evidence
    `, params)
    return 1
  } catch {
    return 0
  }
}

// ─── Structural edge extraction ──────────────────────────────────────────────

async function emitStructuralEdges({ asset, resourceType, projectId, resolve, write, stats }) {
  const fromNid = resolve(cloudIdFor(asset))
  if (!fromNid) return
  const data = asset.resource?.data || {}
  const source = 'gcp-cloud-asset-inventory'

  const link = async (via, toRef, evidenceDetail) => {
    const toNid = resolve(toRef)
    if (!toNid) return
    const evidence = `CAI: ${asset.assetType} ${via}${evidenceDetail ? ` ${evidenceDetail}` : ''}`
    const n = await writeStructuralEdge(write, { from: fromNid, to: toNid, via, source, evidence })
    if (n) stats.edges++
  }

  switch (resourceType) {
    case 'compute_instance': {
      for (const nic of data.networkInterfaces || []) {
        if (nic.subnetwork) await link('subnet',  nic.subnetwork)
        if (nic.network)    await link('network', nic.network)
      }
      for (const disk of data.disks || []) {
        if (disk.source) await link('disk', disk.source)
      }
      for (const sa of data.serviceAccounts || []) {
        if (sa.email) await link('service-account', saKey(projectId, sa.email), `(${sa.email})`)
      }
      break
    }
    case 'gke_cluster': {
      if (data.network)    await link('network', data.network)
      if (data.subnetwork) await link('subnet',  data.subnetwork)
      break
    }
    case 'cloud_run': {
      const sa = data.template?.serviceAccount
      if (sa) await link('service-account', saKey(projectId, sa), `(${sa})`)
      break
    }
    case 'gcp_subnet': {
      if (data.network) await link('network', data.network)
      break
    }
    // Other types currently emit no structural edges; revisit as supplement
    // layers and IAM-policy edges land.
  }
}

// ─── CAI pagination ──────────────────────────────────────────────────────────

async function fetchAllAssets(client, parent, log, stats) {
  const all = []
  let page = 0
  try {
    const iter = client.listAssetsAsync({
      parent,
      contentType: 'RESOURCE',
      // No assetTypes filter — pull everything and classify client-side so
      // we get every CAI-supported type without needing to update a list.
    })
    for await (const asset of iter) {
      all.push(asset)
    }
  } catch (err) {
    stats.errors.push(`CAI listAssets: ${err.message}`)
    log.warn?.(`[GCP Scanner] CAI listAssets failed: ${err.message}`)
    return all
  }
  log.info?.(`[GCP Scanner] CAI returned ${all.length} assets (parent=${parent}, pages=${page || 'iterator'})`)
  return all
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * scanGCP({ credentials, projectId, write, log, scanEpoch })
 *
 * Drop-in replacement for the old per-product scanner. Returns a stats
 * object whose summable keys match the legacy shape so orchestration
 * response totaling keeps working:
 *   { instances, gke, sql, cloudRun, <type>Count…, edges, errors,
 *     skipped, scanEpoch }
 */
export async function scanGCP({ credentials, projectId, write, log, scanEpoch }) {
  scanEpoch = scanEpoch || Date.now()
  const project = projectId || process.env.GCP_PROJECT_ID
  if (!project) throw new Error('GCP_PROJECT_ID is required for GCP discovery')

  const { AssetServiceClient } = await import('@google-cloud/asset')

  const clientOpts = credentials?.client_email ? { credentials, projectId: project } : { projectId: project }
  const client = new AssetServiceClient(clientOpts)

  const stats = {
    instances: 0, gke: 0, sql: 0, cloudRun: 0,
    edges: 0, errors: [], skipped: [], scanEpoch,
  }

  // ── Pass 1: page through all assets ───────────────────────────────────
  const allAssets = await fetchAllAssets(client, `projects/${project}`, log, stats)

  // ── Pass 2: upsert recognised assets; build cid → nodeId map ──────────
  const cidToNid = {}
  for (const asset of allAssets) {
    const resourceType = ASSET_TYPE_MAP[asset.assetType]
    if (!resourceType) {
      stats.skipped.push(`unmapped type: ${asset.assetType}`)
      continue
    }

    const data = asset.resource?.data || {}
    const cloudId = cloudIdFor(asset)
    if (!cloudId) {
      stats.skipped.push(`no cloudId for ${asset.name}`)
      continue
    }

    try {
      const nodeId = await upsertInfra(write, {
        cloudId,
        name:         data.name?.split('/').pop() || asset.name?.split('/').pop(),
        provider:     'gcp',
        resourceType,
        region:       regionFor(resourceType, asset),
        status:       statusFor(resourceType, data),
        public:       isPublic(resourceType, data),
        tags:         data.labels || data.userLabels || data.resourceLabels || {},
        raw:          extractRaw(resourceType, asset),
        scanEpoch,
      })
      if (nodeId) cidToNid[normId(cloudId)] = nodeId

      const key = statsKeyFor(resourceType)
      stats[key] = (stats[key] || 0) + 1
    } catch (err) {
      stats.errors.push(`upsert ${cloudId}: ${err.message}`)
    }
  }

  // ── Pass 3: emit structural edges ─────────────────────────────────────
  const resolve = (ref) => ref ? cidToNid[normId(ref)] : undefined
  for (const asset of allAssets) {
    const resourceType = ASSET_TYPE_MAP[asset.assetType]
    if (!resourceType) continue
    try {
      await emitStructuralEdges({ asset, resourceType, projectId: project, resolve, write, stats })
    } catch (err) {
      stats.errors.push(`edge ${asset.name}: ${err.message}`)
    }
  }

  log.info?.(
    `[GCP Scanner] Complete — nodes: ${
      Object.entries(stats)
        .filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k))
        .reduce((s, [,v]) => s + (typeof v === 'number' ? v : 0), 0)
    }, edges: ${stats.edges}, errors: ${stats.errors.length}`
  )

  return stats
}

// Internal exports for tests.
export const __test__ = {
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
}
