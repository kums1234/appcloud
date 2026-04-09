import { INFRA_ONLY_TYPES, PLATFORM_TYPES, hasExplicitAppTag } from './discovery.schema.js'

export async function bootstrapDiscovery(fastify) {
  const { write, query } = fastify.neo4j

  function parse(val) {
    try { return typeof val === 'string' ? JSON.parse(val) : val || {} } catch { return {} }
  }

  /**
   * Resolve the application name for an infra node.
   *
   * Priority:
   *   1. Explicit tags  (app / application / workload / project)
   *   2. Azure Resource Group — stored in raw.resourceGroup at scan time
   *      for every Azure resource type (VM, AKS, SQL, App Service, Redis,
   *      VNet, and all generic ARM resources)
   *   3. First hyphen-segment of the resource name — last resort for AWS/GCP
   */
  function resolveAppName(tags = {}, name = '', raw = {}) {
    return (
      tags.app          ||
      tags.application  ||
      tags.workload     ||
      tags.project      ||
      (raw.resourceGroup ? raw.resourceGroup.toLowerCase() : null) ||
      name.split('-')[0] ||
      'default-app'
    )
  }

  /**
   * Infer a logical component role from resource type, name, and tags.
   *
   * Priority:
   *   1. Explicit tags  (component / role / service / tier)
   *   2. Full Azure resource type string
   *   3. AWS / GCP resource type keywords
   *   4. Resource name keywords
   */
  function inferComponent(type = '', name = '', tags = {}) {
    if (tags.component) return tags.component.toLowerCase()
    if (tags.role)      return tags.role.toLowerCase()
    if (tags.service)   return tags.service.toLowerCase()
    if (tags.tier)      return tags.tier.toLowerCase()

    const t = type.toLowerCase()
    const n = name.toLowerCase()

    // Azure
    if (t === 'microsoft.sql/servers')                               return 'database'
    if (t === 'microsoft.sql/servers/databases')                     return 'database'
    if (t === 'microsoft.dbforpostgresql/servers')                   return 'database'
    if (t === 'microsoft.dbformysql/servers')                        return 'database'
    if (t === 'microsoft.documentdb/databaseaccounts')               return 'database'
    if (t === 'microsoft.cache/redis')                               return 'cache'
    if (t === 'microsoft.web/sites' && n.includes('func'))           return 'function'
    if (t === 'microsoft.logic/workflows')                           return 'function'
    if (t === 'microsoft.web/sites')                                 return n.includes('api') ? 'api' : 'frontend'
    if (t === 'microsoft.apimanagement/service')                     return 'api-gateway'
    if (t === 'microsoft.containerservice/managedclusters')          return 'platform'
    if (t === 'microsoft.app/containerapps')                         return 'service'
    if (t === 'microsoft.network/applicationgateways')               return 'gateway'
    if (t === 'microsoft.network/loadbalancers')                     return 'gateway'
    if (t === 'microsoft.network/frontdoors')                        return 'gateway'
    if (t === 'microsoft.cdn/profiles')                              return 'gateway'
    if (t === 'microsoft.network/virtualnetworks')                   return 'network'
    if (t === 'microsoft.servicebus/namespaces')                     return 'queue'
    if (t === 'microsoft.eventhub/namespaces')                       return 'queue'
    if (t === 'microsoft.eventgrid/topics')                          return 'queue'
    if (t === 'microsoft.storage/storageaccounts')                   return 'storage'
    if (t === 'microsoft.insights/components')                       return 'observability'
    if (t === 'microsoft.keyvault/vaults')                           return 'secrets'
    if (t === 'microsoft.compute/virtualmachines') {
      if (n.includes('api'))                                         return 'api'
      if (n.includes('worker'))                                      return 'worker'
      if (n.includes('web'))                                         return 'frontend'
      if (n.includes('db') || n.includes('sql') || n.includes('mongo')) return 'database'
      if (n.includes('cache') || n.includes('redis'))                return 'cache'
      return 'service'
    }

    // AWS / GCP
    if (t.includes('rds')         || t.includes('cloud_sql'))        return 'database'
    if (t.includes('elasticache'))                                    return 'cache'
    if (t.includes('function')    || t.includes('lambda')
                                  || t.includes('cloud_run'))        return 'function'
    if (t.includes('load_balancer'))                                  return 'gateway'
    if (t.includes('cluster')     || t.includes('eks')
                                  || t.includes('gke')
                                  || t.includes('aks'))              return 'platform'
    if (t.includes('s3')          || t.includes('storage'))          return 'storage'

    // Name keywords
    if (n.includes('api'))                                            return 'api'
    if (n.includes('worker'))                                         return 'worker'
    if (n.includes('web'))                                            return 'frontend'
    if (n.includes('queue') || n.includes('bus'))                    return 'queue'
    if (n.includes('db')    || n.includes('sql') || n.includes('mongo')) return 'database'
    if (n.includes('cache') || n.includes('redis'))                  return 'cache'

    return 'service'
  }

  // ── Phase 1: tag/RG-based grouping for currently-unmapped infra ──────────
  const infraRecords = await query(`
    MATCH (i:Infra)
    WHERE i.source = 'discovery'
      AND NOT (:Component)-[:DEPLOYED_ON]->(i)
    RETURN i
  `)

  const groups = {}  // appName → [{ infraProps, componentName }]
  let skippedInfraOnly = 0

  for (const ir of infraRecords) {
    const i    = ir.get('i').properties
    const tags = parse(i.tags)
    const raw  = parse(i.raw)
    const name = (i.name || '').toLowerCase()
    const rtype = (i.resource_type || '').toLowerCase()

    // Infrastructure plumbing (VNets, subnets, app service plans) should
    // never create its own application. Skip it here — Phase 2 RG
    // propagation will link it to an existing app after workload resources
    // have been mapped.
    if (INFRA_ONLY_TYPES.has(rtype) && !hasExplicitAppTag(tags)) {
      skippedInfraOnly++; continue
    }

    const appName       = resolveAppName(tags, name, raw)
    const componentName = inferComponent(i.resource_type, name, tags)

    if (!groups[appName]) groups[appName] = []
    groups[appName].push({ infra: i, componentName })
  }

  let createdApps       = 0
  let createdComponents = 0
  let linked            = 0
  const skipped         = []

  for (const [appName, items] of Object.entries(groups)) {
    const appRes = await write(`
      MERGE (a:Application {name: $appName})
      ON CREATE SET a.id = randomUUID(), a.tier = 3
      RETURN a, (a.createdAt IS NULL) AS isNew
    `, { appName })

    const appNode  = appRes[0].get('a').properties
    const appId    = appNode.id
    const isNewApp = appRes[0].get('isNew')
    if (isNewApp) createdApps++

    for (const { infra, componentName } of items) {
      try {
        const compRes = await write(`
          MATCH (a:Application {id: $appId})
          MERGE (a)-[:CONTAINS]->(c:Component {name: $componentName})
          ON CREATE SET c.id = randomUUID()
          RETURN c, (c.id IS NOT NULL) AS created
        `, { appId, componentName })

        const compId    = compRes[0].get('c').properties.id
        const isNewComp = compRes[0].get('created')
        if (isNewComp) createdComponents++

        await write(`
          MATCH (c:Component {id: $compId})
          MATCH (i:Infra {id: $infraId})
          MERGE (c)-[rel:DEPLOYED_ON]->(i)
          ON CREATE SET rel.source = 'bootstrap', rel.mappedAt = datetime()
        `, { compId, infraId: infra.id })

        linked++
      } catch (err) {
        skipped.push({ infraId: infra.id, error: err.message })
      }
    }
  }

  // ── Phase 2: RG propagation — catch stragglers not covered by tags ────────
  //
  // After Phase 1, there may still be unmapped infra nodes that have no tags
  // and whose name didn't produce a useful group. If their Resource Group
  // contains already-mapped nodes that all (or mostly) share one Component,
  // we can confidently link them too.
  //
  // This handles the common case of shared infrastructure within a Resource
  // Group — e.g. a Key Vault, Storage Account, or App Insights instance
  // that has no tags but lives alongside tagged VMs in the same RG.

  let rgLinked = 0

  try {
    // Find all unmapped Azure infra nodes that have a resourceGroup in raw
    const stillUnmapped = await query(`
      MATCH (i:Infra)
      WHERE i.provider = 'azure'
        AND i.source = 'discovery'
        AND NOT (:Component)-[:DEPLOYED_ON]->(i)
        AND i.raw IS NOT NULL
      RETURN i.id AS infraId, i.raw AS raw, i.name AS name
    `)

    if (stillUnmapped.length) {
      // Build RG → dominant component map from already-mapped Azure nodes
      const rgDominantRows = await query(`
        MATCH (c:Component)-[:DEPLOYED_ON]->(i:Infra)
        WHERE i.provider = 'azure' AND i.raw IS NOT NULL
        MATCH (a:Application)-[:CONTAINS]->(c)
        RETURN i.raw AS raw, c.id AS compId, c.name AS compName,
               a.id AS appId, a.name AS appName
      `)

      // Build: resourceGroup → { compId → { compName, appId, appName, count } }
      const rgFreq = {}
      for (const r of rgDominantRows) {
        let raw = {}
        try { raw = JSON.parse(r.get('raw') || '{}') } catch {}
        const rg = (raw.resourceGroup || '').toLowerCase()
        if (!rg) continue
        const compId = r.get('compId')
        if (!rgFreq[rg]) rgFreq[rg] = {}
        if (!rgFreq[rg][compId]) {
          rgFreq[rg][compId] = {
            compId, compName: r.get('compName'),
            appId: r.get('appId'), appName: r.get('appName'), count: 0,
          }
        }
        rgFreq[rg][compId].count++
      }

      // For each RG, find the dominant component (>=60% share or unanimous)
      const rgDominant = {}
      for (const [rg, compMap] of Object.entries(rgFreq)) {
        const entries = Object.values(compMap)
        const total   = entries.reduce((s, e) => s + e.count, 0)
        const best    = entries.sort((a, b) => b.count - a.count)[0]
        if (best && best.count / total >= 0.6) {
          rgDominant[rg] = { ...best, ratio: best.count / total }
        }
      }

      // Link each still-unmapped node to its RG's dominant component
      for (const row of stillUnmapped) {
        let raw = {}
        try { raw = JSON.parse(row.get('raw') || '{}') } catch {}
        const rg = (raw.resourceGroup || '').toLowerCase()
        if (!rg || !rgDominant[rg]) continue

        const { compId, ratio } = rgDominant[rg]
        try {
          await write(`
            MATCH (c:Component {id: $compId}), (i:Infra {id: $infraId})
            MERGE (c)-[rel:DEPLOYED_ON]->(i)
            ON CREATE SET rel.source = 'bootstrap-rg-propagation',
                          rel.rgRatio = $ratio,
                          rel.mappedAt = datetime()
          `, { compId, infraId: row.get('infraId'), ratio })
          rgLinked++
        } catch (err) {
          skipped.push({ infraId: row.get('infraId'), error: err.message })
        }
      }
    }
  } catch (err) {
    // RG propagation is best-effort — never fail the whole bootstrap
    skipped.push({ phase: 'rg-propagation', error: err.message })
  }

  return {
    createdApps,
    createdComponents,
    linked:      linked + rgLinked,
    tagLinked:   linked,
    rgLinked,
    skippedInfraOnly,
    skipped:     skipped.length,
    total:       infraRecords.length,
    groups:      Object.keys(groups).length,
    completedAt: new Date().toISOString(),
  }
}