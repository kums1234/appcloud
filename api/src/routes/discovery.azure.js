/**
 * discovery.azure.js
 *
 * Primary Azure discovery via Azure Resource Graph (ARG).
 *
 * Replaces the old per-type Azure SDK scanner (VM, AKS, SQL, App Service,
 * Redis, VNet + generic ResourceManagementClient catch-all) with a single
 * KQL query that returns every resource in the subscription with its full
 * ARM `properties` projection. The scanner:
 *
 *   1. Pages through `Resources` via ARG (skipToken pagination).
 *   2. Upserts a (:Infra) node per resource (keeping the same :Infra
 *      schema, typed labels, and promoted fields as the SDK scanner).
 *   3. Emits structural `:CONNECTS_TO` edges for every unambiguous ARM
 *      reference (VM→NIC→Subnet, WebApp→Plan, Redis→Subnet, …).
 *
 * Edge-write policy: a single `:CONNECTS_TO` edge per logical
 * relationship, carrying `source`, `via`, `confidence`, `evidence`,
 * `discovered_at`, `last_seen`. No typed relationships.
 *
 * High-fidelity signals ARG cannot surface (Azure Network Watcher
 * topology, VM Insights observed TCP) live in
 * `discovery.azure.supplement.js` and remain opt-in per scan.
 *
 * See `docs/azure-resource-graph-coverage.md` for the per-type field audit.
 */

import { upsertInfra } from './discovery.js'

// ─── ARM type → AppCloud resourceType ─────────────────────────────────────────
// Union of types the old per-SDK scanners and the generic catch-all covered.
const ARM_TYPE_MAP = {
  'microsoft.compute/virtualmachines':            'vm',
  'microsoft.containerservice/managedclusters':   'aks_cluster',
  'microsoft.sql/servers':                        'sql_server',
  'microsoft.sql/servers/databases':              'sql_database',
  'microsoft.web/sites':                          'app_service',          // refined below for function apps via `kind`
  'microsoft.web/serverfarms':                    'app_service_plan',
  'microsoft.cache/redis':                        'redis',
  'microsoft.network/virtualnetworks':            'vnet',
  'microsoft.network/networkinterfaces':          'network_interface',
  'microsoft.network/networksecuritygroups':      'nsg',
  'microsoft.network/applicationgateways':        'application_gateway',
  'microsoft.network/loadbalancers':              'load_balancer',
  'microsoft.network/publicipaddresses':          'public_ip',
  'microsoft.network/privatednszones':            'private_dns',
  'microsoft.network/privateendpoints':           'private_endpoint',
  'microsoft.network/routetables':                'route_table',
  'microsoft.compute/disks':                      'managed_disk',
  'microsoft.insights/components':                'app_insights',
  'microsoft.storage/storageaccounts':            'storage_account',
  'microsoft.servicebus/namespaces':              'service_bus',
  'microsoft.keyvault/vaults':                    'key_vault',
  'microsoft.eventhub/namespaces':                'event_hub',
  'microsoft.eventgrid/topics':                   'event_grid',
  'microsoft.logic/workflows':                    'logic_app',
  'microsoft.cdn/profiles':                       'cdn',
  'microsoft.apimanagement/service':              'api_management',
  'microsoft.documentdb/databaseaccounts':        'cosmos_db',
  'microsoft.dbforpostgresql/servers':            'postgres_server',
  'microsoft.dbforpostgresql/flexibleservers':    'postgres_server',
  'microsoft.dbformysql/servers':                 'mysql_server',
  'microsoft.dbformysql/flexibleservers':         'mysql_server',
  'microsoft.containerregistry/registries':       'container_registry',
  'microsoft.operationalinsights/workspaces':     'log_analytics',
  'microsoft.web/staticsites':                    'static_web_app',
}

// ─── Structural via → confidence score ────────────────────────────────────────
// Matches the existing scoring used by enrich's autoLink Rule 2 — keep in
// sync with discovery.azure.supplement.js.
const VIA_TO_CONFIDENCE = {
  'nic':                  90,
  'disk':                 88,
  'app-service-plan':     85,
  'sql-server':           85,
  'redis-vnet-injection': 82,
  'vnet-integration':     80,
  'aks-node-subnet':      80,
  'lb-backend-nic':       75,
  'agw-subnet':           72,
  'private-endpoint':     70,
  'subnet':               65,
  'vnet':                 65,
  'app-insights':         65,
  'monitors':             65,
  'public-ip':            60,
  'keyvault-vnet-rule':   60,
  'nsg':                  55,
  'route-table':          55,
}

// Per-page row cap in Azure Resource Graph (service maximum is 1000).
const ARG_PAGE_SIZE = 1000

// KQL projection. `properties` is the full ARM property bag — every field
// the old per-SDK scanners read is accessible under properties.* (see
// docs/azure-resource-graph-coverage.md).
const ARG_QUERY = `
  Resources
  | project id, name, type, kind, location, resourceGroup, subscriptionId,
            tags, sku, identity, properties, zones
`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normId(id = '') {
  return id.toLowerCase().replace(/\/$/, '')
}

function classifyResourceType(armType, kind) {
  const base = ARM_TYPE_MAP[armType]
  if (!base) return null
  // Refine: microsoft.web/sites → app_service vs function_app by `kind`
  if (base === 'app_service' && (kind || '').toLowerCase().includes('functionapp')) {
    return 'function_app'
  }
  return base
}

function extractStatus(p = {}) {
  return p.provisioningState || p.state || 'unknown'
}

function extractPublic(resourceType, p = {}, res = {}) {
  switch (resourceType) {
    case 'sql_server':
    case 'redis':
    case 'postgres_server':
    case 'mysql_server':
    case 'cosmos_db':
      return p.publicNetworkAccess === 'Enabled'
    case 'app_service':
      return true
    case 'function_app':
      return false
    case 'aks_cluster':
      return !p.apiServerAccessProfile?.enablePrivateCluster
    case 'load_balancer': {
      const fronts = p.frontendIPConfigurations || []
      return fronts.some(f => f.properties?.publicIPAddress)
    }
    case 'application_gateway':
      return true
    case 'public_ip':
      return true
    default:
      return false
  }
}

function stringifySku(sku) {
  if (!sku) return ''
  if (typeof sku === 'string') return sku
  return [sku.name, sku.tier, sku.family, sku.capacity].filter(Boolean).join(' ').trim()
}

// Extract the `raw` blob for a resource. Shape matches what the old per-SDK
// scanners emitted so promoted fields (discovery.schema.js) keep working.
function extractRaw(resourceType, res) {
  const p  = res.properties || {}
  const rg = res.resourceGroup || ''
  const common = {
    type:          res.type,
    kind:          res.kind,
    sku:           stringifySku(res.sku),
    identity:      res.identity?.type,
    resourceGroup: rg,
  }
  switch (resourceType) {
    case 'vm':
      return {
        ...common,
        vmSize:            p.hardwareProfile?.vmSize,
        osType:            p.storageProfile?.osDisk?.osType,
        imagePublisher:    p.storageProfile?.imageReference?.publisher,
        imageOffer:        p.storageProfile?.imageReference?.offer,
        imageSku:          p.storageProfile?.imageReference?.sku,
        availabilityZones: res.zones,
        adminUsername:     p.osProfile?.adminUsername,
      }
    case 'aks_cluster': {
      const pools = p.agentPoolProfiles || []
      return {
        ...common,
        kubernetesVersion: p.kubernetesVersion,
        nodeCount:         pools.reduce((s, a) => s + (a.count || 0), 0),
        nodeVmSize:        pools[0]?.vmSize,
        dnsPrefix:         p.dnsPrefix,
        fqdn:              p.fqdn,
        networkPlugin:     p.networkProfile?.networkPlugin,
        enableRBAC:        p.enableRBAC,
        vnetSubnetId:      pools[0]?.vnetSubnetID || '',
      }
    }
    case 'sql_server':
      return {
        ...common,
        version:                  p.version,
        administratorLogin:       p.administratorLogin,
        fullyQualifiedDomainName: p.fullyQualifiedDomainName,
        publicNetworkAccess:      p.publicNetworkAccess,
        minimalTlsVersion:        p.minimalTlsVersion,
      }
    case 'app_service':
    case 'function_app':
      return {
        ...common,
        type:                  'microsoft.web/sites',
        defaultHostName:       p.defaultHostName,
        httpsOnly:             p.httpsOnly,
        serverFarmId:          p.serverFarmId,
        outboundIpAddresses:   p.outboundIpAddresses,
        clientAffinityEnabled: p.clientAffinityEnabled,
        enabled:               p.enabled,
        vnetSubnetId:          p.virtualNetworkSubnetId || '',
      }
    case 'redis':
      return {
        ...common,
        sku:               stringifySku(res.sku),
        hostName:          p.hostName,
        port:              p.port,
        sslPort:           p.sslPort,
        redisVersion:      p.redisVersion,
        minimumTlsVersion: p.minimumTlsVersion,
        enableNonSslPort:  p.enableNonSslPort,
        subnetId:          p.subnetId || '',
      }
    case 'vnet':
      return {
        ...common,
        addressSpace:         p.addressSpace?.addressPrefixes,
        subnetCount:          p.subnets?.length || 0,
        dnsServers:           p.dhcpOptions?.dnsServers,
        enableDdosProtection: p.enableDdosProtection,
        subnets:              (p.subnets || []).map(s => ({
          id: s.id, name: s.name, prefix: s.properties?.addressPrefix,
        })),
      }
    default:
      return common
  }
}

// Map resourceType → stats counter key. Keeps wire-compatible with the
// old per-SDK scanner shape so the orchestration layer's response totaling
// (`Object.entries(stats).filter(...).reduce(s+v)`) keeps working.
function statsKeyFor(resourceType) {
  switch (resourceType) {
    case 'vm':            return 'vms'
    case 'aks_cluster':   return 'aks'
    case 'sql_server':    return 'sql'
    case 'app_service':   return 'appService'
    case 'function_app':  return 'functionApp'
    case 'redis':         return 'redis'
    case 'vnet':          return 'vnet'
    default:              return resourceType.replace(/_/g, '') + 'Count'
  }
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

// ─── Structural edge extraction (replaces enrich Layer A) ─────────────────────

async function emitStructuralEdges({ res, resolve, write, stats }) {
  const fromNid = resolve(res.id)
  if (!fromNid) return
  const p    = res.properties || {}
  const type = (res.type || '').toLowerCase()
  const source = 'azure-resource-graph'

  const link = async (via, toArmId, evidenceDetail) => {
    const toNid = resolve(toArmId)
    if (!toNid) return
    const evidence = `ARG: ${type} ${via}${evidenceDetail ? ` ${evidenceDetail}` : ''}`
    const n = await writeStructuralEdge(write, { from: fromNid, to: toNid, via, source, evidence })
    if (n) stats.edges++
  }

  // VM → NIC, VM → managed disk
  if (type === 'microsoft.compute/virtualmachines') {
    for (const nic of p.networkProfile?.networkInterfaces || []) await link('nic', nic.id)
    for (const disk of p.storageProfile?.dataDisks || []) {
      if (disk.managedDisk?.id) await link('disk', disk.managedDisk.id)
    }
  }

  // NIC → Subnet, NIC → Public IP, NIC → NSG
  if (type === 'microsoft.network/networkinterfaces') {
    for (const cfg of p.ipConfigurations || []) {
      await link('subnet', cfg.properties?.subnet?.id)
      if (cfg.properties?.publicIPAddress?.id) {
        await link('public-ip', cfg.properties.publicIPAddress.id)
      }
    }
    if (p.networkSecurityGroup?.id) await link('nsg', p.networkSecurityGroup.id)
  }

  // Subnet → VNet (reverse: emit from subnet), Subnet → NSG, Subnet → Route Table
  if (type === 'microsoft.network/virtualnetworks') {
    for (const subnet of p.subnets || []) {
      const subNid = resolve(subnet.id)
      if (!subNid) continue
      const evidenceDetail = subnet.name ? `(subnet=${subnet.name})` : ''
      await writeStructuralEdge(write, {
        from: subNid, to: fromNid, via: 'vnet', source,
        evidence: `ARG: subnet→vnet ${evidenceDetail}`.trim(),
      }).then(n => { if (n) stats.edges++ })
      if (subnet.properties?.networkSecurityGroup?.id) {
        const nsgNid = resolve(subnet.properties.networkSecurityGroup.id)
        if (nsgNid) {
          await writeStructuralEdge(write, {
            from: subNid, to: nsgNid, via: 'nsg', source,
            evidence: `ARG: subnet→nsg ${evidenceDetail}`.trim(),
          }).then(n => { if (n) stats.edges++ })
        }
      }
      if (subnet.properties?.routeTable?.id) {
        const rtNid = resolve(subnet.properties.routeTable.id)
        if (rtNid) {
          await writeStructuralEdge(write, {
            from: subNid, to: rtNid, via: 'route-table', source,
            evidence: `ARG: subnet→route-table ${evidenceDetail}`.trim(),
          }).then(n => { if (n) stats.edges++ })
        }
      }
    }
  }

  // App Service → App Service Plan, → VNet integration subnet, → App Insights
  if (type === 'microsoft.web/sites') {
    if (p.serverFarmId)             await link('app-service-plan',   p.serverFarmId)
    if (p.virtualNetworkSubnetId)   await link('vnet-integration',   p.virtualNetworkSubnetId)
    if (p.appInsightsInstrumentationKey) {
      await link('app-insights', p.appInsightsInstrumentationKey)
    }
  }

  // AKS → node subnet
  if (type === 'microsoft.containerservice/managedclusters') {
    const nodeSubnet = p.agentPoolProfiles?.[0]?.vnetSubnetID
    if (nodeSubnet) await link('aks-node-subnet', nodeSubnet)
  }

  // SQL database → parent SQL server (derived from ARM id)
  if (type === 'microsoft.sql/servers/databases') {
    const parts = (res.id || '').split('/')
    // .../servers/<server-name>/databases/<db-name> → strip last two segments
    if (parts.length > 2) {
      await link('sql-server', parts.slice(0, -2).join('/'))
    }
  }

  // Redis → Subnet (VNet injection)
  if (type === 'microsoft.cache/redis') {
    if (p.subnetId) await link('redis-vnet-injection', p.subnetId)
  }

  // Service Bus / Event Hub → private endpoint
  if (
    type === 'microsoft.servicebus/namespaces' ||
    type === 'microsoft.eventhub/namespaces'
  ) {
    for (const pe of p.privateEndpointConnections || []) {
      if (pe.properties?.privateEndpoint?.id) {
        await link('private-endpoint', pe.properties.privateEndpoint.id)
      }
    }
  }

  // App Insights → monitored application (points to the app/function it monitors)
  if (type === 'microsoft.insights/components') {
    if (p.Application_Type && p.ApplicationId) {
      await link('monitors', p.ApplicationId)
    }
  }

  // Key Vault → VNet rule subnets
  if (type === 'microsoft.keyvault/vaults') {
    for (const rule of p.networkAcls?.virtualNetworkRules || []) {
      if (rule.id) await link('keyvault-vnet-rule', rule.id)
    }
  }

  // Load Balancer → backend NICs
  if (type === 'microsoft.network/loadbalancers') {
    for (const pool of p.backendAddressPools || []) {
      for (const cfg of pool.properties?.backendIPConfigurations || []) {
        // cfg.id is a NIC ip-config id — parent NIC = strip last 2 segments
        const nicId = cfg.id?.split('/').slice(0, -2).join('/')
        if (nicId) await link('lb-backend-nic', nicId)
      }
    }
  }

  // Application Gateway → GW subnet
  if (type === 'microsoft.network/applicationgateways') {
    const subId = p.gatewayIPConfigurations?.[0]?.properties?.subnet?.id
    if (subId) await link('agw-subnet', subId)
  }
}

// ─── ARG pagination ───────────────────────────────────────────────────────────

async function fetchAllResources(client, subId, log, stats) {
  const all = []
  let skipToken = undefined
  let page = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res
    try {
      res = await client.resources(
        { subscriptions: [subId], query: ARG_QUERY },
        { resultFormat: 'objectArray', top: ARG_PAGE_SIZE, skipToken },
      )
    } catch (err) {
      stats.errors.push(`ARG query page ${page}: ${err.message}`)
      log.warn?.(`[Azure Scanner] ARG page ${page} failed: ${err.message}`)
      break
    }
    const rows = res.data || []
    all.push(...rows)
    page++
    skipToken = res.$skipToken || res.skipToken
    if (!skipToken) break
  }
  log.info?.(`[Azure Scanner] ARG pages: ${page}, rows: ${all.length}`)
  return all
}

// ─── Azure credential builder ────────────────────────────────────────────────
// Mirrors discovery.js::azureCredential so the scanner can be invoked with
// the same { credentials, subscriptionId, ... } shape as the old scanAzure.

async function buildCredential(credentials, subId, log) {
  const { DefaultAzureCredential, ClientSecretCredential } = await import('@azure/identity')
  if (credentials?.clientId && credentials?.clientSecret) {
    let tenantId = credentials.tenantId
    if (!tenantId && subId) {
      try {
        const metaRes = await fetch(
          `https://management.azure.com/subscriptions/${subId}?api-version=2022-12-01`
        )
        const wwwAuth = metaRes.headers.get('www-authenticate') || ''
        const m = wwwAuth.match(/authorization_uri="[^"]*\/([0-9a-f-]{36})/)
        if (m) {
          tenantId = m[1]
          log.info?.(`[Azure] Resolved tenantId: ${tenantId}`)
        }
      } catch (e) {
        log.warn?.(`[Azure] Could not auto-resolve tenantId: ${e.message}`)
      }
    }
    if (!tenantId) {
      throw new Error(
        'tenantId is required for Azure service principal authentication. ' +
        'Add it to your Azure account configuration in Integrations.'
      )
    }
    return new ClientSecretCredential(tenantId, credentials.clientId, credentials.clientSecret)
  }
  return new DefaultAzureCredential()
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * scanAzure({ credentials, subscriptionId, write, log, scanEpoch })
 *
 * Drop-in replacement for the old SDK-per-type scanner. Returns a stats
 * object with the same shape so orchestration response totaling keeps
 * working:
 *   { vms, aks, sql, appService, functionApp, redis, vnet, <type>Count…,
 *     edges, errors, skipped, scanEpoch }
 *
 * `edges` — total structural :CONNECTS_TO edges emitted by the scanner.
 */
export async function scanAzure({ credentials, subscriptionId, write, log, scanEpoch }) {
  scanEpoch = scanEpoch || Date.now()
  const subId = subscriptionId || process.env.AZURE_SUBSCRIPTION_ID
  if (!subId) throw new Error('subscriptionId is required for Azure discovery')

  const cred = await buildCredential(credentials, subId, log)

  const { ResourceGraphClient } = await import('@azure/arm-resourcegraph')
  const client = new ResourceGraphClient(cred)

  const stats = {
    vms: 0, aks: 0, sql: 0, appService: 0, functionApp: 0,
    redis: 0, vnet: 0,
    edges: 0, errors: [], skipped: [], scanEpoch,
  }

  // ── Pass 1: page through all resources ────────────────────────────────
  const allRows = await fetchAllResources(client, subId, log, stats)

  // ── Pass 2: upsert every recognised resource; build cid → nodeId map ──
  const cidToNid = {}
  for (const res of allRows) {
    const armType = (res.type || '').toLowerCase()
    const resourceType = classifyResourceType(armType, res.kind)
    if (!resourceType) {
      stats.skipped.push(`unmapped type: ${armType}`)
      continue
    }

    const p = res.properties || {}
    try {
      const nodeId = await upsertInfra(write, {
        cloudId:      res.id,
        name:         res.name,
        provider:     'azure',
        resourceType,
        region:       res.location || 'global',
        status:       extractStatus(p),
        public:       extractPublic(resourceType, p, res),
        tags:         res.tags || {},
        raw:          extractRaw(resourceType, res),
        scanEpoch,
      })
      if (nodeId) cidToNid[normId(res.id)] = nodeId

      const key = statsKeyFor(resourceType)
      stats[key] = (stats[key] || 0) + 1
    } catch (err) {
      stats.errors.push(`upsert ${res.id}: ${err.message}`)
    }
  }

  // ── Pass 3: emit structural edges (in-memory resolve, no DB round-trip) ─
  const resolve = (armId) => armId ? cidToNid[normId(armId)] : undefined
  for (const res of allRows) {
    try {
      await emitStructuralEdges({ res, resolve, write, stats })
    } catch (err) {
      stats.errors.push(`edge ${res.id}: ${err.message}`)
    }
  }

  log.info?.(
    `[Azure Scanner] Complete — nodes: ${
      Object.entries(stats)
        .filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k))
        .reduce((s, [,v]) => s + (typeof v === 'number' ? v : 0), 0)
    }, edges: ${stats.edges}, errors: ${stats.errors.length}`
  )

  return stats
}

// Internal exports for tests.
export const __test__ = {
  ARM_TYPE_MAP,
  VIA_TO_CONFIDENCE,
  ARG_QUERY,
  classifyResourceType,
  extractStatus,
  extractPublic,
  extractRaw,
  statsKeyFor,
  emitStructuralEdges,
  writeStructuralEdge,
}
