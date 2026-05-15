// services/graph-walk.js
//
// Shared BFS over the `:CONNECTS_TO` graph, backing both the
// /graph/{impact,dependencies} REST surface and the /ai/infra/:id/impact
// LLM-narrative endpoint. Lifted out of routes/graph.js so any future
// consumer (CLI tools, Slack handlers, additional AI endpoints) can
// import the helper without coupling to the route module.
//
// Design notes:
//
//   - One Cypher round-trip per depth layer. Predictable nodeCap
//     behaviour, no exponential blow-up from variable-length patterns.
//   - Edges are emitted in the writer-direction (`from` → `to`)
//     regardless of BFS direction. For an inbound walk we swap the
//     frontier/neighbour pair when building the edge — that way the
//     JSON shows structural arrows the way the scanner wrote them.
//   - Every reached Component is annotated with its owning Application
//     (incident responders care which app a leaked-in service is in).
//   - Every reached Infra is annotated with its co-location bucket
//     (resource-group / project / account+region — the same key the
//     autolink Rule-1 uses for grouping).

import { props, serialize }   from '../utils/serialize.js'
import { rollupForInfra }     from '../utils/cloud-rollup.js'

// BFS defaults shared by /graph/impact (inbound) and /graph/dependencies
// (outbound). maxDepth=10 covers realistic structural chains
// (VM→NIC→Subnet→VNet→…) plus a few service-to-service hops; nodeCap=500
// keeps a single response payload reasonable even for a noisy shared
// resource. Whichever fires first sets `truncated: true`.
export const WALK_DEFAULT_MAX_DEPTH = 10
export const WALK_DEFAULT_NODE_CAP  = 500
export const WALK_MAX_NODE_CAP      = 5000

export async function bfsWalk({ query, rootId, direction, maxDepth, nodeCap, minConfidence }) {
  const validRootLabels = direction === 'outbound'
    ? '(root:Application OR root:Component)'
    : '(root:Application OR root:Component OR root:Infra)'

  const rootRecords = await query(`
    MATCH (root {id: $id})
    WHERE ${validRootLabels}
    OPTIONAL MATCH (root)-[:CONTAINS]->(c:Component)
    WITH root, labels(root) AS lbls,
         CASE WHEN root:Application THEN collect(DISTINCT c) ELSE [root] END AS seeds
    RETURN root, lbls, seeds
  `, { id: rootId })
  if (!rootRecords.length) return null

  const rootNode   = rootRecords[0].get('root')
  const rootLabels = rootRecords[0].get('lbls') || []
  const rootLabel  = ['Application', 'Component', 'Infra'].find(l => rootLabels.includes(l)) || rootLabels[0] || 'Node'
  const seedNodes  = rootRecords[0].get('seeds') || []
  const seeds      = seedNodes.map(n => props(n))
  // Application root fans out to Components; otherwise the seed label
  // matches the root's own label.
  const seedLabel  = rootLabel === 'Application' ? 'Component' : rootLabel

  const visited  = new Map()   // id -> { props, label, depth }
  const edges    = []
  const edgeKeys = new Set()
  let truncated  = false
  let reachedDepth = 0

  // Seeds are depth-0 so a seed that's also reachable from another seed
  // doesn't get re-walked or counted as a dependency of itself.
  for (const seed of seedNodes) {
    const sp = props(seed)
    if (sp?.id) visited.set(sp.id, { props: sp, label: seedLabel, depth: 0 })
  }
  let frontier = seedNodes.map(n => n.properties.id).filter(Boolean)

  const stepCypher = direction === 'outbound'
    ? `UNWIND $fromIds AS fromId
       MATCH (from {id: fromId})-[r:CONNECTS_TO]->(to)
       WHERE coalesce(r.confidence, 0) >= $minConfidence
       RETURN fromId, to, r, labels(to) AS toLabels`
    : `UNWIND $fromIds AS fromId
       MATCH (from {id: fromId})<-[r:CONNECTS_TO]-(to)
       WHERE coalesce(r.confidence, 0) >= $minConfidence
       RETURN fromId, to, r, labels(to) AS toLabels`

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    if (visited.size >= nodeCap) { truncated = true; break }
    const records = await query(stepCypher, { fromIds: frontier, minConfidence })
    const nextFrontier = []
    let layerHadHit = false
    for (const rec of records) {
      const fromId      = rec.get('fromId')
      const toNode      = rec.get('to')
      const edgeRel     = rec.get('r')
      const toLabelsArr = rec.get('toLabels') || []
      const toProps     = props(toNode)
      const toId        = toProps?.id
      if (!toId) continue
      layerHadHit = true

      // Dedup edges on the writer-MERGE key analogue: from/to/via/source
      // (+ role for IAM grants, + protocol for OTEL flows). Edges always
      // get presented in the structural direction the writer emitted
      // them, so for an inbound walk we swap the frontier/neighbour
      // pair when building from/to.
      const semanticFrom = direction === 'outbound' ? fromId : toId
      const semanticTo   = direction === 'outbound' ? toId   : fromId
      const edgeProps    = serialize(edgeRel.properties || {})
      const edgeKey = `${semanticFrom}::${semanticTo}::${edgeProps.via || ''}::${edgeProps.source || ''}::${edgeProps.role || ''}::${edgeProps.protocol || ''}`
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey)
        edges.push({ from: semanticFrom, to: semanticTo, ...edgeProps })
      }

      if (!visited.has(toId)) {
        const label = toLabelsArr.find(l => ['Application', 'Component', 'Infra'].includes(l)) || toLabelsArr[0] || 'Node'
        visited.set(toId, { props: toProps, label, depth })
        reachedDepth = Math.max(reachedDepth, depth)
        if (visited.size >= nodeCap) { truncated = true; break }
        // Only Components and Infra propagate the walk — Applications
        // are container nodes joined back as metadata, never a frontier.
        if (label === 'Component' || label === 'Infra') nextFrontier.push(toId)
      }
    }
    if (!layerHadHit) break
    if (truncated) break
    frontier = nextFrontier
  }
  if (frontier.length && reachedDepth === maxDepth) truncated = true

  // Join back the owning Application for every reached Component (an
  // incident responder cares which app a leaked-in service belongs to).
  const componentIds = [...visited.entries()]
    .filter(([, v]) => v.label === 'Component' && v.depth > 0)
    .map(([id]) => id)
  if (componentIds.length) {
    const owners = await query(`
      UNWIND $ids AS cid
      MATCH (a:Application)-[:CONTAINS]->(c:Component {id: cid})
      RETURN cid AS id, a.id AS appId, a.name AS appName, a.tier AS appTier
    `, { ids: componentIds })
    for (const o of owners) {
      const v = visited.get(o.get('id'))
      if (!v) continue
      v.props.ownerAppId   = o.get('appId')
      v.props.ownerAppName = o.get('appName')
      v.props.ownerAppTier = serialize(o.get('appTier'))
    }
  }

  // Per-Infra rollup annotation. Each Infra node carries the
  // co-location bucket it lives in (Azure resource group, GCP project,
  // AWS account+region) — the same key the autolink Rule-1 uses. This
  // is how incident responders ask "show me everything in rg-prod"
  // without a second query.
  for (const v of visited.values()) {
    if (v.label !== 'Infra') continue
    const rollup = rollupForInfra({
      provider: v.props.provider,
      cloud_id: v.props.cloud_id,
    })
    if (rollup) {
      v.props.rollupKind = rollup.kind
      v.props.rollupKey  = rollup.key
    }
  }

  const rootProps = props(rootNode)
  const nodes = [...visited.entries()]
    .filter(([, v]) => v.depth > 0)
    .map(([, v]) => ({ ...v.props, label: v.label, depth: v.depth }))
    .sort((a, b) => a.depth - b.depth || (a.name || '').localeCompare(b.name || ''))

  // Aggregate rollup: a quick histogram of buckets reached, so a
  // dashboard or LLM prompt can lead with "this hits 3 resource groups
  // and 1 cross-cloud project" without re-grouping the node list.
  const rollupHist = new Map()
  for (const n of nodes) {
    if (!n.rollupKey) continue
    const k = `${n.rollupKind}::${n.rollupKey}`
    const prev = rollupHist.get(k)
    if (prev) prev.count += 1
    else rollupHist.set(k, { kind: n.rollupKind, key: n.rollupKey, count: 1 })
  }

  return {
    root: {
      id:    rootProps?.id,
      label: rootLabel,
      name:  rootProps?.name,
      tier:  serialize(rootProps?.tier),
    },
    seeds,
    nodes,
    edges,
    rollups: [...rollupHist.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    truncated,
    stats: {
      nodesReturned: nodes.length,
      edgesReturned: edges.length,
      reachedDepth,
      maxDepth,
      nodeCap,
    },
  }
}
