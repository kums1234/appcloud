/**
 * discovery.autolink.js
 *
 * Cross-cloud auto-link Phase 2.
 *
 * Consumes the structural graph populated by a primary scanner +
 * supplement layers, then infers Component → Infra ownership using
 * three layered rules:
 *
 *   Rule 1 — Co-location
 *     All Infra in the same co-location bucket (resource group for
 *     Azure, project for GCP, account+region for AWS) that have a
 *     mapped Component vote for that Component.
 *       • ratio == 1.0 → score 85 (`{label}-unanimous`)
 *       • ratio >= 0.5 → score 70 (`{label}-majority`)
 *
 *   Rule 2 — Direct structural 1-hop
 *     If the unmapped Infra is connected (via any structural CONNECTS_TO
 *     edge whose `via` is not 'component-mapping') to a mapped Infra,
 *     score by the relationship type's coupling weight (`viaToScore`).
 *     Defaults to 60.
 *
 *   Rule 3 — 2-hop neighbourhood
 *     Only fires when Rules 1+2 yielded nothing >= minScore. Score is
 *     `min(58, 40 + paths * 6)`.
 *
 * Edge-write policy: single :CONNECTS_TO {via:'component-mapping'} edge
 * with `source: 'auto-link'`, `provider_source: <enrichmentSource>`
 * (e.g. 'azure-enrichment' for cross-cloud audit), `confidence`, `rule`,
 * `evidence`, `discovered_at` / `last_seen` timestamps.
 *
 * Was previously duplicated across discovery.azure.supplement.js and
 * discovery.gcp.supplement.js; extracted before AWS lands so slice 3
 * just plumbs in its own provider/co-location/via-score config rather
 * than copy-pasting a third near-identical implementation.
 */

/**
 * autoLinkFromStructure(opts)
 *
 * @param {object} opts
 * @param {string} opts.provider             'azure' | 'gcp' | 'aws'
 * @param {(cid:string)=>string} opts.coLocationFromCloudId
 *        Extracts the co-location bucket key from a cloud_id.
 *        Returns lowercase string or '' if not derivable.
 * @param {string} opts.coLocationLabel       'resource-group' | 'project' | 'account-region'
 *        Used in rule names ('{label}-unanimous', '{label}-majority').
 * @param {Record<string, number>} opts.viaToScore
 *        Rule 2 lookup. Unknown vias default to 60.
 * @param {string} opts.enrichmentSource      'azure-enrichment' | 'gcp-enrichment' | 'aws-enrichment'
 *        Stored on the edge as `provider_source` so per-cloud audits
 *        can attribute auto-link decisions to the supplement that wrote them.
 * @param {Function} opts.write               Neo4j write fn
 * @param {Function} opts.query               Neo4j query fn
 * @param {object}   opts.log                 Fastify logger (info/warn/debug)
 * @param {number}   [opts.minScore=60]       Auto-apply threshold; below this → suggestions.
 *
 * @returns {Promise<{linked:number, suggestions:Array, errors:Array<string>}>}
 */
export async function autoLinkFromStructure({
  provider,
  coLocationFromCloudId,
  coLocationLabel,
  viaToScore,
  enrichmentSource,
  write,
  query,
  log,
  minScore = 60,
}) {
  if (!provider)               throw new Error('autoLinkFromStructure: provider is required')
  if (!coLocationFromCloudId)  throw new Error('autoLinkFromStructure: coLocationFromCloudId is required')
  if (!coLocationLabel)        throw new Error('autoLinkFromStructure: coLocationLabel is required')
  if (!viaToScore)             throw new Error('autoLinkFromStructure: viaToScore is required')
  if (!enrichmentSource)       throw new Error('autoLinkFromStructure: enrichmentSource is required')

  const stats = { linked: 0, suggestions: [], errors: [] }
  const tag   = `[${provider.toUpperCase()} AutoLink]`

  const unmappedRows = await query(`
    MATCH (i:Infra)
    WHERE i.provider = $provider
      AND i.source = 'discovery'
      AND NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
    RETURN i.id AS infraId, i.name AS name, i.cloud_id AS cloudId,
           i.resource_type AS rtype, i.raw AS raw, i.tags AS tags
  `, { provider })

  if (!unmappedRows.length) {
    log.info?.(`${tag} No unmapped ${provider} infra nodes, skipping`)
    return stats
  }

  log.info?.(`${tag} ${unmappedRows.length} unmapped ${provider} nodes to process`)

  // Co-location bucket → [{ compId, compName, rtype }] of already-mapped Infra
  const colocMappedRows = await query(`
    MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i:Infra)
    WHERE i.provider = $provider AND i.cloud_id IS NOT NULL
    RETURN i.cloud_id AS cid, c.id AS compId, c.name AS compName,
           i.resource_type AS rtype
  `, { provider })

  const bucketToMapped = {}
  for (const r of colocMappedRows) {
    const bucket = coLocationFromCloudId(r.get('cid'))
    if (!bucket) continue
    if (!bucketToMapped[bucket]) bucketToMapped[bucket] = []
    bucketToMapped[bucket].push({
      compId:   r.get('compId'),
      compName: r.get('compName'),
      rtype:    r.get('rtype'),
    })
  }

  for (const row of unmappedRows) {
    const infraId = row.get('infraId')
    const rtype   = row.get('rtype') || ''
    const cloudId = row.get('cloudId') || ''
    const bucket  = coLocationFromCloudId(cloudId)

    const candidates = []

    // Rule 1 — Co-location
    if (bucket && bucketToMapped[bucket]?.length) {
      const compFreq = {}
      for (const m of bucketToMapped[bucket]) {
        compFreq[m.compId] = compFreq[m.compId] || { count: 0, compName: m.compName }
        compFreq[m.compId].count++
      }
      const total = bucketToMapped[bucket].length
      for (const [compId, { count, compName }] of Object.entries(compFreq)) {
        const ratio = count / total
        if (ratio >= 1.0) {
          candidates.push({ compId, compName, score: 85, rule: `${coLocationLabel}-unanimous`, bucket })
        } else if (ratio >= 0.5) {
          candidates.push({ compId, compName, score: 70, rule: `${coLocationLabel}-majority`, bucket })
        }
      }
    }

    // Rule 2 — Direct structural 1-hop. Filters out the
    // component-mapping edge so the autoLink doesn't treat one Component's
    // existing ownership as a structural neighbour signal for another node.
    const directRows = await query(`
      MATCH (unmapped:Infra {id: $infraId})-[r:CONNECTS_TO]-(mapped:Infra)
      WHERE r.via <> 'component-mapping'
        AND (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(mapped)
      MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(mapped)
      RETURN c.id AS compId, c.name AS compName, r.via AS via
      LIMIT 10
    `, { infraId })

    for (const r of directRows) {
      const via = r.get('via') || ''
      const score = viaToScore[via] ?? 60
      candidates.push({
        compId:   r.get('compId'),
        compName: r.get('compName'),
        score,
        rule:     `direct-${via}`,
      })
    }

    // Rule 3 — 2-hop neighbourhood (only if 1+2 produced nothing above
    // threshold). The variable-length path is constrained to structural
    // edges (`r.via <> 'component-mapping'`) so the walk doesn't hop
    // through a mapped Component into a different Infra cluster.
    const hasHighConf = candidates.some(c => c.score >= minScore)
    if (!hasHighConf) {
      const hopRows = await query(`
        MATCH (unmapped:Infra {id: $infraId})-[rels:CONNECTS_TO*1..2]-(mapped:Infra)
        WHERE ALL(r IN rels WHERE r.via <> 'component-mapping')
          AND (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(mapped)
        MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(mapped)
        RETURN c.id AS compId, c.name AS compName, count(*) AS paths
        ORDER BY paths DESC
        LIMIT 5
      `, { infraId })
      for (const r of hopRows) {
        const paths = typeof r.get('paths') === 'object'
          ? r.get('paths').toNumber?.() ?? 1 : r.get('paths') ?? 1
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

    // Dedup: keep highest-scoring candidate per Component
    const deduped = {}
    for (const c of candidates) {
      if (!deduped[c.compId] || c.score > deduped[c.compId].score) deduped[c.compId] = c
    }
    const best = Object.values(deduped).sort((a, b) => b.score - a.score)[0]
    if (!best) continue

    if (best.score >= minScore) {
      try {
        const params = {
          compId:   best.compId,
          infraId,
          rule:     best.rule,
          score:    best.score,
          // `enrichmentSource` (e.g., 'azure-enrichment') is preserved on
          // the edge as `provider_source` so per-cloud audits can still
          // distinguish which supplement wrote each auto-link edge.
          providerSource: enrichmentSource,
          evidence: `auto-link (${best.rule})`,
        }
        await write(`
          MATCH (c:Component {id: $compId}), (i:Infra {id: $infraId})
          MERGE (c)-[rel:CONNECTS_TO {via: 'component-mapping'}]->(i)
          ON CREATE SET rel.discovered_at = datetime(),
                        rel.source          = 'auto-link',
                        rel.provider_source = $providerSource,
                        rel.confidence      = $score,
                        rel.rule            = $rule,
                        rel.evidence        = $evidence
          ON MATCH  SET rel.last_seen       = datetime(),
                        rel.provider_source = $providerSource,
                        rel.confidence      = $score,
                        rel.rule            = $rule,
                        rel.evidence        = $evidence
        `, params)
        stats.linked++
        log.debug?.(`${tag} Linked ${infraId} → ${best.compName} (${best.rule}, score ${best.score})`)
      } catch (err) {
        stats.errors.push(`autolink ${infraId}: ${err.message}`)
      }
    } else if (best.score >= 30) {
      stats.suggestions.push({
        infraId,
        name:     row.get('name'),
        rtype,
        compId:   best.compId,
        compName: best.compName,
        score:    best.score,
        rule:     best.rule,
      })
    }
  }

  log.info?.(`${tag} Auto-linked: ${stats.linked}, suggestions: ${stats.suggestions.length}`)
  return stats
}

// Cross-cloud `via→score` tables. Provider-specific scanners and
// supplements MUST use these values (or extend them) so a relationship's
// coupling weight stays consistent regardless of which cloud emitted it.

export const AZURE_VIA_TO_AUTOLINK_SCORE = {
  'nic':                  90,
  'disk':                 88,
  'app-service-plan':     85,
  'sql-server':           85,
  'redis-vnet-injection': 82,
  'vnet-integration':     80,
  'aks-node-subnet':      80,
  'lb-backend-nic':       75,
  'agw-subnet':           72,
  'contains':             70,    // Network Watcher Contains
  'subnet':               65,
  'associated':           60,    // Network Watcher Associated
  'nsg':                  55,
  'private-endpoint':     70,
  'keyvault-vnet-rule':   60,
  'observed-tcp':         75,    // VM Insights observed
  'monitors':             65,
}

export const GCP_VIA_TO_AUTOLINK_SCORE = {
  'subnet':           65,
  'network':          65,
  'disk':             88,
  'service-account':  60,
  'iam-binding':      60,
}
