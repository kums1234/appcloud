/**
 * discovery.azure.supplement.js
 *
 * High-fidelity Azure discovery supplements — optional layers that
 * surface signals Azure Resource Graph cannot express. Runs on top of
 * the graph populated by the primary ARG scanner
 * (`discovery.azure.js`).
 *
 *   Layer B — Network Watcher topology (per-VNet, region-scoped)
 *     Calls getTopology() for each VNet. Returns Contains/Associated
 *     links exactly as Azure models them. Requires Network Watcher +
 *     Reader role.
 *
 *   Layer C — VM Insights / Log Analytics (observed TCP connections)
 *     Queries the VMConnection table. Records actual TCP flows seen
 *     by the Dependency Agent. Only runs when
 *     logAnalyticsWorkspaceId is configured.
 *
 *   Phase 2 — Auto-link (Component → Infra ownership)
 *     Uses the structural graph written by the scanner + supplements
 *     plus Resource Group co-location to infer which Component owns
 *     each Infra node.
 *
 * Edge-write policy: single `:CONNECTS_TO` edge per logical
 * relationship.
 *   • Supplement-layer structural edges carry `source` like
 *     'azure-network-watcher' / 'azure-vm-insights', plus `via`,
 *     `confidence`, `evidence`.
 *   • Auto-link edges (Component → Infra) use `via='component-mapping'`,
 *     `source='auto-link'`, `provider_source='azure-enrichment'`.
 *   • No typed relationships.
 *
 * Layer A (ARG-derived structural edges) used to live here; it moved
 * into the primary scanner in slice 1 of the discovery-native-graph
 * refactor and is no longer re-run post-scan.
 */

// ─── helpers ──────────────────────────────────────────────────────────────────

// Exported so utils/cloud-rollup.js can produce a single source of truth
// for "this resource lives in resource group X" — same parsing the
// autolink co-location bucket already uses.
export function rgFromId(id = '') {
  const parts = id.split('/')
  const idx   = parts.findIndex(p => p.toLowerCase() === 'resourcegroups')
  return idx !== -1 ? parts[idx + 1].toLowerCase() : ''
}

function normId(id = '') {
  return id.toLowerCase().replace(/\/$/, '')
}

// ─── Edge writer (single :CONNECTS_TO write per logical edge) ────────────────

async function writeObservedEdge(write, { from, to, via, source, evidence, extraProps = {} }) {
  if (!from || !to || from === to) return 0
  const confidence = viaConfidence(via)
  // CLAUDE.md edge contract — every :CONNECTS_TO needs source / via /
  // confidence / evidence. Default the evidence string when callers
  // don't supply one (older callers assumed the supplement-layer
  // source string carried the context).
  const evidenceStr = evidence || `Azure supplement: ${via} (${source})`
  const params = { from, to, via, source, confidence, evidence: evidenceStr, ...extraProps }
  const extraSetFragment = Object.keys(extraProps).length
    ? ', ' + Object.keys(extraProps).map(k => `r.${k} = $${k}`).join(', ')
    : ''
  try {
    await write(`
      MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
      MERGE (a)-[r:CONNECTS_TO {via: $via}]->(b)
      ON CREATE SET r.discovered_at = datetime(),
                    r.source        = $source,
                    r.confidence    = $confidence,
                    r.evidence      = $evidence
                    ${extraSetFragment}
      ON MATCH  SET r.last_seen     = datetime(),
                    r.source        = $source,
                    r.confidence    = $confidence,
                    r.evidence      = $evidence
                    ${extraSetFragment}
    `, params)
    return 1
  } catch {
    return 0
  }
}

function viaConfidence(via) {
  // Supplement-layer `via` values — stays in sync with VIA_TO_CONFIDENCE
  // in discovery.azure.js for overlapping keys.
  const table = {
    'contains':     70,
    'associated':   60,
    'observed-tcp': 75,
  }
  return table[via] ?? 60
}

// ─── Layer B: Network Watcher topology ────────────────────────────────────────

async function discoverFromNetworkWatcher({ cred, subId, write, query, log }) {
  const { NetworkManagementClient } = await import('@azure/arm-network')
  const network = new NetworkManagementClient(cred, subId)
  const stats   = { topologies: 0, relationships: 0, errors: [] }

  const infraRows = await query(`
    MATCH (i:Infra) WHERE i.provider = 'azure' AND i.cloud_id IS NOT NULL
    RETURN i.cloud_id AS cid, i.id AS nid, i.resource_type AS rtype, i.raw AS raw
  `)
  const cidToNid = {}
  const vnetList = []
  for (const r of infraRows) {
    const cid = r.get('cid')
    if (!cid) continue
    cidToNid[normId(cid)] = r.get('nid')
    if (r.get('rtype') === 'vnet') {
      let raw = {}
      try { raw = JSON.parse(r.get('raw') || '{}') } catch {}
      vnetList.push({
        nodeId:        r.get('nid'),
        cloudId:       cid,
        resourceGroup: rgFromId(cid),
        region:        (raw.region || '').toLowerCase(),
      })
    }
  }
  if (!vnetList.length) return stats

  let watchers = []
  try {
    for await (const w of network.networkWatchers.listAll()) {
      watchers.push({
        name:          w.name,
        resourceGroup: rgFromId(w.id),
        location:      (w.location || '').toLowerCase(),
      })
    }
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
        { targetResourceGroupName: vnet.resourceGroup },
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
        const n = await writeObservedEdge(write, {
          from: fromNid, to: toNid, via,
          source: 'azure-network-watcher',
          extraProps: {
            evidence: `NetworkWatcher: ${via} (${vnet.resourceGroup})`,
          },
        })
        if (n) stats.relationships++
      }
    }
  }

  log.info?.(`[Azure Supplement] Network Watcher: ${stats.topologies} topologies, ${stats.relationships} relationships`)
  return stats
}

// ─── Layer C: VM Insights observed connections ───────────────────────────────

async function discoverFromVMInsights({ cred, workspaceId, write, query, log }) {
  const { LogsQueryClient } = await import('@azure/monitor-query')
  const stats = { connections: 0, matched: 0, errors: [] }
  if (!workspaceId) return stats

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

  log.info?.(`[Azure Supplement] VM Insights: ${rows.length} connection rows`)

  for (const [sourceIp, destIp, processName,, connectionCount, ports] of rows) {
    stats.connections++
    const fromNid = ipToNid[sourceIp]
    const toNid   = ipToNid[destIp]
    if (!fromNid || !toNid || fromNid === toNid) continue
    const connectionCountNum =
      typeof connectionCount === 'object'
        ? connectionCount.toNumber?.() ?? 0
        : connectionCount ?? 0
    const n = await writeObservedEdge(write, {
      from: fromNid, to: toNid, via: 'observed-tcp',
      source: 'azure-vm-insights',
      extraProps: {
        connection_count: connectionCountNum,
        ports:            JSON.stringify(ports || []),
        process:          processName || '',
        evidence:         `VMInsights: ${connectionCountNum} outbound conn(s)`,
      },
    })
    if (n) stats.matched++
  }

  log.info?.(`[Azure Supplement] VM Insights: ${stats.matched}/${stats.connections} matched`)
  return stats
}

// ─── Phase 2: Auto-link via structural signals ───────────────────────────────
// Delegates to the cross-cloud helper in discovery.autolink.js.
// Azure-specific config: provider='azure', co-location bucket =
// resource-group derived from ARM id, via→score table from
// AZURE_VIA_TO_AUTOLINK_SCORE.

import { autoLinkFromStructure as sharedAutoLink, AZURE_VIA_TO_AUTOLINK_SCORE } from './discovery.autolink.js'

async function autoLinkFromStructure({ write, query, log, minScore = 60 }) {
  return sharedAutoLink({
    provider:              'azure',
    coLocationFromCloudId: rgFromId,
    coLocationLabel:       'resource-group',
    viaToScore:            AZURE_VIA_TO_AUTOLINK_SCORE,
    enrichmentSource:      'azure-enrichment',
    write, query, log, minScore,
  })
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * supplementAzureDiscovery(opts)
 *
 * Runs high-fidelity supplement layers and optional auto-link on top of
 * the graph populated by the primary ARG scanner.
 *
 * opts:
 *   cred        — Azure credential
 *   subId       — Azure subscription id
 *   write       — Neo4j write fn
 *   query       — Neo4j query fn
 *   log         — Fastify logger
 *   workspaceId — (optional) Log Analytics workspace resource id for VM Insights
 *   layers      — (optional) ['network-watcher','vm-insights'] — default []
 *   autoLink    — (optional) boolean, default true
 *   minScore    — (optional) number 0–100, default 60 — auto-link threshold
 *
 * Note: the legacy `resource-graph` layer is no longer a supplement; the
 * primary `scanAzure` emits those structural edges. Passing
 * `layers: ['resource-graph']` is accepted for back-compat and silently
 * skipped — callers should update to omit it.
 */
export async function supplementAzureDiscovery({
  cred,
  subId,
  write,
  query,
  log,
  workspaceId,
  layers   = [],
  autoLink = true,
  minScore = 60,
}) {
  log.info?.(`[Azure Supplement] Starting for subscription ${subId}, layers: ${layers.join(', ') || 'none'}, autoLink: ${autoLink}`)

  const results = {
    networkWatcher:     null,
    vmInsights:         null,
    autoLink:           null,
    totalRelationships: 0,
    totalLinked:        0,
    errors:             [],
  }

  if (layers.includes('resource-graph')) {
    log.warn?.('[Azure Supplement] layer "resource-graph" is deprecated — already emitted by scanAzure; ignoring')
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

  if (autoLink) {
    try {
      results.autoLink = await autoLinkFromStructure({ write, query, log, minScore })
      results.totalLinked = results.autoLink.linked
      results.errors.push(...(results.autoLink.errors || []))
    } catch (err) {
      results.errors.push(`auto-link: ${err.message}`)
    }
  }

  log.info?.(`[Azure Supplement] Complete — relationships: ${results.totalRelationships}, auto-linked: ${results.totalLinked}`)
  return results
}

// Internal exports for tests.
export const __test__ = {
  rgFromId,
  normId,
  writeObservedEdge,
  viaConfidence,
  autoLinkFromStructure,
}
