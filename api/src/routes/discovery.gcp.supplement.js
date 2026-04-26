/**
 * discovery.gcp.supplement.js
 *
 * Post-scan supplement for GCP discovery.
 *
 *   Layer — IAM Policy
 *     Pulls IAM bindings via CAI's IAM_POLICY contentType and writes
 *     `:CONNECTS_TO[via='iam-binding']` edges from the binding's
 *     principal (currently service accounts only) to the resource the
 *     policy is attached to. Also flips `public = true` on resources
 *     that have `allUsers` / `allAuthenticatedUsers` bindings — the
 *     authoritative source of GCS-bucket / Cloud-Run public access
 *     that the primary scanner cannot determine from RESOURCE alone.
 *
 *   Phase 2 — Auto-link (Component → Infra ownership)
 *     Uses the structural graph populated by the primary CAI scanner
 *     plus project co-location to infer which Component owns each
 *     Infra node. Mirrors the Azure supplement's autoLink, scoped to
 *     GCP nodes.
 *
 * Future supplement layers (out of slice-2 scope, see
 * `docs/discovery-native-graph-slices.md`): VPC flow logs (observed
 * flows), IAM Policy Analyzer effective-access expansion.
 *
 * Edge-write policy: single `:CONNECTS_TO` edge per logical relationship.
 *   • IAM-binding edges carry `source: 'gcp-iam-policy'`,
 *     `via: 'iam-binding'`, plus a `role` property on the MERGE key so
 *     distinct role grants between the same pair stay separate edges.
 *   • Auto-link edges (Component → Infra) use `via: 'component-mapping'`,
 *     `source: 'auto-link'`, `provider_source: 'gcp-enrichment'`.
 */

// ─── helpers ─────────────────────────────────────────────────────────────────

function projectFromCloudId(cid = '') {
  // GCP self-links: https://www.googleapis.com/<svc>/<ver>/projects/<id>/...
  // CAI names:     //service.googleapis.com/projects/<id>/...
  const m = (cid || '').match(/\/projects\/([^/]+)\//)
  return m ? m[1].toLowerCase() : ''
}

function normId(id = '') {
  return (id || '').toLowerCase().replace(/\/$/, '')
}

function saKey(projectId, email) {
  if (!email || !projectId) return ''
  return `https://iam.googleapis.com/projects/${projectId}/serviceaccounts/${email.toLowerCase()}`
}

// ─── Edge writer (single :CONNECTS_TO write per logical IAM grant) ──────────

async function writeIamEdge(write, { from, to, role, source, evidence, confidence = 60 }) {
  if (!from || !to || from === to) return 0
  const params = { from, to, via: 'iam-binding', source, confidence, role, evidence }
  try {
    await write(`
      MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
      MERGE (a)-[r:CONNECTS_TO {via: $via, role: $role}]->(b)
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

// ─── Layer: IAM Policy ───────────────────────────────────────────────────────

async function discoverFromIamPolicy({ credentials, projectId, write, query, log }) {
  const stats = { policies: 0, bindings: 0, edges: 0, publicResources: 0, skipped: 0, errors: [] }
  if (!projectId) {
    stats.errors.push('IAM Policy supplement requires projectId')
    return stats
  }

  const { AssetServiceClient } = await import('@google-cloud/asset')
  const clientOpts = credentials?.client_email
    ? { credentials, projectId }
    : { projectId }
  const client = new AssetServiceClient(clientOpts)

  // Build TWO lookups: by CAI name (for IAM policy targets) and by SA self-link
  // (for serviceAccount: principals). Both come from the same Infra-node sweep.
  const infraRows = await query(`
    MATCH (i:Infra)
    WHERE i.provider = 'gcp' AND i.cloud_id IS NOT NULL
    RETURN i.cloud_id AS cid, i.id AS nid, i.cai_name AS cai, i.resource_type AS rtype
  `)
  const caiNameToNid = {}
  const saSelfLinkToNid = {}
  for (const r of infraRows) {
    const nid  = r.get('nid')
    const cai  = r.get('cai')
    const cid  = r.get('cid')
    const rtype = r.get('rtype')
    if (cai) caiNameToNid[normId(cai)]    = nid
    if (rtype === 'gcp_service_account' && cid) {
      saSelfLinkToNid[normId(cid)] = nid
    }
  }

  let assetCount = 0
  try {
    const iter = client.listAssetsAsync({
      parent:      `projects/${projectId}`,
      contentType: 'IAM_POLICY',
    })
    for await (const asset of iter) {
      assetCount++
      const policy = asset.iamPolicy
      if (!policy) continue
      stats.policies++

      const targetNid = caiNameToNid[normId(asset.name)]
      // If the resource isn't in the graph yet, we still walk the bindings to
      // count them and detect public exposure metadata, but can't write edges.

      let publicFlipped = false

      for (const binding of policy.bindings || []) {
        stats.bindings++
        const role = binding.role || ''
        for (const member of binding.members || []) {
          if (member === 'allUsers' || member === 'allAuthenticatedUsers') {
            if (targetNid && !publicFlipped) {
              try {
                await write(
                  `MATCH (i:Infra {id: $nid}) SET i.public = true, i.public_via_iam = $role`,
                  { nid: targetNid, role },
                )
                stats.publicResources++
                publicFlipped = true
              } catch (err) {
                stats.errors.push(`flip public ${asset.name}: ${err.message}`)
              }
            }
            continue
          }
          if (member.startsWith('serviceAccount:')) {
            const email = member.slice('serviceAccount:'.length)
            const fromNid = saSelfLinkToNid[normId(saKey(projectId, email))]
            if (fromNid && targetNid) {
              const n = await writeIamEdge(write, {
                from:       fromNid,
                to:         targetNid,
                role,
                source:     'gcp-iam-policy',
                evidence:   `IAM: ${role} on ${asset.assetType}`,
                confidence: 60,
              })
              if (n) stats.edges++
            } else {
              stats.skipped++
            }
            continue
          }
          // user: / group: / domain: principals — no Infra-node analog yet.
          // Counted as skipped so callers can size the gap; revisit when we
          // model human / group principals as their own node type.
          stats.skipped++
        }
      }
    }
  } catch (err) {
    stats.errors.push(`CAI listAssets(IAM_POLICY): ${err.message}`)
  }

  log.info?.(
    `[GCP Supplement] IAM Policy: ${assetCount} assets, ${stats.policies} policies, ` +
    `${stats.bindings} bindings, ${stats.edges} edges, ${stats.publicResources} public-flipped, ` +
    `${stats.skipped} principals skipped`,
  )
  return stats
}

// ─── Phase 2: Auto-link via structural signals ───────────────────────────────
// Delegates to the cross-cloud helper in discovery.autolink.js.
// GCP-specific config: provider='gcp', co-location bucket = project id
// derived from cloud_id, via→score table from GCP_VIA_TO_AUTOLINK_SCORE.

import { autoLinkFromStructure as sharedAutoLink, GCP_VIA_TO_AUTOLINK_SCORE } from './discovery.autolink.js'

async function autoLinkFromStructure({ write, query, log, minScore = 60 }) {
  return sharedAutoLink({
    provider:              'gcp',
    coLocationFromCloudId: projectFromCloudId,
    coLocationLabel:       'project',
    viaToScore:            GCP_VIA_TO_AUTOLINK_SCORE,
    enrichmentSource:      'gcp-enrichment',
    write, query, log, minScore,
  })
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * supplementGCPDiscovery(opts)
 *
 * opts:
 *   credentials — (optional) GCP service-account JSON; required for the
 *                 'iam-policy' layer if not relying on ADC
 *   projectId   — GCP project id (required for layers that hit CAI)
 *   write       — Neo4j write fn
 *   query       — Neo4j query fn
 *   log         — Fastify logger
 *   layers      — (optional) array of named layers. Currently supported:
 *                 'iam-policy'. Reserved for future: 'vpc-flow-logs',
 *                 'iam-policy-analyzer'. Unknown layer names are warned
 *                 but do not abort.
 *   autoLink    — (optional) boolean, default true
 *   minScore    — (optional) number 0–100, default 60
 */
export async function supplementGCPDiscovery({
  credentials,
  projectId,
  write,
  query,
  log,
  layers   = [],
  autoLink = true,
  minScore = 60,
}) {
  log.info?.(`[GCP Supplement] Starting, layers: ${layers.join(', ') || 'none'}, autoLink: ${autoLink}`)

  const KNOWN_LAYERS = new Set(['iam-policy'])
  const unknown = layers.filter(l => !KNOWN_LAYERS.has(l))
  if (unknown.length) {
    log.warn?.(`[GCP Supplement] layers not yet implemented in slice 2: ${unknown.join(', ')}`)
  }

  const results = {
    iamPolicy:          null,
    autoLink:           null,
    totalRelationships: 0,
    totalLinked:        0,
    errors:             [],
  }

  if (layers.includes('iam-policy')) {
    try {
      results.iamPolicy = await discoverFromIamPolicy({ credentials, projectId, write, query, log })
      results.totalRelationships += results.iamPolicy.edges
      results.errors.push(...(results.iamPolicy.errors || []))
    } catch (err) {
      results.errors.push(`iam-policy: ${err.message}`)
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

  log.info?.(`[GCP Supplement] Complete — relationships: ${results.totalRelationships}, auto-linked: ${results.totalLinked}`)
  return results
}

// Internal exports for tests.
export const __test__ = {
  projectFromCloudId,
  saKey,
  writeIamEdge,
  discoverFromIamPolicy,
  autoLinkFromStructure,
}
