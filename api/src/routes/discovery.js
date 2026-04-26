// routes/discovery.js
// Live cloud discovery for AWS, Azure and GCP.
// Each scanner authenticates using credentials stored per-cloud-account in
// environment variables (or passed per-request for multi-account setups),
// calls the real provider APIs, and MERGE-writes results into Neo4j.
//
// Supported resources:
//   AWS  : EC2, RDS, Lambda, EKS, ECS, ALB/NLB, S3, ElastiCache
//   Azure: VMs, AKS, SQL Servers, App Services, Redis Cache, VNets
//   GCP  : Compute Instances, GKE Clusters, Cloud SQL, Cloud Run
//
// All scanners are lazy-imported so the API starts cleanly even when
// cloud SDKs are not installed (useful during development / local runs).

import { props, serialize } from '../utils/serialize.js'
import { encryptConfig, decryptConfig } from '../utils/encrypt.js'
import { bootstrapDiscovery } from './discovery.bootstrap.js'
import { bootstrapSuggestFallback } from './discovery.suggest.patch.js'
import { startEpisode, finishEpisode } from '../services/episodes.js'
import { runAutoCreateIfEnabled } from '../plugins/scheduler.auto-create.patch.js'
import {
  ScanResponseSchema,
  ScanBreakdownSchema,
  SuggestApplyAllBodySchema,
  StandardErrorResponses,
  IdParamSchema,
  InfraSchema,
} from '../schemas/openapi.js'
import { supplementAzureDiscovery } from './discovery.azure.supplement.js'
import { scanAzure as scanAzureViaResourceGraph } from './discovery.azure.js'
import { scanGCP as scanGCPViaCloudAssetInventory } from './discovery.gcp.js'
import { supplementGCPDiscovery } from './discovery.gcp.supplement.js'
import { scanAWS as scanAWSViaConfigAggregator } from './discovery.aws.js'
import { supplementAWSDiscovery } from './discovery.aws.supplement.js'
import { getLabelsForType, getPromotedFields, buildLabelSetClause, INFRA_ONLY_TYPES, PLATFORM_TYPES, hasExplicitAppTag } from './discovery.schema.js'

// ─── Azure Linking Strategies ────────────────────────────────────────────────
// Ranked from most authoritative (lowest token cost, highest fidelity) to least.
// Name-based heuristics is always last — it is the cheapest but least reliable.

const AZURE_LINKING_STRATEGIES = [
  {
    id:          'resource-graph',
    name:        'Azure Resource Graph',
    rank:        1,
    description: 'Structural ARM property relationships — VM→NIC→Subnet→VNet, App Service→Plan, AKS→subnet, SQL DB→Server. Single batch KQL query, Reader role only.',
    permissions: ['Reader'],
    layers:      ['resource-graph'],
    tokenCost:   'low',
    fidelity:    'high',
  },
  {
    id:          'network-watcher',
    name:        'Network Watcher Topology',
    rank:        2,
    description: 'Per-VNet topology from Azure Network Watcher — Contains/Associated links as Azure models them. Region-scoped, requires Network Watcher resource.',
    permissions: ['Reader', 'Network Watcher access'],
    layers:      ['resource-graph', 'network-watcher'],
    tokenCost:   'low',
    fidelity:    'high',
  },
  {
    id:          'monitor-insights',
    name:        'Azure Monitor Insights & Service Map',
    rank:        3,
    description: 'Observed TCP connections from VM Insights / Log Analytics Dependency Agent. Records actual traffic flows between VMs. Requires Log Analytics workspace + Dependency Agent.',
    permissions: ['Reader', 'Log Analytics Reader'],
    layers:      ['resource-graph', 'network-watcher', 'vm-insights'],
    tokenCost:   'medium',
    fidelity:    'high',
  },
  {
    id:          'tagging',
    name:        'Tagging Strategy',
    rank:        4,
    description: 'Tag-based matching using appcloud:app, component, owner, env, tier tags and Azure Resource Group co-location. No extra API calls — uses tags stored at scan time.',
    permissions: ['Reader'],
    layers:      [],
    tokenCost:   'low',
    fidelity:    'medium',
  },
  {
    id:          'azure-arc',
    name:        'Azure Arc',
    rank:        5,
    description: 'Discovers hybrid and multi-cloud resources projected into Azure via Arc. Surfaces Arc-connected servers, Kubernetes clusters, and data services alongside native Azure resources.',
    permissions: ['Reader', 'Azure Connected Machine Resource Administrator'],
    layers:      ['resource-graph'],
    tokenCost:   'low',
    fidelity:    'medium',
  },
  {
    id:          'name-heuristics',
    name:        'Name-based Heuristics',
    rank:        6,
    description: 'Fallback: infers application and component from resource name keywords (api, worker, db, cache) and first hyphen-segment. Lowest confidence — use only when higher-fidelity strategies are unavailable.',
    permissions: [],
    layers:      [],
    tokenCost:   'lowest',
    fidelity:    'low',
  },
]

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Build an Azure credential from account config */
async function azureCredential(cfg) {
  const { DefaultAzureCredential, ClientSecretCredential } = await import('@azure/identity')
  if (cfg.clientId && cfg.clientSecret) {
    let tenantId = cfg.tenantId
    // Auto-resolve tenantId from subscription metadata if missing
    if (!tenantId && cfg.subscriptionId) {
      try {
        const metaUrl = `https://management.azure.com/subscriptions/${cfg.subscriptionId}?api-version=2022-12-01`
        const metaRes = await fetch(metaUrl)
        const wwwAuth = metaRes.headers.get('www-authenticate') || ''
        const match = wwwAuth.match(/authorization_uri="[^"]*\/([0-9a-f-]{36})/)
        if (match) tenantId = match[1]
      } catch {}
    }
    if (!tenantId) throw new Error('tenantId required for service principal auth')
    return new ClientSecretCredential(tenantId, cfg.clientId, cfg.clientSecret)
  }
  return new DefaultAzureCredential()
}

/** Flatten AWS tags array [{Key,Value}] → plain object */
function awsTags(tags = []) {
  return tags.reduce((o, t) => { o[t.Key] = t.Value; return o }, {})
}

/** Normalise a name: try Name tag, fall back to id */
function awsName(tags = [], fallback = '') {
  return awsTags(tags)['Name'] || fallback
}

/** Pull all pages from an AWS paginator */
async function awsPages(paginator) {
  const all = []
  for await (const page of paginator) all.push(page)
  return all
}

/** Upsert an Infra node into Neo4j — returns the node id.
 *
 *  Schema evolution (additive, backward-compatible):
 *  - firstseen   — epoch ms, set once on creation, never overwritten
 *  - lastupdated — epoch ms, set every scan (drives stale cleanup)
 *  - Typed labels — e.g. :AzureVM:ComputeInstance added alongside :Infra
 *  - Promoted fields — key raw.* values copied to top-level properties
 */
export async function upsertInfra(write, fields) {
  const incomingTagsStr = JSON.stringify(fields.tags || {})
  const scanEpoch       = fields.scanEpoch || Date.now()
  const rawObj          = fields.raw || {}
  const promoted        = getPromotedFields(fields.provider, rawObj)
  const labelClause     = buildLabelSetClause(fields.provider, fields.resourceType)

  // Build promoted-field SET fragments — dynamic property names
  const promotedKeys   = Object.keys(promoted)
  const promotedSet    = promotedKeys.length
    ? ', ' + promotedKeys.map(k => `i.${k} = $prom_${k}`).join(', ')
    : ''
  const promotedParams = {}
  for (const k of promotedKeys) promotedParams[`prom_${k}`] = promoted[k]

  const baseParams = {
    cloudId:      fields.cloudId,
    name:         fields.name        || fields.cloudId,
    provider:     fields.provider,
    resourceType: fields.resourceType,
    region:       fields.region      || '',
    status:       fields.status      || 'unknown',
    public:       fields.public      ?? false,
    tags:         incomingTagsStr,
    raw:          JSON.stringify(rawObj),
    scanEpoch,
    ...promotedParams,
  }

  const records = await write(`
    MERGE (i:Infra { cloud_id: $cloudId })
    SET i.id            = COALESCE(i.id, randomUUID()),
        i.firstseen     = COALESCE(i.firstseen, $scanEpoch),
        i.lastupdated   = $scanEpoch,
        i.name          = $name,
        i.provider      = $provider,
        i.resource_type = $resourceType,
        i.region        = $region,
        i.status        = $status,
        i.public        = $public,
        i.source        = 'discovery',
        i.raw           = $raw,
        i.discovered_at = datetime(),
        i.tags          = CASE
          WHEN i.tags IS NULL OR i.tags = '{}'
          THEN $tags
          ELSE apoc.convert.toJson(
            apoc.map.merge(
              apoc.convert.fromJsonMap(COALESCE(i.tags, '{}')),
              apoc.convert.fromJsonMap($tags)
            )
          )
        END
        ${promotedSet}
    RETURN i.id AS nodeId
  `, baseParams).catch(async () => {
    // Fallback if APOC not available — overwrite tags
    return write(`
      MERGE (i:Infra { cloud_id: $cloudId })
      SET i.id            = COALESCE(i.id, randomUUID()),
          i.firstseen     = COALESCE(i.firstseen, $scanEpoch),
          i.lastupdated   = $scanEpoch,
          i.name          = $name,
          i.provider      = $provider,
          i.resource_type = $resourceType,
          i.region        = $region,
          i.status        = $status,
          i.public        = $public,
          i.source        = 'discovery',
          i.tags          = $tags,
          i.raw           = $raw,
          i.discovered_at = datetime()
          ${promotedSet}
      RETURN i.id AS nodeId
    `, baseParams)
  })

  const nodeId = records[0]?.get('nodeId')

  // Add typed labels (second query — SET i:Label is not parameterisable)
  if (nodeId && labelClause) {
    await write(`
      MATCH (i:Infra {id: $nodeId})
      ${labelClause}
    `, { nodeId }).catch(() => {})  // best-effort — label add is non-critical
  }

  return nodeId
}

/**
 * Remove stale Infra nodes after a scan completes.
 *
 * A node is stale if:
 *  - source = 'discovery' (never touch manual or terraform nodes)
 *  - provider matches the scanned provider
 *  - lastupdated < scanEpoch (not touched during this scan run)
 *
 * Nodes with an owning Component (a :CONNECTS_TO {via:'component-mapping'} edge) are marked stale but NOT deleted
 * (they may still be relevant for mapping review).
 */
async function cleanupStaleNodes(write, query, log, provider, scanEpoch, scanStats = null) {
  const stats = { removed: 0, markedStale: 0, skipped: false, errors: [] }

  // Errored-scan guard. If the scan returned zero recognised resources and
  // accumulated errors, every existing Infra for this provider would look
  // stale (because nothing got a fresh `lastupdated`). Skip cleanup so a
  // single bad-credentials run doesn't mark the whole graph stale.
  if (scanStats) {
    const totalNodes = Object.entries(scanStats)
      .filter(([k]) => !['edges', 'errors', 'skipped', 'scanEpoch'].includes(k))
      .reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0)
    const errorCount = Array.isArray(scanStats.errors) ? scanStats.errors.length : 0
    if (totalNodes === 0 && errorCount > 0) {
      log.warn?.(
        `[Stale Cleanup] ${provider}: skipped — scan returned 0 nodes with ${errorCount} error(s); ` +
        `cleanup would mark every existing ${provider} node stale`
      )
      stats.skipped = true
      return stats
    }
  }

  try {
    // Delete unmapped stale nodes
    const delResult = await write(`
      MATCH (i:Infra)
      WHERE i.source = 'discovery'
        AND i.provider = $provider
        AND i.lastupdated IS NOT NULL
        AND i.lastupdated < $scanEpoch
        AND NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
      DETACH DELETE i
      RETURN count(i) AS removed
    `, { provider, scanEpoch })
    stats.removed = delResult[0]?.get('removed')?.toNumber?.() ?? delResult[0]?.get('removed') ?? 0

    // Mark mapped stale nodes (don't delete — they have component links)
    const staleResult = await write(`
      MATCH (i:Infra)
      WHERE i.source = 'discovery'
        AND i.provider = $provider
        AND i.lastupdated IS NOT NULL
        AND i.lastupdated < $scanEpoch
        AND (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
      SET i.stale = true
      RETURN count(i) AS marked
    `, { provider, scanEpoch })
    stats.markedStale = staleResult[0]?.get('marked')?.toNumber?.() ?? staleResult[0]?.get('marked') ?? 0

    if (stats.removed > 0 || stats.markedStale > 0) {
      log.info(`[Stale Cleanup] ${provider}: removed ${stats.removed}, marked stale ${stats.markedStale}`)
    }
  } catch (err) {
    stats.errors.push(err.message)
    log.warn(`[Stale Cleanup] ${provider}: ${err.message}`)
  }
  return stats
}

// ─── AWS Scanner ──────────────────────────────────────────────────────────────
//
// Delegates to the Config-aggregator scanner in discovery.aws.js. The old
// per-service SDK loops (ec2, rds, lambda, eks, ecs, elb-v2, elasticache —
// 7 services × N regions) have been replaced by a single
// SelectAggregateResourceConfig query plus structural edge emission. See
// docs/aws-config-aggregator-coverage.md for the field audit and the
// Config aggregator prerequisites.

export const scanAWS = scanAWSViaConfigAggregator

// ─── Azure Scanner ────────────────────────────────────────────────────────────
//
// Delegates to the Azure Resource Graph scanner in discovery.azure.js. The
// old per-type SDK loops (compute, containerservice, sql, appservice,
// network, rediscache, arm-resources) have been replaced by a single ARG
// paginated query plus structural edge emission. See
// docs/azure-resource-graph-coverage.md for the field-by-field audit.

export const scanAzure = scanAzureViaResourceGraph

// ─── GCP Scanner ──────────────────────────────────────────────────────────────
//
// Delegates to the Cloud Asset Inventory scanner in discovery.gcp.js. The
// old per-product SDK loops (compute, container, googleapis sqladmin/run)
// have been replaced by a single CAI listAssets call plus structural edge
// emission. See docs/gcp-cloud-asset-coverage.md for the field-by-field
// audit.

export const scanGCP = scanGCPViaCloudAssetInventory

// ─── Route handlers ───────────────────────────────────────────────────────────

export default async function discoveryRoutes(fastify) {
  async function enrichWithAI(fastify, suggestions) {
    // Only enrich if local AI is available — never block the response
    if (!fastify.ai?.localAvailable) return suggestions
  
    // Enrich top suggestion for the highest-scoring resources (up to 10)
    const toEnrich = suggestions.slice(0, 10)
  
    return Promise.all(suggestions.map(async (item, idx) => {
      if (idx >= 10 || !item.suggestions?.[0]) return item
  
      try {
        const top = item.suggestions[0]
        const explanation = await fastify.ai.explainMapping(item.infra, top)
        return {
          ...item,
          suggestions: item.suggestions.map((s, i) => i === 0 ? { ...s, aiExplanation: explanation } : s),
          aiEnriched: true,
        }
      } catch {
        return item  // never fail the whole response
      }
    }))
  }
  const { write, query } = fastify.neo4j
  const audit = (...a) => fastify.pg.audit(...a).catch(() => {})
  const actor = (req) => req.headers['x-actor'] || 'system'

  // Cloud-account CRUD lives in `routes/integrations-cloud.js` under
  // `/integrations/cloud`. Discovery is a *consumer* of those records —
  // see the `loadAccounts` helper below — and never owns them.

  // ── Helper: load all enabled accounts for a provider from Postgres ──────
  const loadAccounts = async (provider) => {
    if (!fastify.pg.pool) return []
    const rows = await fastify.pg.query(
      `SELECT id, name, config FROM cloud_accounts
       WHERE provider = $1 AND enabled = true ORDER BY name`,
      [provider]
    )
    return rows.map(r => ({ id: r.id, name: r.name, config: decryptConfig(r.config || {}) }))
  }

  // ── Helper: update scan result on account ────────────────────────────────
  const updateScanResult = async (accountId, status, total, error) => {
    if (!fastify.pg.pool || !accountId) return
    await fastify.pg.query(
      `UPDATE cloud_accounts
       SET last_scan_at = now(), last_scan_status = $1,
           last_scan_total = $2, last_scan_error = $3
       WHERE id = $4`,
      [status, total || 0, error || null, accountId]
    ).catch(() => {})
  }

  // ── POST /discovery/scan/aws ──────────────────────────────────────────────
  // Scans all configured AWS accounts from Postgres, or uses credentials
  // from the request body for a one-off scan.
  fastify.post('/scan/aws', {
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } }, // cloud-API cost guard
    schema: {
      summary:     'Scan AWS via Config aggregator',
      description: 'Pages every aggregated resource via `SelectAggregateResourceConfig` and writes Infra + structural `:CONNECTS_TO` edges. With a body, runs a one-off scan against the supplied credentials; without one, scans every enabled AWS account from `/integrations/cloud`. Requires `aggregatorName` + `aggregatorRegion` (or `AWS_CONFIG_AGGREGATOR_NAME` env var). See [docs/aws-config-aggregator-coverage.md](../docs/aws-config-aggregator-coverage.md).',
      body: { type: 'object', additionalProperties: true, properties: {
        regions:    { type: 'array', items: { type: 'string' } },
        accountId:  { type: 'string', description: 'When set, only scan this configured account' },
        credentials: { type: 'object', additionalProperties: true, properties: {
          accessKeyId:      { type: 'string' },
          secretAccessKey:  { type: 'string' },
          sessionToken:     { type: 'string' },
          aggregatorName:   { type: 'string' },
          aggregatorRegion: { type: 'string' },
        } },
      } },
      response: { 200: ScanResponseSchema, 400: StandardErrorResponses[400], 500: StandardErrorResponses[500] },
    },
  }, async (req, reply) => {
    const { regions = ['us-east-1'], credentials, accountId } = req.body || {}
    const startedAt = Date.now()

    // Load all configured AWS accounts from Postgres
    const accounts = await loadAccounts('aws')

    // If credentials passed directly — one-off scan, not tied to a saved account
    const scanEpoch = Date.now()
    if (credentials || !accounts.length) {
      fastify.log.info(`[Discovery] AWS one-off scan for regions: ${regions.join(', ')}`)
      let stats
      try {
        stats = await scanAWS({ credentials, regions, write, log: fastify.log, scanEpoch })
      } catch (err) {
        return reply.internalServerError(`AWS scan failed: ${err.message}`)
      }
      const stale = await cleanupStaleNodes(write, query, fastify.log, 'aws', scanEpoch, stats)
      const duration = Date.now() - startedAt
      const total = Object.entries(stats).filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k)).reduce((s,[,v])=>s+v,0)
      audit(actor(req), 'scan', 'CloudAccount', 'aws', 'AWS', { regions, total, duration, breakdown: stats })
      return { provider: 'aws', accounts: 1, regions, duration, total, breakdown: stats, stale, completedAt: new Date().toISOString() }
    }

    // Scan all configured accounts (or a specific one if accountId provided)
    const toScan = accountId ? accounts.filter(a => a.id === accountId || a.name === accountId) : accounts
    fastify.log.info(`[Discovery] AWS scan: ${toScan.length} account(s)`)

    const allResults = []
    for (const account of toScan) {
      const cfg = account.config || {}
      const creds = cfg.accessKeyId
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey || cfg.secretKey }
        : null
      const scanRegions = cfg.regions ? cfg.regions.split(',').map(r => r.trim()) : regions
      try {
        const stats = await scanAWS({ credentials: creds, regions: scanRegions, write, log: fastify.log, scanEpoch })
        const total = Object.entries(stats).filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k)).reduce((s,[,v])=>s+v,0)
        await updateScanResult(account.id, 'success', total, null)
        allResults.push({ account: account.name, regions: scanRegions, total, breakdown: stats })
      } catch (err) {
        await updateScanResult(account.id, 'error', 0, err.message)
        allResults.push({ account: account.name, error: err.message })
      }
    }

    // Multi-account scan: per-account `stats` is per-iteration. The
    // cleanup guard is for the all-error/zero-node case, which can't
    // happen here unless every account errored — and even then a single
    // partial-success means some nodes got refreshed. Pass null so the
    // guard is a no-op for multi-account loops.
    const stale = await cleanupStaleNodes(write, query, fastify.log, 'aws', scanEpoch, null)
    let bootstrap = null
    try { bootstrap = await bootstrapDiscovery(fastify) } catch {}

    const duration = Date.now() - startedAt
    const grandTotal = allResults.reduce((s, r) => s + (r.total || 0), 0)
    audit(actor(req), 'scan', 'CloudAccount', 'aws', 'AWS', { accounts: toScan.length, grandTotal, duration })
    return { provider: 'aws', accounts: toScan.length, duration, total: grandTotal, results: allResults, stale, bootstrap, completedAt: new Date().toISOString() }
  })

  // ── POST /discovery/scan/azure ────────────────────────────────────────
  // Scans all configured Azure subscriptions from Postgres, or uses
  // credentials from the request body for a one-off scan.
  fastify.post('/scan/azure', {
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } }, // cloud-API cost guard
    schema: {
      summary:     'Scan Azure via Resource Graph',
      description: 'Pages a single ARG KQL query and writes Infra + structural `:CONNECTS_TO` edges. With a body, runs a one-off scan against the supplied subscription/credentials; without one, scans every enabled Azure account from `/integrations/cloud`. See [docs/azure-resource-graph-coverage.md](../docs/azure-resource-graph-coverage.md).',
      body: { type: 'object', additionalProperties: true, properties: {
        subscriptionId: { type: 'string' },
        accountId:      { type: 'string' },
        credentials:    { type: 'object', additionalProperties: true, properties: {
          tenantId:     { type: 'string' },
          clientId:     { type: 'string' },
          clientSecret: { type: 'string' },
        } },
      } },
      response: { 200: ScanResponseSchema, 500: StandardErrorResponses[500] },
    },
  }, async (req, reply) => {
    const { subscriptionId, credentials, accountId } = req.body || {}
    const startedAt = Date.now()

    // Load all configured Azure accounts from Postgres
    const accounts = await loadAccounts('azure')

    // One-off scan with credentials passed directly
    const scanEpoch = Date.now()
    if (credentials || !accounts.length) {
      fastify.log.info(`[Discovery] Azure one-off scan: ${subscriptionId}`)
      let stats
      try {
        stats = await scanAzure({ credentials, subscriptionId, write, log: fastify.log, scanEpoch })
      } catch (err) {
        return reply.internalServerError(`Azure scan failed: ${err.message}`)
      }
      const stale = await cleanupStaleNodes(write, query, fastify.log, 'azure', scanEpoch, stats)
      const duration = Date.now() - startedAt
      const total = Object.entries(stats).filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k)).reduce((s,[,v])=>s+v,0)
      audit(actor(req), 'scan', 'CloudAccount', 'azure', 'Azure', { subscriptionId, total, duration, breakdown: stats })
      return { provider: 'azure', accounts: 1, subscriptionId, duration, total, breakdown: stats, stale, completedAt: new Date().toISOString() }
    }

    // Scan all configured subscriptions (or a specific one if accountId provided)
    const toScan = accountId ? accounts.filter(a => a.id === accountId || a.name === accountId) : accounts
    fastify.log.info(`[Discovery] Azure scan: ${toScan.length} subscription(s)`)

    const allResults = []
    for (const account of toScan) {
      const cfg = account.config || {}
      const creds = cfg.clientId
        ? { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret }
        : null
      const subId = cfg.subscriptionId || subscriptionId
      try {
        const stats = await scanAzure({ credentials: creds, subscriptionId: subId, write, log: fastify.log, scanEpoch })
        const total = Object.entries(stats).filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k)).reduce((s,[,v])=>s+v,0)
        await updateScanResult(account.id, 'success', total, null)
        allResults.push({ account: account.name, subscriptionId: subId, total, breakdown: stats })
      } catch (err) {
        await updateScanResult(account.id, 'error', 0, err.message)
        allResults.push({ account: account.name, subscriptionId: subId, error: err.message })
      }
    }

    const stale = await cleanupStaleNodes(write, query, fastify.log, 'azure', scanEpoch, null)

    // Auto-bootstrap after Azure scan
    let bootstrap = null
    try { bootstrap = await bootstrapDiscovery(fastify) } catch {}

    const duration = Date.now() - startedAt
    const grandTotal = allResults.reduce((s, r) => s + (r.total || 0), 0)
    audit(actor(req), 'scan', 'CloudAccount', 'azure', 'Azure', { accounts: toScan.length, grandTotal, duration })
    return { provider: 'azure', accounts: toScan.length, duration, total: grandTotal, results: allResults, stale, bootstrap, completedAt: new Date().toISOString() }
  })

  // ── POST /discovery/scan/gcp ──────────────────────────────────────────
  // Scans all configured GCP projects from Postgres, or uses credentials
  // from the request body for a one-off scan.
  fastify.post('/scan/gcp', {
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } }, // cloud-API cost guard
    schema: {
      summary:     'Scan GCP via Cloud Asset Inventory',
      description: 'Pages `cloudasset.assets.listAssets` for the project and writes Infra + structural `:CONNECTS_TO` edges. With a body, runs a one-off scan; without one, scans every enabled GCP account from `/integrations/cloud`. See [docs/gcp-cloud-asset-coverage.md](../docs/gcp-cloud-asset-coverage.md).',
      body: { type: 'object', additionalProperties: true, properties: {
        projectId:   { type: 'string' },
        accountId:   { type: 'string' },
        credentials: { type: 'object', additionalProperties: true,
          description: 'GCP service-account JSON contents (client_email, private_key, …)' },
      } },
      response: { 200: ScanResponseSchema, 500: StandardErrorResponses[500] },
    },
  }, async (req, reply) => {
    const { projectId, credentials, accountId } = req.body || {}
    const startedAt = Date.now()

    const accounts = await loadAccounts('gcp')

    // One-off scan with credentials passed directly
    const scanEpoch = Date.now()
    if (credentials || !accounts.length) {
      fastify.log.info(`[Discovery] GCP one-off scan: ${projectId}`)
      let stats
      try {
        stats = await scanGCP({ credentials, projectId, write, log: fastify.log, scanEpoch })
      } catch (err) {
        return reply.internalServerError(`GCP scan failed: ${err.message}`)
      }
      const stale = await cleanupStaleNodes(write, query, fastify.log, 'gcp', scanEpoch, stats)
      const duration = Date.now() - startedAt
      const total = Object.entries(stats).filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k)).reduce((s,[,v])=>s+v,0)
      audit(actor(req), 'scan', 'CloudAccount', 'gcp', 'GCP', { projectId, total, duration, breakdown: stats })
      return { provider: 'gcp', accounts: 1, projectId, duration, total, breakdown: stats, stale, completedAt: new Date().toISOString() }
    }

    // Scan all configured projects
    const toScan = accountId ? accounts.filter(a => a.id === accountId || a.name === accountId) : accounts
    fastify.log.info(`[Discovery] GCP scan: ${toScan.length} project(s)`)

    const allResults = []
    for (const account of toScan) {
      const cfg = account.config || {}
      let creds = null
      if (cfg.serviceAccount) {
        try { creds = JSON.parse(cfg.serviceAccount) } catch {}
      }
      const proj = cfg.projectId || projectId
      try {
        const stats = await scanGCP({ credentials: creds, projectId: proj, write, log: fastify.log, scanEpoch })
        const total = Object.entries(stats).filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k)).reduce((s,[,v])=>s+v,0)
        await updateScanResult(account.id, 'success', total, null)
        allResults.push({ account: account.name, projectId: proj, total, breakdown: stats })
      } catch (err) {
        await updateScanResult(account.id, 'error', 0, err.message)
        allResults.push({ account: account.name, projectId: proj, error: err.message })
      }
    }

    const stale = await cleanupStaleNodes(write, query, fastify.log, 'gcp', scanEpoch, null)
    let bootstrap = null
    try { bootstrap = await bootstrapDiscovery(fastify) } catch {}

    const duration = Date.now() - startedAt
    const grandTotal = allResults.reduce((s, r) => s + (r.total || 0), 0)
    audit(actor(req), 'scan', 'CloudAccount', 'gcp', 'GCP', { accounts: toScan.length, grandTotal, duration })
    return { provider: 'gcp', accounts: toScan.length, duration, total: grandTotal, results: allResults, stale, bootstrap, completedAt: new Date().toISOString() }
  })

  // ── POST /discovery/scan/all — scan all configured cloud accounts ──────
  // Loads accounts from Postgres and runs the per-provider scanners.
  // Accepts optional body overrides but works with no body at all.
  fastify.post('/scan/all', {
    config: { rateLimit: { max: 1, timeWindow: '5 minutes' } }, // most expensive — fan-out across providers
    schema: {
      summary:     'Scan every configured cloud account in parallel',
      description: 'Fans out to `scanAWS` / `scanAzure` / `scanGCP` for every enabled account configured at `/integrations/cloud`. Bootstrap runs once at the end; cleanup is per-provider. The single response covers all three clouds with per-account breakdowns under `results.<provider>[]`.',
      response: {
        200: { type: 'object', additionalProperties: true, properties: {
          duration: { type: 'integer' }, total: { type: 'integer' },
          providers:   { type: 'array', items: { type: 'string' } },
          results:     { type: 'object', additionalProperties: true },
          errors:      { type: 'object', additionalProperties: true },
          stale:       { type: 'object', additionalProperties: true },
          bootstrap:   { type: ['object', 'null'], additionalProperties: true },
          completedAt: { type: 'string', format: 'date-time' },
        } },
      },
    },
  }, async (req, reply) => {
    const startedAt  = Date.now()
    const scanEpoch  = startedAt
    const accounts   = await Promise.all([
      loadAccounts('aws'), loadAccounts('azure'), loadAccounts('gcp'),
    ]).then(([a, b, c]) => [...a, ...b, ...c])

    if (!accounts.length) {
      return reply.badRequest('No cloud accounts configured. Add accounts via Integrations first.')
    }

    // One episode spans the whole scan+enrich+bootstrap pipeline so edges
    // produced by any stage share a single provenance id.
    const episode = await startEpisode(fastify.neo4j, 'discovery.scan.all').catch(() => null)
    const episodeId = episode?.uuid || null

    const results    = {}
    const errors     = {}
    const providers  = new Set()
    let grandTotal   = 0

    const scanJobs = accounts.map(async (account) => {
      const cfg  = account.config || {}
      const prov = account.provider || (cfg.subscriptionId ? 'azure' : cfg.projectId ? 'gcp' : 'aws')
      providers.add(prov)
      try {
        let stats
        if (prov === 'aws') {
          const creds = cfg.accessKeyId ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey || cfg.secretKey } : null
          const scanRegions = cfg.regions ? cfg.regions.split(',').map(r => r.trim()) : ['us-east-1']
          stats = await scanAWS({ credentials: creds, regions: scanRegions, write, log: fastify.log, scanEpoch })
        } else if (prov === 'azure') {
          const creds = cfg.clientId ? { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret } : null
          stats = await scanAzure({ credentials: creds, subscriptionId: cfg.subscriptionId, write, log: fastify.log, scanEpoch })
        } else if (prov === 'gcp') {
          let creds = null
          if (cfg.serviceAccount) { try { creds = JSON.parse(cfg.serviceAccount) } catch {} }
          stats = await scanGCP({ credentials: creds, projectId: cfg.projectId, write, log: fastify.log, scanEpoch })
        }
        const total = stats ? Object.entries(stats).filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k)).reduce((s,[,v])=>s+v,0) : 0
        grandTotal += total
        await updateScanResult(account.id, 'success', total, null)
        if (!results[prov]) results[prov] = []
        results[prov].push({ account: account.name, total, breakdown: stats })
      } catch (e) {
        await updateScanResult(account.id, 'error', 0, e.message)
        if (!errors[prov]) errors[prov] = []
        errors[prov].push({ account: account.name, error: e.message })
      }
    })

    await Promise.allSettled(scanJobs)

    // Cleanup stale nodes for each scanned provider. Aggregate the per-
    // account breakdowns into a single { totalNodes, errors } shape so
    // cleanupStaleNodes' errored-scan guard can decide whether the
    // provider's scan was "all-error, zero-node" — which is the unsafe
    // case that would mark every existing node stale.
    const stale = {}
    for (const prov of providers) {
      const accountStats = (results[prov] || []).map(r => r.breakdown).filter(Boolean)
      const aggregated = accountStats.reduce(
        (acc, s) => {
          for (const [k, v] of Object.entries(s)) {
            if (['edges', 'errors', 'skipped', 'scanEpoch'].includes(k)) continue
            if (typeof v === 'number') acc[k] = (acc[k] || 0) + v
          }
          if (Array.isArray(s.errors)) acc.errors.push(...s.errors)
          return acc
        },
        { errors: [] },
      )
      // Failed scans (in `errors[prov]`) also count toward the
      // "errored-scan" signal — surface them to the guard.
      for (const e of (errors[prov] || [])) aggregated.errors.push(`${e.account}: ${e.error}`)
      stale[prov] = await cleanupStaleNodes(write, query, fastify.log, prov, scanEpoch, aggregated)
    }

    // Auto-bootstrap: create applications and link unmapped resources.
    // Bootstrap shares the parent scan's episodeId so every component-mapping
    // edge it writes is traceable to this scan run.
    let bootstrap = null
    try {
      bootstrap = await bootstrapDiscovery(fastify, { episodeId })
    } catch (err) {
      fastify.log.warn(`[Auto-bootstrap] ${err.message}`)
    }

    const duration = Date.now() - startedAt
    audit(actor(req), 'scan', 'CloudAccount', 'all', 'All Providers',
      { accounts: accounts.length, grandTotal, duration, results, errors, episodeId })

    // Tell the CMDB assessment scheduler that fresh data has landed. The
    // scheduler picks this up on its next tick (or immediately, since the
    // worker tick is cheap). No-op if the plugin isn't decorated.
    fastify.cmdbAssessment?.markDirty?.().catch(() => {})

    const outcome = Object.keys(errors).length ? 'partial' : 'ok'
    await finishEpisode(fastify.neo4j, episode, outcome, {
      accounts:   accounts.length,
      grandTotal,
      durationMs: duration,
    }).catch(() => {})

    return { episodeId, total: grandTotal, duration, accounts: accounts.length, results, errors, stale, bootstrap, completedAt: new Date().toISOString() }
  })

  // ── GET /discovery/schedule ─────────────────────────────────────────────
  // Returns the current auto-discovery schedule configuration
  fastify.get('/schedule', {
    schema: {
      summary:     'Current discovery scheduler state',
      description: 'Returns the cron-style schedule plus the last-run / next-run timestamps. The scheduler runs every enabled provider in parallel.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!fastify.pg?.pool) return {
      scope: 'global', enabled: false, interval_mins: 15,
      last_run_at: null, last_run_status: null, last_run_total: 0, next_run_at: null
    }
    try {
      await fastify.pg.query(`
        CREATE TABLE IF NOT EXISTS discovery_schedule (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          scope TEXT NOT NULL DEFAULT 'global',
          enabled BOOLEAN NOT NULL DEFAULT true,
          interval_mins INTEGER NOT NULL DEFAULT 15,
          auto_create BOOLEAN NOT NULL DEFAULT false,
          auto_create_min_score INTEGER NOT NULL DEFAULT 70,
          last_run_at TIMESTAMPTZ, last_run_status TEXT,
          last_run_total INTEGER DEFAULT 0,
          last_auto_create_total INTEGER DEFAULT 0,
          next_run_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (scope)
        );
        ALTER TABLE discovery_schedule
          ADD COLUMN IF NOT EXISTS auto_create BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS auto_create_min_score INTEGER NOT NULL DEFAULT 70,
          ADD COLUMN IF NOT EXISTS last_auto_create_total INTEGER DEFAULT 0;
        INSERT INTO discovery_schedule (scope, enabled, interval_mins, auto_create, auto_create_min_score)
        VALUES ('global', false, 15, false, 70) ON CONFLICT (scope) DO NOTHING;
      `).catch(() => {})
      const rows = await fastify.pg.query(
        `SELECT * FROM discovery_schedule WHERE scope = 'global' LIMIT 1`
      )
      return rows[0] || {
        scope: 'global', enabled: false, interval_mins: 15,
        auto_create: false, auto_create_min_score: 70
      }
    } catch (err) {
      return {
        scope: 'global', enabled: false, interval_mins: 15,
        auto_create: false, auto_create_min_score: 70, error: err.message
      }
    }
  })

  // ── PUT /discovery/schedule ──────────────────────────────────────────────
  // Update schedule config — enabled flag and/or interval_mins
  // interval_mins: minimum 5 (5 minutes), maximum 1440 (24 hours)
  fastify.put('/schedule', {
    schema: {
      summary:     'Set the discovery scheduler',
      description: 'Replaces the schedule with `{ enabled, cron }`. The cron string is standard 5-field; consult any cron reference. Setting `enabled: false` disables future runs without deleting the config.',
      body: { type: 'object', additionalProperties: true, properties: {
        enabled: { type: 'boolean' },
        cron:    { type: 'string', example: '0 */6 * * *' },
      } },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const { enabled, interval_mins, hours, minutes, auto_create, auto_create_min_score } = req.body || {}

    // Accept either interval_mins directly or hours+minutes breakdown
    let intervalMins = interval_mins
    if (intervalMins === undefined && (hours !== undefined || minutes !== undefined)) {
      intervalMins = (parseInt(hours) || 0) * 60 + (parseInt(minutes) || 0)
    }

    // Validate
    if (intervalMins !== undefined) {
      if (intervalMins < 5)    return reply.badRequest('Minimum interval is 5 minutes')
      if (intervalMins > 1440) return reply.badRequest('Maximum interval is 1440 minutes (24 hours)')
    }

    if (!fastify.pg?.pool) return reply.serviceUnavailable('Database not available')

    try {
      const fields = {}
      if (enabled !== undefined)               fields.enabled                = enabled
      if (intervalMins !== undefined)          fields.interval_mins          = intervalMins
      if (auto_create !== undefined)           fields.auto_create            = auto_create
      if (auto_create_min_score !== undefined) fields.auto_create_min_score  =
        Math.max(0, Math.min(100, parseInt(auto_create_min_score) || 70))

      // Compute next_run_at based on new interval
      if (intervalMins !== undefined && enabled !== false) {
        fields.next_run_at = new Date(Date.now() + intervalMins * 60 * 1000)
      }

      const setClauses = Object.keys(fields).map((k, i) => `${k} = $${i + 1}`)
      setClauses.push('updated_at = now()')
      const values = [...Object.values(fields), 'global']

      const rows = await fastify.pg.query(
        `INSERT INTO discovery_schedule (scope, enabled, interval_mins)
         VALUES ('global', $1, $2)
         ON CONFLICT (scope) DO UPDATE SET ${setClauses.join(', ')}
         WHERE discovery_schedule.scope = $${values.length}
         RETURNING *`,
        [enabled ?? false, intervalMins ?? 15, ...values]
      ).catch(async () => {
        // Simpler upsert fallback
        await fastify.pg.query(
          `INSERT INTO discovery_schedule (scope, enabled, interval_mins, auto_create, auto_create_min_score)
           VALUES ('global', COALESCE($1, false), COALESCE($2, 15), COALESCE($3, false), COALESCE($4, 70))
           ON CONFLICT (scope) DO UPDATE
             SET enabled               = COALESCE($1, discovery_schedule.enabled),
                 interval_mins         = COALESCE($2, discovery_schedule.interval_mins),
                 auto_create           = COALESCE($3, discovery_schedule.auto_create),
                 auto_create_min_score = COALESCE($4, discovery_schedule.auto_create_min_score),
                 next_run_at = $5, updated_at = now()`,
          [enabled ?? null, intervalMins ?? null,
           auto_create ?? null, auto_create_min_score ?? null,
           fields.next_run_at ?? null]
        )
        const r = await fastify.pg.query(
          `SELECT * FROM discovery_schedule WHERE scope = 'global' LIMIT 1`
        )
        return r
      })

      const schedule = Array.isArray(rows) ? rows[0] : rows?.rows?.[0]

      // Restart the timer if scheduler plugin is available
      if (fastify.scheduler?.restart) {
        await fastify.scheduler.restart()
      }

      audit(actor(req), 'update', 'DiscoverySchedule', 'global', 'Discovery Schedule',
        { enabled, interval_mins: intervalMins })

      return schedule || { scope: 'global', enabled: enabled ?? false, interval_mins: intervalMins ?? 15 }
    } catch (err) {
      fastify.log.error(`[Schedule] PUT error: ${err.message}`)
      return reply.internalServerError(`Failed to update schedule: ${err.message}`)
    }
  })

  // ── POST /discovery/schedule/run-now ────────────────────────────────────
  // Manually trigger an immediate scan outside the schedule
  fastify.post('/schedule/run-now', {
    schema: {
      summary:     'Trigger the scheduled scan immediately',
      description: 'Equivalent to `POST /discovery/scan/all` but uses the same code path the scheduler does (so it picks up the same accounts + flags).',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (fastify.scheduler?.runNow) {
      // Fire and forget — don't await so the response returns immediately
      fastify.scheduler.runNow().catch(err =>
        fastify.log.error(`[Scheduler] Manual run error: ${err.message}`)
      )
      return { triggered: true, message: 'Scan started — check /discovery/schedule for status' }
    }
    // Fallback: call scan/all directly
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/scan/all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })
    const data = await res.json()
    return { triggered: true, ...data }
  })




  // ── GET /discovery/debug/:id — inspect raw Neo4j data for a resource ──
  // Returns full raw cloud-API responses + every `:CONNECTS_TO` edge with
  // properties. Useful for understanding scanner / autolink decisions, but
  // it leaks tag values that may carry PII (`appcloud:owner`, slack-channel
  // tags, etc.) and the truncated `raw` blob may carry sensitive metadata.
  //
  // Gated behind admin-tier auth AND APPCLOUD_DEBUG=1 so it can't be hit by
  // a regular API key in production. In dev (NODE_ENV !== 'production') the
  // env-flag gate is relaxed since debugging is the whole point there.
  fastify.get('/debug/:id', {
    config: { requireAdmin: true },
    schema: {
      summary:     'Per-resource debug dump (admin + APPCLOUD_DEBUG only)',
      description: 'Returns the Infra node plus every `:CONNECTS_TO` edge it participates in (incoming and outgoing), with full edge properties. Use this to understand why the suggest engine made a particular call. **Admin-tier only**, and in production must also have `APPCLOUD_DEBUG=1` set.',
      params:      IdParamSchema,
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (process.env.NODE_ENV === 'production' && process.env.APPCLOUD_DEBUG !== '1') {
      return reply.code(403).send({
        error:   'Forbidden',
        message: 'debug endpoint disabled in production — set APPCLOUD_DEBUG=1 to enable temporarily',
      })
    }
    const records = await query(
      `MATCH (i:Infra) WHERE i.id = $id OR i.cloud_id = $id RETURN i LIMIT 1`,
      { id: req.params.id }
    )
    if (!records.length) {
      // Return all infra node names so you can find the right ID
      const all = await query(
        `MATCH (i:Infra {source:'discovery'})
         RETURN i.id AS id, i.name AS name, i.provider AS provider,
                i.resource_type AS type,
                i.tags IS NOT NULL AS hasTags,
                i.raw  IS NOT NULL AS hasRaw,
                COALESCE(i.tags, '{}') AS tags
         ORDER BY i.provider, i.name LIMIT 50`
      )
      return {
        error: 'Infra node not found for id: ' + req.params.id,
        availableResources: all.map(r => ({
          id:       r.get('id'),
          name:     r.get('name'),
          provider: r.get('provider'),
          type:     r.get('type'),
          hasTags:  r.get('hasTags'),
          hasRaw:   r.get('hasRaw'),
          tagsRaw:  r.get('tags'),  // show raw string value from Neo4j
        }))
      }
    }
    const node = records[0].get('i')
    const raw = node.properties
    return {
      id:               raw.id,
      name:             raw.name,
      provider:         raw.provider,
      resource_type:    raw.resource_type,
      // Show the raw string values as stored in Neo4j
      tags_type:        typeof raw.tags,
      tags_raw:         raw.tags,       // raw string from Neo4j
      raw_type:         typeof raw.raw,
      raw_truncated:    typeof raw.raw === 'string' ? raw.raw.slice(0, 200) : raw.raw,
      // Show parsed values
      tags_parsed:      (() => { try { return typeof raw.tags === 'string' ? JSON.parse(raw.tags) : raw.tags } catch(e) { return { parseError: e.message } } })(),
      discovered_at:    raw.discovered_at?.toString(),
    }
  })

  // ── GET /discovery/suggest ────────────────────────────────────────────────
  // Analyses tags, metadata and name of every unmapped Infra node and returns
  // ranked mapping suggestions against existing Applications and Components.
  //
  // Scoring (0-100):
  //   appcloud:app tag matches Application.name exactly   → +40
  //   appcloud:app tag matches Application.name fuzzy     → +25
  //   appcloud:component tag matches Component.name       → +30
  //   appcloud:owner / team tag matches Application.owner → +15
  //   appcloud:env / environment matches                  → +10
  //   appcloud:tier matches Application.tier              → +5
  //   resource name contains component/app name          → +10
  //   resource type matches component type               → +5
  //
  //   Threshold for "high confidence" auto-suggest: >= 60
  //   Threshold for "possible match" display:       >= 25

  fastify.get('/suggest', {
    schema: {
      summary:     'Pull the suggest engine\'s current output',
      description: 'For every unmapped Infra, returns up to 5 ranked Component candidates with rule names + scores. Drives the mapping-suggestions UI.',
      response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req) => {
    const { minScore = 25, limit = 100, strategy } = req.query

    // When a high-fidelity strategy is active, demote name-based heuristic scores
    const activeStrategy = strategy
      ? AZURE_LINKING_STRATEGIES.find(s => s.id === strategy)
      : null
    // Name-heuristic demotion factor: strategies ranked 1-3 halve name scores,
    // rank 4-5 apply a 0.75 factor, rank 6 (name-heuristics itself) keeps 1.0
    const nameScoreFactor = activeStrategy
      ? (activeStrategy.rank <= 3 ? 0.5 : activeStrategy.rank <= 5 ? 0.75 : 1.0)
      : 1.0

    // Load all unmapped Infra nodes
    const infraRecords = await query(`
      MATCH (i:Infra)
      WHERE i.source = 'discovery'
        AND NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
      RETURN i
      ORDER BY i.provider, i.resource_type, i.name
      LIMIT toInteger($limit)
    `, { limit: parseInt(limit) })

    if (!infraRecords.length) return {
      suggestions: [],
      diagnostic: { unmappedInfra: 0, applications: 0, message: 'No unmapped infrastructure resources found' }
    }

    // Load all Applications and their Components
    const appRecords = await query(`
      MATCH (a:Application)
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      RETURN a, collect(DISTINCT c) AS components
    `)

    const apps = appRecords.map(r => ({
      ...props(r.get('a')),
      components: r.get('components').map(props)
    }))

    if (!apps.length) {
      const fallback = bootstrapSuggestFallback(infraRecords, props)
      const suggestions = []
      for (const appSuggestion of fallback.suggestions || []) {
        for (const match of appSuggestion.matches || []) {
          const infra = match.infra || {}
          const score = parseInt(match.score || 0)
          const confidence = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low'

          // Extract component name from tags (normalised) — prefer tag over infra name
          const matchTags = match.infra?.tags || {}
          let compFromTag = ''
          for (const [k, v] of Object.entries(matchTags)) {
            const nk = k.toLowerCase().replace(/^appcloud[:-]/, '').replace(/^app[:-]/, '').replace(/-/g, '_').trim()
            if ((nk === 'component' || nk === 'service' || nk === 'component_name') && v) {
              compFromTag = String(v); break
            }
          }
          // Extract owner, env, tier from tags
          let tagOwner = '', tagEnv = '', tagTier = ''
          for (const [k, v] of Object.entries(matchTags)) {
            const nk = k.toLowerCase().replace(/^appcloud[:-]/, '').replace(/^app[:-]/, '').replace(/-/g, '_').trim()
            if ((nk === 'owner' || nk === 'team') && v && !tagOwner) tagOwner = String(v)
            if ((nk === 'env' || nk === 'environment') && v && !tagEnv) tagEnv = String(v)
            if ((nk === 'tier' || nk === 'criticality') && v && !tagTier) tagTier = String(v)
          }

          const compName = compFromTag || infra.name || 'component'
          const appName = appSuggestion.application?.name || infra.name || 'default-app'

          suggestions.push({
            infra,
            suggestions: [{
              infraId: infra.id,
              componentId: null,
              componentName: null,
              applicationId: null,
              applicationName: appName,
              score,
              confidence,
              reasons: match.reasons || [],
              action: 'create_application',
              actionLabel: `Create application "${appName}" with component "${compName}"`,
              newAppName: appName,
              newCompName: compName,
              suggestedTier:  tagTier ? parseInt(tagTier) || 1 : 1,
              suggestedEnv:   tagEnv  || 'production',
              suggestedOwner: tagOwner || '',
            }],
            topScore: score,
            topConfidence: confidence,
          })
        }
      }
      const { enrich } = req.query   // ?enrich=true to opt-in to AI enrichment
      const finalSuggestions = enrich === 'true'
        ? await enrichWithAI(fastify, suggestions)
        : suggestions

      return {
        suggestions: finalSuggestions,
        diagnostic: {
          unmappedInfra:    infraRecords.length,
          applications:     apps.length,
          withSuggestions:  finalSuggestions.length,
          belowThreshold:   infraRecords.length - finalSuggestions.length,
          minScore:         parseInt(minScore),
          aiEnriched:       enrich === 'true' && fastify.ai?.localAvailable,
          message: finalSuggestions.length === 0
            ? `Found ${infraRecords.length} unmapped resource(s) and ${apps.length} application(s) but no matches above score ${minScore}.`
            : `Found ${finalSuggestions.length} suggestion(s) from ${infraRecords.length} unmapped resource(s)`
        }
      }
    }

    const suggestions = []

    // ── Pre-build structural lookup maps ──────────────────────────────────────
    // These let us score structural signals (Resource Group, App Plan, NIC parent,
    // subnet co-location) without extra Neo4j queries per infra node.

    // Map: resourceGroup (lowercase) → array of already-mapped { compId, compName, appId, appName }
    // Used for Rule: "other resources in the same RG are already mapped → likely same component"
    const rgMappedIndex = {}
    const mappedRgRows = await query(`
      MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i:Infra)
      WHERE i.provider = 'azure' AND i.cloud_id IS NOT NULL
      MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN i.raw AS raw, c.id AS compId, c.name AS compName,
             a.id AS appId, a.name AS appName
    `)
    for (const r of mappedRgRows) {
      let raw = {}
      try { raw = JSON.parse(r.get('raw') || '{}') } catch {}
      const rg = (raw.resourceGroup || '').toLowerCase()
      if (!rg) continue
      if (!rgMappedIndex[rg]) rgMappedIndex[rg] = []
      rgMappedIndex[rg].push({
        compId:   r.get('compId'),
        compName: r.get('compName'),
        appId:    r.get('appId'),
        appName:  r.get('appName'),
      })
    }

    // Map: serverFarmId (normalised lowercase) → { compId, compName, appId, appName }
    // App Services sharing the same App Service Plan very likely belong together
    const planMappedIndex = {}
    const mappedPlanRows = await query(`
      MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i:Infra)
      WHERE i.resource_type = 'app_service' AND i.raw IS NOT NULL
      MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN i.raw AS raw, c.id AS compId, c.name AS compName,
             a.id AS appId, a.name AS appName
    `)
    for (const r of mappedPlanRows) {
      let raw = {}
      try { raw = JSON.parse(r.get('raw') || '{}') } catch {}
      const planId = (raw.serverFarmId || '').toLowerCase()
      if (!planId) continue
      planMappedIndex[planId] = {
        compId:   r.get('compId'),
        compName: r.get('compName'),
        appId:    r.get('appId'),
        appName:  r.get('appName'),
      }
    }

    for (const ir of infraRecords) {
      const infra = props(ir.get('i'))

      const parseProp = (val) => {
        if (!val) return {}
        if (typeof val === 'object') return val
        if (typeof val === 'string') { try { return JSON.parse(val) } catch { return {} } }
        return {}
      }
      const tags = parseProp(infra.tags)
      const raw  = parseProp(infra.raw)

      // ── Normalise tag keys ──────────────────────────────────────────────
      const tagNorm = {}
      for (const [k, v] of Object.entries(tags)) {
        const normKey = k.toLowerCase()
          .replace(/^appcloud[:-]/, '')
          .replace(/^app[:-]/, '')
          .replace(/-/g, '_')
          .trim()
        tagNorm[normKey] = String(v || '').toLowerCase().trim()
      }
      const tagRaw = {}
      for (const [k, v] of Object.entries(tags)) {
        tagRaw[k.toLowerCase()] = String(v || '').toLowerCase().trim()
      }

      const tagApp = (
        tagNorm['app']          || tagNorm['application']  ||
        tagNorm['app_name']     || tagNorm['application_name'] ||
        tagNorm['project']      || tagRaw['appcloud:app']  ||
        tagRaw['appcloud-app']  || ''
      )
      const tagComponent = (
        tagNorm['component']      || tagNorm['service']        ||
        tagNorm['service_name']   || tagNorm['component_name'] ||
        tagNorm['module']         || tagRaw['appcloud:component'] ||
        tagRaw['appcloud-component'] || ''
      )
      const tagOwner = (
        tagNorm['owner']       || tagNorm['team']        ||
        tagNorm['managed_by']  || tagNorm['owned_by']    ||
        tagNorm['contact']     || tagNorm['cost_centre'] ||
        tagNorm['costcentre']  || ''
      )
      const tagEnv  = tagNorm['env'] || tagNorm['environment'] || tagNorm['stage'] || tagNorm['deployment_env'] || ''
      const tagTier = tagNorm['tier'] || tagNorm['criticality'] || ''

      // ── Structural signals from raw ──────────────────────────────────────
      // These are available without extra API calls — they were stored at scan time.
      const infraRg      = (raw.resourceGroup || '').toLowerCase()
      const infraPlanId  = (raw.serverFarmId  || '').toLowerCase()
      const infraNameLow = infra.name.toLowerCase()
      const infraType    = infra.resource_type?.toLowerCase() || ''
      const isInfraOnly  = INFRA_ONLY_TYPES.has(infraType) && !hasExplicitAppTag(tags)
      const isPlatformUntagged = PLATFORM_TYPES.has(infraType) && !tagApp

      const TYPE_MAP = {
        ec2_instance:       ['api','worker','app','server'],
        function:           ['api','worker','function','lambda'],
        function_app:       ['api','worker','function','lambda'],
        rds_instance:       ['db','database','datastore'],
        app_service:        ['api','web','ui','frontend'],
        vm:                 ['api','worker','app','server'],
        compute_instance:   ['api','worker','app','server'],
        cloud_run:          ['api','worker','service'],
        cloud_function:     ['api','worker','function'],
        app_insights:       ['monitoring','insights','observability','telemetry'],
        storage_account:    ['storage','assets','datastore','blob'],
        service_bus:        ['queue','eventbus','messaging','bus'],
        key_vault:          ['secrets','security','vault'],
        s3_bucket:          ['storage','assets','datastore'],
        dynamodb:           ['db','database','datastore'],
        eks_cluster:        ['kubernetes','k8s','cluster'],
        aks_cluster:        ['kubernetes','k8s','cluster'],
        gke_cluster:        ['kubernetes','k8s','cluster'],
        cosmos_db:          ['db','database','datastore'],
        container_registry: ['registry','container','docker'],
        log_analytics:      ['monitoring','observability','logging'],
        static_web_app:     ['web','frontend','static'],
      }
      const likelyCompTypes = TYPE_MAP[infraType] || []

      const scored = []

      // ── STRUCTURAL SIGNAL A: Resource Group co-location ─────────────────
      // If other already-mapped resources in the same RG belong to a component,
      // this resource very likely belongs there too — score before tag matching.
      if (infraRg && rgMappedIndex[infraRg]?.length) {
        // Tally component frequency within this RG
        const freq = {}
        for (const m of rgMappedIndex[infraRg]) {
          const key = m.compId
          if (!freq[key]) freq[key] = { ...m, count: 0 }
          freq[key].count++
        }
        const total  = rgMappedIndex[infraRg].length
        for (const { compId, compName, appId, appName, count } of Object.values(freq)) {
          const ratio = count / total
          // Unanimous RG → 75; majority → 62; minority → 45
          // Infra-only resources get a +10 boost to favor linking to existing apps
          const baseRgScore = ratio >= 1.0 ? 75 : ratio >= 0.5 ? 62 : 45
          const rgScore = Math.min(100, baseRgScore + (isInfraOnly || isPlatformUntagged ? 10 : 0))
          const comp = apps.flatMap(a => a.components).find(c => c.id === compId)
          const app  = apps.find(a => a.id === appId)
          if (!comp || !app) continue
          scored.push({
            infraId:         infra.id,
            componentId:     compId,
            componentName:   compName,
            applicationId:   appId,
            applicationName: appName,
            score:           rgScore,
            confidence:      rgScore >= 70 ? 'high' : rgScore >= 45 ? 'medium' : 'low',
            reasons:         [`Resource Group "${infraRg}" co-location (${Math.round(ratio * 100)}% of RG mapped to same component)`],
            action:          'link_component',
            actionLabel:     `Link to ${compName} in ${appName} (same Resource Group)`,
          })
        }
      }

      // ── STRUCTURAL SIGNAL B: Shared App Service Plan ─────────────────────
      // App Services on the same plan almost always belong to the same application.
      if (infraPlanId && planMappedIndex[infraPlanId]) {
        const { compId, compName, appId, appName } = planMappedIndex[infraPlanId]
        const comp = apps.flatMap(a => a.components).find(c => c.id === compId)
        const app  = apps.find(a => a.id === appId)
        if (comp && app) {
          scored.push({
            infraId:         infra.id,
            componentId:     compId,
            componentName:   compName,
            applicationId:   appId,
            applicationName: appName,
            score:           80,
            confidence:      'high',
            reasons:         [`Shares App Service Plan with already-mapped ${compName}`],
            action:          'link_component',
            actionLabel:     `Link to ${compName} in ${appName} (same App Service Plan)`,
          })
        }
      }

      // ── TAG + NAME scoring against each application ──────────────────────
      for (const app of apps) {
        const appNameLow  = app.name.toLowerCase()
        const appOwnerLow = (app.owner || '').toLowerCase()
        const appEnvLow   = (app.environment || '').toLowerCase()

        let appScore = 0
        const appReasons = []

        if (tagApp && tagApp === appNameLow) {
          appScore += 40; appReasons.push(`tag "app" = "${app.name}" (exact)`)
        } else if (tagApp && (appNameLow.includes(tagApp) || tagApp.includes(appNameLow))) {
          appScore += 25; appReasons.push(`tag "app" ≈ "${app.name}" (partial)`)
        } else if (infraNameLow.includes(appNameLow) || appNameLow.split(' ').some(w => infraNameLow.includes(w) && w.length > 3)) {
          appScore += Math.round(10 * nameScoreFactor); appReasons.push(`name contains "${app.name}"${nameScoreFactor < 1 ? ' (demoted — higher-fidelity strategy active)' : ''}`)
        }
        // Bonus: resource group name matches app name — structural corroboration
        if (infraRg && (infraRg === appNameLow || infraRg.includes(appNameLow) || appNameLow.includes(infraRg))) {
          appScore += 15; appReasons.push(`Resource Group "${infraRg}" matches app name`)
        }
        if (tagOwner && tagOwner === appOwnerLow) {
          appScore += 15; appReasons.push(`tag "owner" = "${app.owner}"`)
        } else if (tagOwner && (appOwnerLow.includes(tagOwner) || tagOwner.includes(appOwnerLow))) {
          appScore += 8;  appReasons.push(`tag "owner" ≈ "${app.owner}"`)
        }
        if (tagEnv && appEnvLow && tagEnv === appEnvLow) {
          appScore += 10; appReasons.push(`tag "env" = "${app.environment}"`)
        }
        if (tagTier && app.tier && String(app.tier) === tagTier) {
          appScore += 5;  appReasons.push(`tag "tier" = ${app.tier}`)
        }

        if (appScore < 10) continue

        for (const comp of app.components) {
          let compScore = appScore
          const compReasons = [...appReasons]
          const compNameLow = comp.name.toLowerCase()
          const compTypeLow = (comp.type || '').toLowerCase()

          if (tagComponent && tagComponent === compNameLow) {
            compScore += 30; compReasons.push(`tag "component" = "${comp.name}" (exact)`)
          } else if (tagComponent && (compNameLow.includes(tagComponent) || tagComponent.includes(compNameLow))) {
            compScore += 20; compReasons.push(`tag "component" ≈ "${comp.name}" (partial)`)
          } else if (infraNameLow.includes(compNameLow) || compNameLow.split('-').some(w => infraNameLow.includes(w) && w.length > 2)) {
            compScore += Math.round(10 * nameScoreFactor); compReasons.push(`name contains "${comp.name}"${nameScoreFactor < 1 ? ' (demoted)' : ''}`)
          }
          if (likelyCompTypes.includes(compTypeLow)) {
            compScore += Math.round(5 * nameScoreFactor); compReasons.push(`resource type suits ${comp.type} component${nameScoreFactor < 1 ? ' (demoted)' : ''}`)
          }

          const finalScore = Math.min(100, compScore)
          if (finalScore >= parseInt(minScore)) {
            scored.push({
              infraId:         infra.id,
              componentId:     comp.id,
              componentName:   comp.name,
              applicationId:   app.id,
              applicationName: app.name,
              score:           finalScore,
              confidence:      finalScore >= 70 ? 'high' : finalScore >= 45 ? 'medium' : 'low',
              reasons:         compReasons,
            })
          }
        }

        if (!app.components.length || scored.filter(s => s.applicationId === app.id && s.componentId).length === 0) {
          const finalScore = Math.min(100, appScore)
          if (finalScore >= parseInt(minScore)) {
            scored.push({
              infraId:         infra.id,
              componentId:     null,
              componentName:   null,
              applicationId:   app.id,
              applicationName: app.name,
              score:           finalScore,
              confidence:      finalScore >= 70 ? 'high' : finalScore >= 45 ? 'medium' : 'low',
              reasons:         appReasons,
              noComponent:     true,
            })
          }
        }
      }

      // ── Enrich suggestions with action types ─────────────────────────────
      // action: 'link_component'     — component exists, just link it
      // action: 'create_component'   — app exists, component doesn't; create + link
      // action: 'create_application' — neither app nor component exist; create both

      const enriched = scored.map(s => {
        let action, actionLabel
        if (s.componentId) {
          action = 'link_component'
          actionLabel = `Link to ${s.componentName} in ${s.applicationName}`
        } else if (s.applicationId) {
          action = 'create_component'
          actionLabel = `Create component "${tagComponent || infra.name}" in ${s.applicationName}`
        } else {
          // Infra-only resources (VNets, subnets) should never create their own application
          if (isInfraOnly) return null
          action = 'create_application'
          actionLabel = `Create application "${s.applicationName}" with component "${tagComponent || infra.name}"`
        }
        return { ...s, action, actionLabel }
      }).filter(Boolean)

      // ── If tagApp doesn't match any existing app, suggest creating one ──
      if (tagApp && !isInfraOnly) {
        const appExists = apps.some(a => a.name.toLowerCase() === tagApp)
        if (!appExists && !enriched.some(s => s.action === 'create_application')) {
          const newAppName  = tagApp.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
          const newCompName = tagComponent
            ? tagComponent.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
            : infra.name
          enriched.unshift({
            infraId:         infra.id,
            componentId:     null,
            componentName:   newCompName,
            applicationId:   null,
            applicationName: newAppName,
            score:           85,   // high confidence — exact tag match
            confidence:      'high',
            reasons:         [`tag "application" = "${newAppName}" — not yet in AppCloud`],
            action:          'create_application',
            actionLabel:     `Create application "${newAppName}" with component "${newCompName}"`,
            newAppName,
            newCompName,
            suggestedTier:   tagTier ? parseInt(tagTier) || 1 : 1,
            suggestedEnv:    tagEnv  || 'production',
            suggestedOwner:  tagOwner || '',
          })
        }
      }

      if (enriched.length > 0) {
        enriched.sort((a, b) => b.score - a.score)
        suggestions.push({
          infra: {
            id:           infra.id,
            name:         infra.name,
            provider:     infra.provider,
            resourceType: infra.resource_type,
            region:       infra.region,
            tags,
            raw,
          },
          suggestions:    enriched.slice(0, 4),
          topScore:       enriched[0].score,
          topConfidence:  enriched[0].confidence,
        })
      }
    }

    const grouped = []
    const appNameIndex = {}  // appName (lowercase) → index in grouped[]
 
    for (const s of suggestions) {
      const top = s.suggestions[0]
 
      if (top?.action === 'create_application' && !top.applicationId) {
        // This is a "new app" suggestion — group by target app name
        const key = (top.newAppName || top.applicationName || '').toLowerCase()
 
        if (appNameIndex[key] !== undefined) {
          // Add this infra + its component to the existing group card
          const existing = grouped[appNameIndex[key]]
          existing.infra.push(s.infra)
          existing.components.push({
            infraId:   top.infraId,
            infraName: s.infra.name,
            compName:  top.newCompName || s.infra.name,
          })
          // Keep the highest score
          if (s.topScore > existing.topScore) {
            existing.topScore      = s.topScore
            existing.topConfidence = s.topConfidence
          }
        } else {
          // First time we see this app name — create the group card
          appNameIndex[key] = grouped.length
          grouped.push({
            // grouped card has infra[] (array) instead of infra (object)
            // so the UI knows this is a multi-resource card
            grouped:        true,
            appName:        top.newAppName || top.applicationName,
            infra:          [s.infra],
            components:     [{
              infraId:   top.infraId,
              infraName: s.infra.name,
              compName:  top.newCompName || s.infra.name,
            }],
            suggestion:     top,          // representative suggestion for metadata
            topScore:       s.topScore,
            topConfidence:  s.topConfidence,
            action:         'create_application',
            suggestedTier:  top.suggestedTier  || 1,
            suggestedEnv:   top.suggestedEnv   || 'production',
            suggestedOwner: top.suggestedOwner || '',
            reasons:        top.reasons,
          })
        }
      } else {
        // link_component / create_component suggestions are per-infra; keep as-is
        grouped.push(s)
      }
    }
 
    // Sort by top score descending
    grouped.sort((a, b) => b.topScore - a.topScore)
 
    return {
      suggestions: grouped,
      ...(activeStrategy ? { strategy: activeStrategy } : {}),
      diagnostic: {
        unmappedInfra:    infraRecords.length,
        applications:     apps.length,
        withSuggestions:  grouped.length,
        belowThreshold:   infraRecords.length - grouped.length,
        minScore:         parseInt(minScore),
        ...(activeStrategy ? { strategy: activeStrategy.id, nameScoreFactor } : {}),
        message: grouped.length === 0
          ? `Found ${infraRecords.length} unmapped resource(s) and ${apps.length} application(s) but no matches above score ${minScore}. Try lowering the minimum score or adding appcloud:app / appcloud-app tags to your cloud resources.`
          : `Found ${grouped.length} suggestion(s) from ${infraRecords.length} unmapped resource(s)`,
      }
    }
  })

  // ── POST /discovery/suggest/apply ────────────────────────────────────────
  // Applies confirmed mapping suggestions — creates :CONNECTS_TO {via:'component-mapping'} edges.
  // Body: { mappings: [{ infraId, componentId }] }

  fastify.post('/suggest/apply', {
    schema: {
      summary:     'Apply a batch of confirmed mappings (legacy single-action endpoint)',
      description: 'Each mapping creates a `:CONNECTS_TO {via:"component-mapping", source:"auto-mapped"}` edge. For mixed-action batches (link + create-component + create-application), use `/discovery/suggest/apply-all`.',
      body: { type: 'object', required: ['mappings'], additionalProperties: true, properties: {
        mappings: { type: 'array', items: { type: 'object', required: ['infraId', 'componentId'], additionalProperties: true } },
      } },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const { mappings = [] } = req.body || {}
    if (!mappings.length) return reply.badRequest('mappings array is required')

    const results = { applied: 0, skipped: 0, errors: [] }

    for (const { infraId, componentId } of mappings) {
      if (!infraId || !componentId) { results.skipped++; continue }
      try {
        const r = await write(`
          MATCH (c:Component {id: $componentId}), (i:Infra {id: $infraId})
          MERGE (c)-[rel:CONNECTS_TO {via: 'component-mapping'}]->(i)
          ON CREATE SET rel.discovered_at = datetime(),
                        rel.source        = 'auto-mapped',
                        rel.confidence    = 80,
                        rel.evidence      = 'manual mapping confirmation'
          SET rel.last_seen = datetime()
          RETURN c.name AS comp, i.name AS infra
        `, { componentId, infraId })
        if (r.length) {
          results.applied++
          audit(actor(req), 'create', 'Infra', infraId,
            r[0].get('infra'), { componentId, source: 'auto-mapped' })
        } else {
          results.errors.push(`${infraId}: component or infra not found`)
        }
      } catch (err) {
        results.errors.push(`${infraId}: ${err.message}`)
      }
    }

    return results
  })

  // ── POST /discovery/suggest/apply-all ────────────────────────────────────
  // Handles all action types from the suggest engine in a single call:
  //   link_component     — MERGE :CONNECTS_TO {via:'component-mapping'} between existing component + infra
  //   create_component   — create Component under existing Application + link infra
  //   create_application — create Application + Component + link infra
  //
  // Body: { actions: [{ action, infraId, componentId?, applicationId?,
  //                     newAppName?, newCompName?, suggestedTier?,
  //                     suggestedEnv?, suggestedOwner? }] }

  fastify.post('/suggest/apply-all', {
    schema: {
      summary:     'Apply a mixed-action batch from the suggest engine',
      description: 'Three action shapes share one endpoint:\n- `link_component` — link existing Component to existing Infra\n- `create_component` — create a Component under an existing Application + link\n- `create_application` — create Application + Component(s) + link\n\nPhase 2 also runs after the batch: tag-based auto-link sweeps any still-unmapped Infra against the newly-created components.',
      body:     SuggestApplyAllBodySchema,
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const { actions = [] } = req.body || {}
    if (!actions.length) return reply.badRequest('actions array is required')

    const results = {
      linked: 0, componentsCreated: 0, applicationsCreated: 0,
      skipped: 0, errors: []
    }

    for (const action of actions) {
      try {
        const { infraId } = action
        if (!infraId) { results.skipped++; continue }

        if (action.action === 'link_component') {
          // ── Link existing component to infra ──────────────────────────
          if (!action.componentId) { results.skipped++; continue }
          const r = await write(`
            MATCH (c:Component {id: $componentId}), (i:Infra {id: $infraId})
            MERGE (c)-[rel:CONNECTS_TO {via: 'component-mapping'}]->(i)
            ON CREATE SET rel.discovered_at = datetime(),
                          rel.source        = 'auto-mapped',
                          rel.confidence    = 80,
                          rel.evidence      = 'link_component action'
            SET rel.last_seen = datetime()
            RETURN c.name AS comp, i.name AS infra
          `, { componentId: action.componentId, infraId })
          if (r.length) {
            results.linked++
            audit(actor(req), 'create', 'Infra', infraId, r[0].get('infra'),
              { componentId: action.componentId, source: 'auto-mapped' })
          }

        } else if (action.action === 'create_component') {
          // ── Create component under existing app + link infra ──────────
          if (!action.applicationId || !action.newCompName) { results.skipped++; continue }
          const compName = action.newCompName
          const r = await write(`
            MATCH (a:Application {id: $appId}), (i:Infra {id: $infraId})
            CREATE (c:Component {
              id:          randomUUID(),
              name:        $compName,
              type:        $compType,
              description: $desc,
              createdAt:   datetime()
            })
            MERGE (a)-[:CONTAINS]->(c)
            MERGE (c)-[rel:CONNECTS_TO {via: 'component-mapping'}]->(i)
            ON CREATE SET rel.discovered_at = datetime(),
                          rel.source        = 'auto-created',
                          rel.confidence    = 80,
                          rel.evidence      = 'create_component action'
            SET rel.last_seen = datetime()
            RETURN c.id AS compId, c.name AS comp, i.name AS infra, a.name AS app
          `, {
            appId:   action.applicationId,
            infraId,
            compName,
            compType: action.suggestedType || 'service',
            desc:     `Auto-created from discovery: ${infraId}`,
          })
          if (r.length) {
            results.componentsCreated++
            results.linked++
            audit(actor(req), 'create', 'Component', r[0].get('compId'), compName,
              { applicationId: action.applicationId, source: 'auto-created', infraId })
          }

         } else if (action.action === 'create_application') {
          if (!action.newAppName) { results.skipped++; continue }
 
          const appName = action.newAppName
 
          // Normalise to a components array whether this is a grouped card
          // (action.components[]) or the old single-resource shape (action.infraId).
          const componentList = Array.isArray(action.components) && action.components.length
            ? action.components
            : [{
                infraId:  action.infraId,
                compName: action.newCompName || action.newAppName,
              }]
 
          for (const item of componentList) {
            const { infraId, compName } = item
            if (!infraId || !compName) { results.skipped++; continue }
 
            try {
              // MERGE on Application so repeated calls never create duplicates.
              // MERGE on Component (name + parent app) for the same reason.
              const r = await write(`
                MATCH (i:Infra {id: $infraId})
                MERGE (a:Application {name: $appName})
                  ON CREATE SET
                    a.id          = randomUUID(),
                    a.tier        = $tier,
                    a.environment = $env,
                    a.owner       = $owner,
                    a.createdAt   = datetime()
                MERGE (a)-[:CONTAINS]->(c:Component {name: $compName})
                  ON CREATE SET
                    c.id          = randomUUID(),
                    c.type        = $compType,
                    c.description = $desc,
                    c.createdAt   = datetime()
                MERGE (c)-[rel:CONNECTS_TO {via: 'component-mapping'}]->(i)
                  ON CREATE SET
                    rel.discovered_at = datetime(),
                    rel.source        = 'auto-created',
                    rel.confidence    = 80,
                    rel.evidence      = 'create_application action'
                RETURN a.id AS appId, c.id AS compId,
                       a.name AS app, c.name AS comp, i.name AS infra,
                       (a.createdAt = datetime()) AS appWasNew
              `, {
                infraId,
                appName,
                compName,
                tier:     action.suggestedTier  || 1,
                env:      action.suggestedEnv   || 'production',
                owner:    action.suggestedOwner || '',
                compType: action.suggestedType  || 'service',
                desc:     `Auto-created from discovery: ${infraId}`,
              })
 
              if (r.length) {
                results.applicationsCreated++
                results.componentsCreated++
                results.linked++
                audit(actor(req), 'create', 'Application', r[0].get('appId'), appName,
                  { source: 'auto-created', infraId })
                audit(actor(req), 'create', 'Component', r[0].get('compId'), compName,
                  { applicationId: r[0].get('appId'), source: 'auto-created', infraId })
              }
            } catch (err) {
              results.errors.push(`${infraId}: ${err.message}`)
            }
          }
        }
      } catch (err) {
        results.errors.push(`${action.infraId}: ${err.message}`)
      }
    }

    // ── Phase 2: Tag-based auto-link for remaining unmapped resources ────────
    // After Phase 1 created applications and components, sweep all still-unmapped
    // infra that has appcloud-app / appcloud-component tags and link them to the
    // matching Application → Component. Creates components if they don't exist.
    try {
      const stillUnmapped = await query(`
        MATCH (i:Infra)
        WHERE i.source = 'discovery'
          AND NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
        RETURN i
      `)

      if (stillUnmapped.length) {
        // Load all apps + components for matching
        const allApps = await query(`
          MATCH (a:Application)
          OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
          RETURN a.id AS appId, a.name AS appName,
                 collect(DISTINCT { id: c.id, name: c.name }) AS components
        `)
        const appLookup = {}  // lowercase name → { appId, appName, components: [{ id, name }] }
        for (const r of allApps) {
          const name = (r.get('appName') || '').toLowerCase()
          appLookup[name] = {
            appId:      r.get('appId'),
            appName:    r.get('appName'),
            components: (r.get('components') || []).filter(c => c.id),
          }
        }

        results.phase2Linked = 0
        results.phase2ComponentsCreated = 0

        for (const ir of stillUnmapped) {
          const i = ir.get('i').properties
          let tags = {}
          try { tags = typeof i.tags === 'string' ? JSON.parse(i.tags) : i.tags || {} } catch {}

          // Normalize tags
          const nt = {}
          for (const [k, v] of Object.entries(tags)) {
            const nk = k.toLowerCase().replace(/^appcloud[:-]/, '').replace(/^app[:-]/, '').replace(/-/g, '_').trim()
            if (!nt[nk]) nt[nk] = String(v || '').trim()
          }

          const tagApp  = nt.app || nt.application || nt.app_name || ''
          const tagComp = nt.component || nt.service || nt.component_name || ''
          if (!tagApp) continue

          const appEntry = appLookup[tagApp.toLowerCase()]
          if (!appEntry) continue

          const { appId, appName } = appEntry
          const existingComp = tagComp
            ? appEntry.components.find(c => c.name.toLowerCase() === tagComp.toLowerCase())
            : null

          try {
            if (existingComp) {
              // Component exists — just link
              await write(`
                MATCH (c:Component {id: $compId}), (i:Infra {id: $infraId})
                MERGE (c)-[rel:CONNECTS_TO {via: 'component-mapping'}]->(i)
                ON CREATE SET rel.discovered_at = datetime(),
                              rel.source        = 'auto-mapped-phase2',
                              rel.confidence    = 75,
                              rel.evidence      = 'phase2 tag-based auto-link'
                SET rel.last_seen = datetime()
              `, { compId: existingComp.id, infraId: i.id })
              results.phase2Linked++
            } else if (tagComp) {
              // Component doesn't exist — create under app + link
              const r = await write(`
                MATCH (a:Application {id: $appId}), (i:Infra {id: $infraId})
                MERGE (a)-[:CONTAINS]->(c:Component {name: $compName})
                ON CREATE SET c.id = randomUUID(), c.type = 'service', c.createdAt = datetime()
                MERGE (c)-[rel:CONNECTS_TO {via: 'component-mapping'}]->(i)
                ON CREATE SET rel.discovered_at = datetime(),
                              rel.source        = 'auto-mapped-phase2',
                              rel.confidence    = 75,
                              rel.evidence      = 'phase2 tag-based auto-link (new component)'
                SET rel.last_seen = datetime()
                RETURN c.id AS compId
              `, { appId, infraId: i.id, compName: tagComp })
              if (r.length) {
                results.phase2ComponentsCreated++
                results.phase2Linked++
                // Update local lookup so subsequent resources can find this component
                const newCompId = r[0].get('compId')
                appEntry.components.push({ id: newCompId, name: tagComp })
              }
            }
          } catch (err) {
            results.errors.push(`phase2 ${i.id}: ${err.message}`)
          }
        }
      }
    } catch (err) {
      results.errors.push(`phase2: ${err.message}`)
    }

    return results
  })

  // ── GET /discovery/resources/:id/refresh ─────────────────────────────────
  // Re-fetches tags and metadata for a single Infra node from the cloud API.
  // This picks up tags that were added manually after the last scan.

  fastify.get('/resources/:id/refresh', {
    schema: {
      summary:     'Refresh tags for a single Infra (currently a hint)',
      description: 'Per-resource refresh is not yet implemented — the response is a `hint` instructing the caller to run a full provider scan. Reserved for a future targeted fetch.',
      params:      IdParamSchema,
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const records = await query(
      `MATCH (i:Infra {id: $id}) RETURN i`, { id: req.params.id }
    )
    if (!records.length) return reply.notFound('Infra node not found')
    const infra = props(records[0].get('i'))

    // Re-run a targeted scan for just this resource's cloud account
    // by triggering the appropriate provider scan with the node's cloud_id
    const provider = infra.provider
    const cloudId  = infra.cloud_id

    if (!provider || !cloudId) {
      return reply.badRequest('Cannot refresh — missing provider or cloud_id')
    }

    // Load the matching cloud account credentials
    const accounts = await loadAccounts(provider)
    if (!accounts.length) {
      return { refreshed: false, reason: 'No configured cloud account for ' + provider }
    }

    // For now return the stored data with a note — full per-resource refresh
    // requires provider-specific describe calls (future enhancement)
    return {
      refreshed: false,
      reason: 'Per-resource tag refresh requires a full scan — run discovery scan to pick up new tags',
      infra: {
        ...infra,
        tags: (() => { try { return JSON.parse(infra.tags || '{}') } catch { return {} } })(),
      },
      hint: `Run: POST /discovery/scan/${provider} to refresh all ${provider} resources`
    }
  })

  // ── GET /discovery/resources — all discovered Infra nodes ─────────────
  fastify.get('/resources', {
    schema: {
      summary:     'List discovered Infra (with mapping status)',
      description: 'Filterable by `provider` and `resourceType`. Each row has `mapped: bool` indicating whether at least one Component owns it via `:CONNECTS_TO {via:"component-mapping"}`.',
      querystring: { type: 'object', properties: {
        provider:     { type: 'string', enum: ['aws', 'azure', 'gcp'] },
        resourceType: { type: 'string' },
        limit:        { type: ['integer', 'string'], default: 200 },
      } },
      response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req) => {
    const { provider, resourceType, limit = 200 } = req.query
    const records = await query(`
      MATCH (i:Infra)
      WHERE i.source = 'discovery'
        ${provider     ? 'AND i.provider      = $provider'     : ''}
        ${resourceType ? 'AND i.resource_type = $resourceType' : ''}
      OPTIONAL MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN i,
             collect(DISTINCT c.name) AS components,
             collect(DISTINCT a.name) AS applications
      ORDER BY i.provider, i.resource_type, i.name
      LIMIT toInteger($limit)
    `, { provider, resourceType, limit: parseInt(limit) })

    return records.map(r => {
      const node = props(r.get('i'))
      // Parse stored JSON strings so callers get real objects, not strings
      const parseProp = (val) => {
        if (!val) return {}
        if (typeof val === 'object') return val
        try { return JSON.parse(val) } catch { return {} }
      }
      return {
        ...node,
        tags:         parseProp(node.tags),
        raw:          parseProp(node.raw),
        components:   r.get('components').filter(Boolean),
        applications: r.get('applications').filter(Boolean),
        mapped:       r.get('components').filter(Boolean).length > 0,
      }
    })
  })

  // ── GET /discovery/summary — counts by provider + resource type ────────
  fastify.get('/summary', {
    schema: {
      summary:     'Discovery summary — counts by provider and type',
      description: 'For each (provider, resource_type) pair, returns total + mapped count. Drives the discovery dashboard.',
      response: { 200: { type: 'object', additionalProperties: true, properties: {
        total:       { type: 'integer' },
        totalMapped: { type: 'integer' },
        unmapped:    { type: 'integer' },
        byProvider:  { type: 'object', additionalProperties: true },
      } } },
    },
  }, async () => {
    const records = await query(`
      MATCH (i:Infra) WHERE i.source = 'discovery'
      RETURN i.provider AS provider, i.resource_type AS type,
             count(i) AS cnt,
             count(CASE WHEN (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i) THEN 1 END) AS mapped
      ORDER BY provider, type
    `)
    const byProvider = {}
    let total = 0, totalMapped = 0
    for (const r of records) {
      const p   = r.get('provider')
      const t   = r.get('type')
      const cnt = serialize(r.get('cnt'))
      const mp  = serialize(r.get('mapped'))
      if (!byProvider[p]) byProvider[p] = { total: 0, mapped: 0, types: {} }
      byProvider[p].types[t] = { count: cnt, mapped: mp }
      byProvider[p].total   += cnt
      byProvider[p].mapped  += mp
      total      += cnt
      totalMapped += mp
    }
    return { total, totalMapped, unmapped: total - totalMapped, byProvider }
  })

  // ── POST /discovery/link — link an Infra node to a Component ─────────
  fastify.post('/link', {
    schema: {
      summary:     'Manually link an Infra to a Component',
      description: 'Idempotent MERGE of `:CONNECTS_TO {via:"component-mapping", source:"manual-link", confidence:100}`. Use this when the suggest engine missed a mapping.',
      body: { type: 'object', required: ['infraId', 'componentId'], additionalProperties: true, properties: {
        infraId:     { type: 'string', format: 'uuid' },
        componentId: { type: 'string', format: 'uuid' },
      } },
      response: { 200: { type: 'object', additionalProperties: true }, 400: StandardErrorResponses[400] },
    },
  }, async (req, reply) => {
    const { infraId, componentId } = req.body
    if (!infraId || !componentId) return reply.badRequest('infraId and componentId required')
    await write(`
      MATCH (i:Infra {id: $infraId}), (c:Component {id: $componentId})
      MERGE (c)-[rel:CONNECTS_TO {via: 'component-mapping'}]->(i)
      ON CREATE SET rel.discovered_at = datetime(),
                    rel.source        = 'manual-link',
                    rel.confidence    = 100,
                    rel.evidence      = 'manual link via /discovery/link'
      ON MATCH  SET rel.last_seen = datetime()
    `, { infraId, componentId })
    audit(actor(req), 'link', 'Infra', infraId, infraId, { componentId })
    return { linked: true, infraId, componentId }
  })

  // ── DELETE /discovery/resources/:id — remove a discovered resource ────
  fastify.delete('/resources/:id', {
    schema: {
      summary:     'Delete a discovered Infra resource',
      description: 'Refuses (409) when any Component owns the Infra. Unlink first via `DELETE` on the owning Component\'s connection or use `/discovery/resources/bulk-delete` with explicit confirmation.',
      params:      IdParamSchema,
      response: { 204: { type: 'null' }, 404: StandardErrorResponses[404], 409: StandardErrorResponses[409] },
    },
  }, async (req, reply) => {
    const pre = await query(
      `MATCH (i:Infra {id:$id}) WHERE i.source = 'discovery'
       OPTIONAL MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
       RETURN i.name AS name, i.provider AS provider,
              count(c) AS linkedComponents`,
      { id: req.params.id }
    )
    if (!pre.length) return reply.notFound('Resource not found')

    const linked = pre[0].get('linkedComponents')
    const count  = typeof linked === 'object' ? linked.toNumber?.() ?? 0 : linked ?? 0

    if (count > 0) {
      return reply.conflict(
        `Cannot delete — resource is linked to ${count} component(s). Unlink first.`
      )
    }

    await write(`
      MATCH (i:Infra {id: $id}) WHERE i.source = 'discovery'
      DETACH DELETE i
    `, { id: req.params.id })
    audit(actor(req), 'delete', 'Infra', req.params.id,
      pre[0]?.get('name') || req.params.id,
      { source: 'discovery', provider: pre[0]?.get('provider') })
    reply.code(204)
  })

  // ── DELETE /discovery/resources/bulk ─────────────────────────────────────
  // Delete multiple resources at once.
  // Skips any that are linked to components.
  // Body: { ids: [string] }

  fastify.post('/resources/bulk-delete', {
    schema: {
      summary:     'Delete multiple Infra resources by id',
      description: 'Per-id behavior matches `DELETE /discovery/resources/:id`: linked Infra is skipped (with reason), unlinked is removed. The response details deleted / skipped / errored.',
      body: { type: 'object', required: ['ids'], additionalProperties: true, properties: {
        ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      } },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const { ids = [] } = req.body || {}
    if (!ids.length) return reply.badRequest('ids array is required')

    const results = { deleted: 0, skipped: [], errors: [] }

    for (const id of ids) {
      try {
        const pre = await query(
          `MATCH (i:Infra {id:$id}) WHERE i.source = 'discovery'
           OPTIONAL MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
           RETURN i.name AS name, count(c) AS linkedComponents`,
          { id }
        )
        if (!pre.length) { results.skipped.push({ id, reason: 'not found' }); continue }

        const linked = pre[0].get('linkedComponents')
        const count  = typeof linked === 'object' ? linked.toNumber?.() ?? 0 : linked ?? 0

        if (count > 0) {
          results.skipped.push({
            id,
            name:   pre[0].get('name'),
            reason: `linked to ${count} component(s)`
          })
          continue
        }

        await write(
          `MATCH (i:Infra {id: $id}) WHERE i.source = 'discovery' DETACH DELETE i`,
          { id }
        )
        audit(actor(req), 'delete', 'Infra', id, pre[0].get('name'),
          { source: 'bulk-delete' })
        results.deleted++
      } catch (err) {
        results.errors.push({ id, error: err.message })
      }
    }

    return results
  })

  //bootstrap
  // Accepts optional body { strategy } to record which strategy drove the bootstrap.
  // The bootstrap itself always uses tag/RG/name heuristics — the strategy param
  // is advisory metadata so callers can chain: enrich(strategy) → bootstrap → suggest.
  fastify.post('/bootstrap', {
    schema: {
      summary:     'Run bootstrap (tag + RG-propagation auto-link) without scanning',
      description: 'Useful when you\'ve added/edited tags in the cloud and want to re-derive Application/Component mappings without paying for a full scan. Episode-tracked.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req) => {
    const { strategy } = req.body || {}
    const result = await bootstrapDiscovery(fastify)
    const strat = strategy ? AZURE_LINKING_STRATEGIES.find(s => s.id === strategy) : null
    return { ...result, ...(strat ? { strategy: strat } : {}) }
  })

  // ── GET /discovery/linking-strategies ────────────────────────────────────
  // Returns available Azure linking strategies ranked by priority.
  // The UI can display these so users pick the strategy that matches their
  // environment's permissions and cost tolerance.
  fastify.get('/linking-strategies', {
    schema: {
      summary:     'Linking strategy catalog (Azure)',
      description: 'Returns the available enrichment strategies for Azure (resource-graph / network-watcher / monitor-insights / tagging / azure-arc / name-heuristics) with descriptions, required permissions, and token cost. Drives the strategy selector in `/discovery/enrich/azure`.',
      response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req) => {
    const { provider = 'azure' } = req.query
    if (provider !== 'azure') {
      return { strategies: [], message: `No linking strategies defined for provider "${provider}" yet.` }
    }
    return {
      provider: 'azure',
      strategies: AZURE_LINKING_STRATEGIES,
      recommended: 'resource-graph',
      note: 'Strategies are ranked from highest fidelity / lowest cost to lowest. Name-based heuristics should only be used as a last resort.',
    }
  })

  // ── POST /discovery/enrich/azure ────────────────────────────────────────
  // Runs Azure enrichment using the selected linking strategy.
  //
  // Body:
  //   strategy     — strategy id from AZURE_LINKING_STRATEGIES (default: 'resource-graph')
  //   accountId    — (optional) specific cloud account id to use
  //   workspaceId  — (optional) Log Analytics workspace id (required for monitor-insights)
  //   autoLink     — (optional) boolean, default true — run Phase 2 auto-linking
  //   minScore     — (optional) 0-100, default 60 — auto-link confidence threshold
  fastify.post('/enrich/azure', {
    schema: {
      summary:     'Run Azure supplement layers (Network Watcher / VM Insights / auto-link)',
      description: 'Invokes one of the named strategies from `/discovery/linking-strategies` against the configured Azure account. Idempotent — safe to re-run. `monitor-insights` requires a Log Analytics workspace ID; `network-watcher` requires Network Watcher Reader.',
      body: { type: 'object', additionalProperties: true, properties: {
        strategy:    { type: 'string', enum: ['resource-graph', 'network-watcher', 'monitor-insights', 'tagging', 'azure-arc', 'name-heuristics'] },
        accountId:   { type: 'string' },
        workspaceId: { type: 'string', description: 'Log Analytics workspace resource id (monitor-insights)' },
        autoLink:    { type: 'boolean', default: true },
        minScore:    { type: 'integer', minimum: 0, maximum: 100, default: 60 },
      } },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const {
      strategy    = 'resource-graph',
      accountId,
      workspaceId,
      autoLink    = true,
      minScore    = 60,
    } = req.body || {}

    const strat = AZURE_LINKING_STRATEGIES.find(s => s.id === strategy)
    if (!strat) {
      return reply.badRequest(`Unknown strategy "${strategy}". Valid: ${AZURE_LINKING_STRATEGIES.map(s => s.id).join(', ')}`)
    }

    // For name-heuristics or tagging-only strategies, delegate to bootstrap
    if (strategy === 'name-heuristics') {
      const result = await bootstrapDiscovery(fastify)
      return {
        strategy: strat,
        method:   'bootstrap',
        ...result,
        note:     'Name-based heuristics is the lowest-confidence strategy. Consider using resource-graph or tagging for better results.',
      }
    }

    if (strategy === 'tagging') {
      const result = await bootstrapDiscovery(fastify)
      return {
        strategy: strat,
        method:   'bootstrap-tags',
        ...result,
      }
    }

    // For Azure Arc — scan Arc-projected resources via Resource Graph, then enrich
    if (strategy === 'azure-arc') {
      // Arc resources are surfaced through Resource Graph with special types
      const accounts = await loadAccounts('azure')
      const target   = accountId ? accounts.find(a => a.id === accountId || a.name === accountId) : accounts[0]
      if (!target) return reply.badRequest('No Azure account configured. Add one via POST /integrations/cloud first.')

      const cfg  = target.config || {}
      const cred = await azureCredential(cfg)
      const subId = cfg.subscriptionId

      // Scan Arc resources first
      try {
        const { ResourceGraphClient } = await import('@azure/arm-resourcegraph')
        const rgClient = new ResourceGraphClient(cred)
        const arcResult = await rgClient.resources({
          subscriptions: [subId],
          query: `
            Resources
            | where type in~ (
                'microsoft.hybridcompute/machines',
                'microsoft.kubernetes/connectedclusters',
                'microsoft.azurearcdata/sqlmanagedinstances',
                'microsoft.azurearcdata/postgresinstances'
              )
            | project id, name, type, resourceGroup, location, tags, properties
          `,
        })
        const arcResources = arcResult.data || []
        fastify.log.info(`[Azure Arc] Found ${arcResources.length} Arc-projected resources`)

        let arcLinked = 0
        for (const res of arcResources) {
          const arcType = (res.type || '').toLowerCase()
          let resourceType = 'arc_resource'
          if (arcType.includes('machines'))             resourceType = 'arc_server'
          if (arcType.includes('connectedclusters'))    resourceType = 'arc_kubernetes'
          if (arcType.includes('sqlmanagedinstances'))  resourceType = 'arc_sql'
          if (arcType.includes('postgresinstances'))    resourceType = 'arc_postgres'

          await upsert({
            cloudId:      res.id,
            name:         res.name,
            provider:     'azure',
            resourceType,
            region:       res.location || '',
            status:       res.properties?.status || 'connected',
            tags:         res.tags || {},
            raw:          { ...res.properties, resourceGroup: res.resourceGroup, arcType: res.type },
          })
          arcLinked++
        }

        // Then enrich structural relationships
        const enrichResult = await supplementAzureDiscovery({
          cred, subId, write, query, log: fastify.log,
          layers: strat.layers, autoLink, minScore,
        })

        return {
          strategy:      strat,
          arcDiscovered: arcLinked,
          enrichment:    enrichResult,
        }
      } catch (err) {
        return reply.internalServerError(`Azure Arc enrichment failed: ${err.message}`)
      }
    }

    // Structural strategies: resource-graph, network-watcher, monitor-insights
    const accounts = await loadAccounts('azure')
    const target   = accountId ? accounts.find(a => a.id === accountId || a.name === accountId) : accounts[0]
    if (!target) return reply.badRequest('No Azure account configured. Add one via POST /integrations/cloud first.')

    const cfg   = target.config || {}
    const cred  = await azureCredential(cfg)
    const subId = cfg.subscriptionId

    if (strategy === 'monitor-insights' && !workspaceId && !cfg.logAnalyticsWorkspaceId) {
      return reply.badRequest('monitor-insights strategy requires a workspaceId (Log Analytics workspace resource id).')
    }

    try {
      const result = await supplementAzureDiscovery({
        cred,
        subId,
        write,
        query,
        log:         fastify.log,
        workspaceId: workspaceId || cfg.logAnalyticsWorkspaceId,
        layers:      strat.layers,
        autoLink,
        minScore,
      })

      audit(actor(req), 'enrich', 'CloudAccount', target.id, target.name, {
        strategy, layers: strat.layers, ...result,
      })

      return {
        strategy: strat,
        account:  target.name,
        ...result,
      }
    } catch (err) {
      return reply.internalServerError(`Azure enrichment failed (${strategy}): ${err.message}`)
    }
  })
}