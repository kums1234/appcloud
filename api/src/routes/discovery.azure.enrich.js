/**
 * discovery.azure.enrich.js
 *
 * Two-phase Azure enrichment for blast-radius analysis:
 *
 * ─── Phase 1: Structural relationship discovery ──────────────────────────────
 * Discovers real Azure infrastructure relationships using three signal layers,
 * writing :CONNECTED_TO edges between Infra nodes in Neo4j. Each edge carries
 * a `via` property describing the relationship type (e.g. 'nic', 'subnet',
 * 'vnet-integration', 'observed-tcp') and a `source` property recording which
 * layer discovered it.
 *
 *   Layer A — Resource Graph (structural, ARM property-based)
 *     VM → NIC → Subnet → VNet, App Service → App Plan / VNet integration,
 *     AKS → subnet, SQL DB → SQL Server, Redis → subnet, NSG associations.
 *     Single batch KQL query. Requires Reader role only.
 *
 *   Layer B — Network Watcher topology (per-VNet, region-scoped)
 *     Calls getTopology() for each VNet. Returns Contains/Associated links
 *     exactly as Azure models them. Requires Network Watcher + Reader on it.
 *
 *   Layer C — VM Insights / Log Analytics (observed TCP connections)
 *     Queries VMConnection table. Records actual TCP flows seen by the
 *     Dependency Agent. Only runs when logAnalyticsWorkspaceId is configured.
 *
 * ─── Phase 2: Auto-linking (DEPLOYED_ON edge creation) ──────────────────────
 * Uses the :CONNECTED_TO graph written in Phase 1 to infer Component→Infra
 * ownership. For each unmapped Infra node, walks its neighbourhood:
 *
 *   Rule 1 — Shared Resource Group
 *     All Infra nodes in the same Azure Resource Group that already have a
 *     Component are candidates for the same Component.  If the group has a
 *     single dominant Component (>50% of already-mapped nodes), the unmapped
 *     nodes are linked to it automatically.
 *
 *   Rule 2 — Direct structural connection
 *     If an unmapped Infra node has a :CONNECTED_TO edge to an Infra node that
 *     IS already mapped to a Component, it is a strong signal that they belong
 *     to the same Component (e.g. a NIC connected to a mapped VM → same service).
 *
 *   Rule 3 — Network neighbourhood (2-hop)
 *     Extends Rule 2 up to 2 hops: unmapped node → connected → mapped.
 *     Lower confidence; only applied when Rule 1 and Rule 2 produce no match.
 *
 * Rules are scored and only applied when confidence is above the configured
 * minScore threshold (default 60). Results are returned so the caller can
 * decide whether to auto-apply or surface them as suggestions.
 */

import { getTypedRel } from './discovery.schema.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

function rgFromId(id = '') {
  const parts = id.split('/')
  const idx   = parts.findIndex(p => p.toLowerCase() === 'resourcegroups')
  return idx !== -1 ? parts[idx + 1].toLowerCase() : ''
}

function normId(id = '') {
  return id.toLowerCase().replace(/\/$/, '')
}

// ─── Phase 1 Layer A: Resource Graph structural links ─────────────────────────

async function discoverFromResourceGraph({ cred, subId, write, query, log }) {
  const { ResourceGraphClient } = await import('@azure/arm-resourcegraph')
  const client = new ResourceGraphClient(cred)
  const stats  = { relationships: 0, errors: [] }

  // Batch fetch all dependency-bearing resource types in one query
  let resources
  try {
    const res = await client.resources({
      subscriptions: [subId],
      query: `
        Resources
        | where subscriptionId =~ '${subId}'
        | where type in~ (
            'microsoft.compute/virtualmachines',
            'microsoft.network/networkinterfaces',
            'microsoft.network/virtualnetworks',
            'microsoft.network/networksecuritygroups',
            'microsoft.network/applicationgateways',
            'microsoft.network/loadbalancers',
            'microsoft.web/sites',
            'microsoft.web/serverfarms',
            'microsoft.containerservice/managedclusters',
            'microsoft.sql/servers/databases',
            'microsoft.sql/servers',
            'microsoft.cache/redis',
            'microsoft.servicebus/namespaces',
            'microsoft.eventhub/namespaces',
            'microsoft.insights/components',
            'microsoft.storage/storageaccounts',
            'microsoft.keyvault/vaults'
          )
        | project id, name, type, resourceGroup, subscriptionId, properties
      `,
    })
    resources = res.data || []
  } catch (err) {
    stats.errors.push(`ResourceGraph query failed: ${err.message}`)
    return stats
  }

  log.info(`[Azure Enrich] Resource Graph: ${resources.length} resources`)

  // Build cloud_id → Neo4j node id lookup
  const infraRows = await query(`
    MATCH (i:Infra) WHERE i.provider = 'azure' AND i.cloud_id IS NOT NULL
    RETURN i.cloud_id AS cid, i.id AS nid
  `)
  const cidToNid = {}
  for (const r of infraRows) {
    const cid = r.get('cid')
    if (cid) cidToNid[normId(cid)] = r.get('nid')
  }

  const resolve = (armId) => armId ? cidToNid[normId(armId)] : undefined

  async function link(fromNid, toNid, via, source = 'azure-resource-graph') {
    if (!fromNid || !toNid || fromNid === toNid) return
    try {
      // Legacy CONNECTED_TO edge (backward compat)
      await write(`
        MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
        MERGE (a)-[r:CONNECTED_TO {via: $via}]->(b)
        ON CREATE SET r.discovered_at = datetime(), r.source = $source
        ON MATCH  SET r.last_seen = datetime()
      `, { from: fromNid, to: toNid, via, source })

      // Typed relationship (dual-write)
      const typedRel = getTypedRel(via)
      if (typedRel) {
        await write(`
          MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
          MERGE (a)-[r:${typedRel} {via: $via}]->(b)
          ON CREATE SET r.discovered_at = datetime(), r.source = $source
          ON MATCH  SET r.last_seen = datetime()
        `, { from: fromNid, to: toNid, via, source }).catch(() => {})
      }

      stats.relationships++
    } catch (err) {
      stats.errors.push(`link ${fromNid}→${toNid}: ${err.message}`)
    }
  }

  for (const res of resources) {
    const fromNid = resolve(res.id)
    if (!fromNid) continue
    const p    = res.properties || {}
    const type = (res.type || '').toLowerCase()

    // VM → NIC
    if (type === 'microsoft.compute/virtualmachines') {
      for (const nic of p.networkProfile?.networkInterfaces || [])
        await link(fromNid, resolve(nic.id), 'nic')
      // VM → managed disks
      for (const disk of p.storageProfile?.dataDisks || [])
        if (disk.managedDisk?.id) await link(fromNid, resolve(disk.managedDisk.id), 'disk')
    }

    // NIC → Subnet, NIC → NSG, NIC → Public IP
    if (type === 'microsoft.network/networkinterfaces') {
      for (const cfg of p.ipConfigurations || []) {
        await link(fromNid, resolve(cfg.properties?.subnet?.id), 'subnet')
        if (cfg.properties?.publicIPAddress?.id)
          await link(fromNid, resolve(cfg.properties.publicIPAddress.id), 'public-ip')
      }
      if (p.networkSecurityGroup?.id)
        await link(fromNid, resolve(p.networkSecurityGroup.id), 'nsg')
    }

    // VNet → subnets (reverse: subnet → vnet) and subnet → NSG
    if (type === 'microsoft.network/virtualnetworks') {
      for (const subnet of p.subnets || []) {
        const subNid = resolve(subnet.id)
        if (subNid) {
          await link(subNid, fromNid, 'vnet')
          if (subnet.properties?.networkSecurityGroup?.id)
            await link(subNid, resolve(subnet.properties.networkSecurityGroup.id), 'nsg')
          if (subnet.properties?.routeTable?.id)
            await link(subNid, resolve(subnet.properties.routeTable.id), 'route-table')
        }
      }
    }

    // App Service → App Service Plan + VNet integration + App Insights
    if (type === 'microsoft.web/sites') {
      if (p.serverFarmId)
        await link(fromNid, resolve(p.serverFarmId), 'app-service-plan')
      if (p.virtualNetworkSubnetId)
        await link(fromNid, resolve(p.virtualNetworkSubnetId), 'vnet-integration')
      // App Insights instrumentation key is stored on the site's app settings;
      // the resource link is surfaced via the siteProperties.appInsightsKey id
      if (p.appInsightsInstrumentationKey)
        await link(fromNid, resolve(p.appInsightsInstrumentationKey), 'app-insights')
    }

    // AKS → node subnet + load balancer subnet
    if (type === 'microsoft.containerservice/managedclusters') {
      const vnetSubnetId = p.agentPoolProfiles?.[0]?.vnetSubnetID
      if (vnetSubnetId) await link(fromNid, resolve(vnetSubnetId), 'aks-node-subnet')
      const lbSubnetId  = p.networkProfile?.loadBalancerProfile?.managedOutboundIPs
      // AKS outbound IPs are not direct resource ids; skip — covered by network watcher
    }

    // SQL DB → SQL Server (parent = db id minus last 2 segments)
    if (type === 'microsoft.sql/servers/databases') {
      const serverArmId = res.id.split('/').slice(0, -2).join('/')
      await link(fromNid, resolve(serverArmId), 'sql-server')
    }

    // Redis → Subnet (VNet injection)
    if (type === 'microsoft.cache/redis') {
      if (p.subnetId) await link(fromNid, resolve(p.subnetId), 'redis-vnet-injection')
    }

    // Service Bus / Event Hub → no direct subnet but may have private endpoint
    if (type === 'microsoft.servicebus/namespaces' ||
        type === 'microsoft.eventhub/namespaces') {
      for (const pe of p.privateEndpointConnections || []) {
        if (pe.properties?.privateEndpoint?.id)
          await link(fromNid, resolve(pe.properties.privateEndpoint.id), 'private-endpoint')
      }
    }

    // App Insights → target resource (points to the app/function it monitors)
    if (type === 'microsoft.insights/components') {
      if (p.Application_Type && p.ApplicationId)
        await link(fromNid, resolve(p.ApplicationId), 'monitors')
    }

    // Key Vault — link to subnets in network ACLs
    if (type === 'microsoft.keyvault/vaults') {
      for (const vnetRule of p.networkAcls?.virtualNetworkRules || []) {
        if (vnetRule.id) await link(fromNid, resolve(vnetRule.id), 'keyvault-vnet-rule')
      }
    }

    // Load Balancer → backend pool NICs / VMs
    if (type === 'microsoft.network/loadbalancers') {
      for (const pool of p.backendAddressPools || []) {
        for (const cfg of pool.properties?.backendIPConfigurations || []) {
          // cfg.id is a NIC ip-config id; parent NIC = strip last 2 segments
          const nicArmId = cfg.id?.split('/').slice(0, -2).join('/')
          if (nicArmId) await link(fromNid, resolve(nicArmId), 'lb-backend-nic')
        }
      }
    }

    // Application Gateway → backend pools (VMs / App Services by FQDN/IP are harder;
    // but backend address pools that reference NICs are structured)
    if (type === 'microsoft.network/applicationgateways') {
      if (p.gatewayIPConfigurations?.[0]?.properties?.subnet?.id)
        await link(fromNid, resolve(p.gatewayIPConfigurations[0].properties.subnet.id), 'agw-subnet')
    }
  }

  log.info(`[Azure Enrich] Resource Graph: ${stats.relationships} relationships`)
  return stats
}

// ─── Phase 1 Layer B: Network Watcher topology ────────────────────────────────

async function discoverFromNetworkWatcher({ cred, subId, write, query, log }) {
  const { NetworkManagementClient } = await import('@azure/arm-network')
  const network = new NetworkManagementClient(cred, subId)
  const stats   = { topologies: 0, relationships: 0, errors: [] }

  // Build cloud_id → node id, collect VNets
  const infraRows = await query(`
    MATCH (i:Infra) WHERE i.provider = 'azure' AND i.cloud_id IS NOT NULL
    RETURN i.cloud_id AS cid, i.id AS nid, i.resource_type AS rtype, i.raw AS raw
  `)
  const cidToNid = {}
  const vnetList  = []
  for (const r of infraRows) {
    const cid = r.get('cid')
    if (!cid) continue
    cidToNid[normId(cid)] = r.get('nid')
    if (r.get('rtype') === 'vnet') {
      let raw = {}
      try { raw = JSON.parse(r.get('raw') || '{}') } catch {}
      vnetList.push({ nodeId: r.get('nid'), cloudId: cid, resourceGroup: rgFromId(cid), region: (raw.region || '').toLowerCase() })
    }
  }

  if (!vnetList.length) return stats

  let watchers = []
  try {
    for await (const w of network.networkWatchers.listAll())
      watchers.push({ name: w.name, resourceGroup: rgFromId(w.id), location: w.location.toLowerCase() })
  } catch (err) {
    stats.errors.push(`List NetworkWatchers: ${err.message}`)
    return stats
  }

  for (const vnet of vnetList) {
    const watcher = watchers.find(w => w.location === vnet.region)
    if (!watcher) continue
    let topology
    try {
      topology = await network.networkWatchers.getTopology(
        watcher.resourceGroup, watcher.name,
        { targetResourceGroupName: vnet.resourceGroup }
      )
      stats.topologies++
    } catch (err) {
      stats.errors.push(`GetTopology(${vnet.resourceGroup}): ${err.message}`)
      continue
    }
    for (const res of topology.resources || []) {
      const fromNid = cidToNid[normId(res.id)]
      if (!fromNid) continue
      for (const assoc of res.associations || []) {
        const toNid = cidToNid[normId(assoc.resourceId)]
        if (!toNid || toNid === fromNid) continue
        const via = (assoc.associationType || 'associated').toLowerCase()
        try {
          // Legacy CONNECTED_TO
          await write(`
            MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
            MERGE (a)-[r:CONNECTED_TO {via: $via}]->(b)
            ON CREATE SET r.discovered_at = datetime(), r.source = 'azure-network-watcher'
            ON MATCH  SET r.last_seen = datetime()
          `, { from: fromNid, to: toNid, via })
          // Typed relationship (dual-write)
          const typedRel = getTypedRel(via)
          if (typedRel) {
            await write(`
              MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
              MERGE (a)-[r:${typedRel} {via: $via}]->(b)
              ON CREATE SET r.discovered_at = datetime(), r.source = 'azure-network-watcher'
              ON MATCH  SET r.last_seen = datetime()
            `, { from: fromNid, to: toNid, via }).catch(() => {})
          }
          stats.relationships++
        } catch (err) {
          stats.errors.push(`topology link: ${err.message}`)
        }
      }
    }
  }

  log.info(`[Azure Enrich] Network Watcher: ${stats.topologies} topologies, ${stats.relationships} relationships`)
  return stats
}

// ─── Phase 1 Layer C: VM Insights observed connections ───────────────────────

async function discoverFromVMInsights({ cred, workspaceId, write, query, log }) {
  const { LogsQueryClient } = await import('@azure/monitor-query')
  const stats = { connections: 0, matched: 0, errors: [] }

  if (!workspaceId) return stats

  // Build IP → node id from stored raw.privateIp / raw.publicIp
  const infraRows = await query(`
    MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'vm'
    RETURN i.id AS nid, i.raw AS raw
  `)
  const ipToNid = {}
  for (const r of infraRows) {
    let raw = {}
    try { raw = JSON.parse(r.get('raw') || '{}') } catch {}
    if (raw.privateIp) ipToNid[raw.privateIp] = r.get('nid')
    if (raw.publicIp)  ipToNid[raw.publicIp]  = r.get('nid')
  }

  const logsClient = new LogsQueryClient(cred)
  let rows = []
  try {
    const result = await logsClient.queryWorkspace(workspaceId, `
      VMConnection
      | where TimeGenerated > ago(1h)
      | where Direction == "outbound"
      | summarize
          ConnectionCount = count(),
          Ports           = make_set(DestinationPort, 20)
        by SourceIp, DestinationIp, ProcessName, Computer
      | order by ConnectionCount desc
      | limit 5000
    `, { duration: 'PT1H' })
    rows = result.tables?.[0]?.rows || []
  } catch (err) {
    stats.errors.push(`Log Analytics query: ${err.message}`)
    return stats
  }

  log.info(`[Azure Enrich] VM Insights: ${rows.length} connection rows`)

  for (const [sourceIp, destIp, processName,, connectionCount, ports] of rows) {
    stats.connections++
    const fromNid = ipToNid[sourceIp]
    const toNid   = ipToNid[destIp]
    if (!fromNid || !toNid || fromNid === toNid) continue
    try {
      const params = {
        from:    fromNid,
        to:      toNid,
        count:   typeof connectionCount === 'object' ? connectionCount.toNumber?.() ?? 0 : connectionCount ?? 0,
        ports:   JSON.stringify(ports || []),
        process: processName || '',
      }
      // Legacy CONNECTED_TO
      await write(`
        MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
        MERGE (a)-[r:CONNECTED_TO {via: 'observed-tcp'}]->(b)
        ON CREATE SET r.discovered_at = datetime(), r.source = 'azure-vm-insights'
        SET r.last_seen = datetime(),
            r.connection_count = $count,
            r.ports   = $ports,
            r.process = $process
      `, params)
      // Typed relationship (dual-write)
      await write(`
        MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
        MERGE (a)-[r:OBSERVED_CONNECTION {via: 'observed-tcp'}]->(b)
        ON CREATE SET r.discovered_at = datetime(), r.source = 'azure-vm-insights'
        SET r.last_seen = datetime(),
            r.connection_count = $count,
            r.ports   = $ports,
            r.process = $process
      `, params).catch(() => {})
      stats.matched++
    } catch (err) {
      stats.errors.push(`vm-insights link: ${err.message}`)
    }
  }

  log.info(`[Azure Enrich] VM Insights: ${stats.matched}/${stats.connections} matched`)
  return stats
}

// ─── Phase 2: Auto-linking via structural signals ─────────────────────────────
//
// Uses the :CONNECTED_TO graph + Resource Group co-location to infer
// Component→Infra ownership and write :DEPLOYED_ON edges automatically.
//
// Returns { linked, suggestions, errors } where:
//   linked      — number of DEPLOYED_ON edges written automatically
//   suggestions — array of lower-confidence candidates for manual review
//   errors      — any write errors

async function autoLinkFromStructure({ write, query, log, minScore = 60 }) {
  const stats = { linked: 0, suggestions: [], errors: [] }

  // ── Load all unmapped Infra nodes (Azure only) ────────────────────────
  const unmappedRows = await query(`
    MATCH (i:Infra)
    WHERE i.provider = 'azure'
      AND i.source = 'discovery'
      AND NOT (:Component)-[:DEPLOYED_ON]->(i)
    RETURN i.id AS infraId, i.name AS name, i.cloud_id AS cloudId,
           i.resource_type AS rtype, i.raw AS raw, i.tags AS tags
  `)

  if (!unmappedRows.length) {
    log.info('[Azure AutoLink] No unmapped Azure infra nodes, skipping')
    return stats
  }

  log.info(`[Azure AutoLink] ${unmappedRows.length} unmapped Azure nodes to process`)

  // ── Build Resource Group → [{ infraId, componentId, componentName }] map ─
  // (for already-mapped infra in the same RG)
  const rgMappedRows = await query(`
    MATCH (c:Component)-[:DEPLOYED_ON]->(i:Infra)
    WHERE i.provider = 'azure' AND i.cloud_id IS NOT NULL
    RETURN i.cloud_id AS cid, c.id AS compId, c.name AS compName,
           i.resource_type AS rtype
  `)
  const rgToMapped  = {}   // resourceGroup → [{ compId, compName, rtype }]
  const infraToComp = {}   // infraId → { compId, compName }
  for (const r of rgMappedRows) {
    const rg = rgFromId(r.get('cid'))
    if (!rg) continue
    if (!rgToMapped[rg]) rgToMapped[rg] = []
    rgToMapped[rg].push({ compId: r.get('compId'), compName: r.get('compName'), rtype: r.get('rtype') })
  }

  // ── For each unmapped node, score candidates ──────────────────────────
  for (const row of unmappedRows) {
    const infraId = row.get('infraId')
    const rtype   = row.get('rtype') || ''
    const cloudId = row.get('cloudId') || ''
    const rg      = rgFromId(cloudId)

    const candidates = []  // { compId, compName, score, rule }

    // ── Rule 1: Resource Group co-location ──────────────────────────────
    // If >50% of already-mapped nodes in this RG share a component, score 70.
    // If all nodes in the RG share a component, score 85.
    if (rg && rgToMapped[rg]?.length) {
      const compFreq = {}
      for (const m of rgToMapped[rg]) {
        compFreq[m.compId] = (compFreq[m.compId] || { count: 0, compName: m.compName })
        compFreq[m.compId].count++
      }
      const total = rgToMapped[rg].length
      for (const [compId, { count, compName }] of Object.entries(compFreq)) {
        const ratio = count / total
        if (ratio >= 1.0) {
          candidates.push({ compId, compName, score: 85, rule: 'resource-group-unanimous', rg })
        } else if (ratio >= 0.5) {
          candidates.push({ compId, compName, score: 70, rule: 'resource-group-majority', rg })
        }
      }
    }

    // ── Rule 2: Direct structural connection (1-hop CONNECTED_TO) ───────
    // If this node is CONNECTED_TO a mapped infra node, they likely belong
    // to the same component. Score depends on the `via` type.
    const directRows = await query(`
      MATCH (unmapped:Infra {id: $infraId})-[r:CONNECTED_TO]-(mapped:Infra)
      WHERE (:Component)-[:DEPLOYED_ON]->(mapped)
      MATCH (c:Component)-[:DEPLOYED_ON]->(mapped)
      RETURN c.id AS compId, c.name AS compName, r.via AS via
      LIMIT 10
    `, { infraId })

    for (const r of directRows) {
      const via = r.get('via') || ''
      // Score by relationship type — tighter coupling = higher score
      const viaScore = {
        'nic':                90,  // NIC is part of the VM — very tight
        'disk':               88,
        'app-service-plan':   85,
        'sql-server':         85,
        'redis-vnet-injection': 82,
        'vnet-integration':   80,
        'aks-node-subnet':    80,
        'lb-backend-nic':     75,
        'agw-subnet':         72,
        'contains':           70,  // Network Watcher Contains
        'subnet':             65,
        'associated':         60,  // Network Watcher Associated (NSG etc.)
        'nsg':                55,
        'private-endpoint':   70,
        'keyvault-vnet-rule': 60,
        'observed-tcp':       75,  // actual observed traffic
        'monitors':           65,
      }[via] ?? 60

      candidates.push({
        compId:   r.get('compId'),
        compName: r.get('compName'),
        score:    viaScore,
        rule:     `direct-${via}`,
      })
    }

    // ── Rule 3: Network neighbourhood (2-hop) ───────────────────────────
    // Only applied if Rules 1 & 2 produced nothing above threshold
    const hasHighConf = candidates.some(c => c.score >= minScore)
    if (!hasHighConf) {
      const hopRows = await query(`
        MATCH (unmapped:Infra {id: $infraId})-[:CONNECTED_TO*1..2]-(mapped:Infra)
        WHERE (:Component)-[:DEPLOYED_ON]->(mapped)
        MATCH (c:Component)-[:DEPLOYED_ON]->(mapped)
        RETURN c.id AS compId, c.name AS compName, count(*) AS paths
        ORDER BY paths DESC
        LIMIT 5
      `, { infraId })

      for (const r of hopRows) {
        const paths = typeof r.get('paths') === 'object'
          ? r.get('paths').toNumber?.() ?? 1 : r.get('paths') ?? 1
        // 2-hop is lower confidence; score by path count (more paths = more signal)
        const score = Math.min(58, 40 + paths * 6)
        candidates.push({
          compId:   r.get('compId'),
          compName: r.get('compName'),
          score,
          rule:     '2-hop-neighbourhood',
        })
      }
    }

    if (!candidates.length) continue

    // De-duplicate: keep highest score per compId
    const deduped = {}
    for (const c of candidates) {
      if (!deduped[c.compId] || c.score > deduped[c.compId].score) {
        deduped[c.compId] = c
      }
    }

    const best = Object.values(deduped).sort((a, b) => b.score - a.score)[0]
    if (!best) continue

    if (best.score >= minScore) {
      // Auto-apply: write the DEPLOYED_ON edge
      try {
        await write(`
          MATCH (c:Component {id: $compId}), (i:Infra {id: $infraId})
          MERGE (c)-[rel:DEPLOYED_ON]->(i)
          ON CREATE SET rel.source    = 'azure-enrichment',
                        rel.rule      = $rule,
                        rel.score     = $score,
                        rel.mappedAt  = datetime()
        `, { compId: best.compId, infraId, rule: best.rule, score: best.score })
        stats.linked++
        log.debug(`[Azure AutoLink] Linked ${infraId} → ${best.compName} (${best.rule}, score ${best.score})`)
      } catch (err) {
        stats.errors.push(`autolink ${infraId}: ${err.message}`)
      }
    } else if (best.score >= 30) {
      // Below threshold but worth surfacing as a suggestion
      stats.suggestions.push({
        infraId,
        name:      row.get('name'),
        rtype,
        compId:    best.compId,
        compName:  best.compName,
        score:     best.score,
        rule:      best.rule,
      })
    }
  }

  log.info(`[Azure AutoLink] Auto-linked: ${stats.linked}, suggestions: ${stats.suggestions.length}`)
  return stats
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * enrichAzureRelationships(opts)
 *
 * opts:
 *   cred              — Azure credential
 *   subId             — Azure subscription id
 *   write             — Neo4j write fn
 *   query             — Neo4j query fn
 *   log               — Fastify logger
 *   workspaceId       — (optional) Log Analytics workspace resource id
 *   layers            — (optional) ['resource-graph','network-watcher','vm-insights']
 *                       defaults to ['resource-graph','network-watcher']
 *   autoLink          — (optional) boolean, default true — run Phase 2 auto-linking
 *   minScore          — (optional) number 0-100, default 60 — auto-link threshold
 *
 * Returns:
 *   { resourceGraph, networkWatcher, vmInsights, autoLink,
 *     totalRelationships, totalLinked, errors }
 */
export async function enrichAzureRelationships({
  cred,
  subId,
  write,
  query,
  log,
  workspaceId,
  layers   = ['resource-graph', 'network-watcher'],
  autoLink = true,
  minScore = 60,
}) {
  log.info(`[Azure Enrich] Starting for subscription ${subId}, layers: ${layers.join(', ')}, autoLink: ${autoLink}`)

  const results = {
    resourceGraph:      null,
    networkWatcher:     null,
    vmInsights:         null,
    autoLink:           null,
    totalRelationships: 0,
    totalLinked:        0,
    errors:             [],
  }

  // ── Phase 1: discover relationships ──────────────────────────────────
  if (layers.includes('resource-graph')) {
    try {
      results.resourceGraph = await discoverFromResourceGraph({ cred, subId, write, query, log })
      results.totalRelationships += results.resourceGraph.relationships
      results.errors.push(...(results.resourceGraph.errors || []))
    } catch (err) {
      results.errors.push(`resource-graph: ${err.message}`)
    }
  }

  if (layers.includes('network-watcher')) {
    try {
      results.networkWatcher = await discoverFromNetworkWatcher({ cred, subId, write, query, log })
      results.totalRelationships += results.networkWatcher.relationships
      results.errors.push(...(results.networkWatcher.errors || []))
    } catch (err) {
      results.errors.push(`network-watcher: ${err.message}`)
    }
  }

  if (layers.includes('vm-insights')) {
    try {
      results.vmInsights = await discoverFromVMInsights({ cred, workspaceId, write, query, log })
      results.totalRelationships += results.vmInsights.matched
      results.errors.push(...(results.vmInsights.errors || []))
    } catch (err) {
      results.errors.push(`vm-insights: ${err.message}`)
    }
  }

  // ── Phase 2: auto-link from discovered structure ──────────────────────
  if (autoLink) {
    try {
      results.autoLink = await autoLinkFromStructure({ write, query, log, minScore })
      results.totalLinked = results.autoLink.linked
      results.errors.push(...(results.autoLink.errors || []))
    } catch (err) {
      results.errors.push(`auto-link: ${err.message}`)
    }
  }

  log.info(`[Azure Enrich] Complete — relationships: ${results.totalRelationships}, auto-linked: ${results.totalLinked}`)
  return results
}