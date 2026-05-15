// services/graph-visualize.js
//
// Renders a bfsWalk result into Mermaid or DOT (Graphviz) text. The
// REST endpoint that wraps this returns the text directly, so callers
// can pipe it into a renderer:
//
//   curl ".../graph/visualize?id=X&format=dot"     | dot -Tpng > impact.png
//   curl ".../graph/visualize?id=X&format=mermaid" | pbcopy    # paste into a README
//
// Both formats:
//   - Subgraph by Application (Components grouped by their owning app)
//   - Distinct shapes per label (Component=rounded box, Infra=cylinder,
//     Application=box)
//   - Edge label = `via`
//   - Root and seeds are highlighted
//   - Rollup buckets shown as clusters when more than one Infra in the
//     same bucket is reached (Mermaid: subgraph; DOT: cluster)
//
// Sanitisation: Mermaid identifiers can't contain dashes or dots, and
// DOT identifiers need quoting when they do. Both renderers below
// generate stable safe ids from the node's UUID/cloud_id.

const APP_FILL    = '#e3f2fd'
const APP_STROKE  = '#1976d2'
const COMP_FILL   = '#fff3e0'
const COMP_STROKE = '#f57c00'
const INFRA_FILL  = '#e8f5e9'
const INFRA_STROKE= '#388e3c'
const ROOT_STROKE = '#c2185b'

const safeMermaidId = (id) => `n_${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`
const escapeMermaidLabel = (s = '') => String(s).replace(/"/g, '#quot;').replace(/[<>]/g, '')
const escapeDotLabel     = (s = '') => String(s).replace(/"/g, '\\"').replace(/\n/g, '\\n')

// Group nodes by where they should be drawn:
//   - Components grouped by ownerAppId/ownerAppName (or root app if seeds)
//   - Infra grouped by rollupKey when ≥2 share a bucket (otherwise flat)
//   - Everything else: flat
//
// Returns { appGroups: Map<appId, {name, members[]}>, rollupGroups: Map<key,
// {kind, members[]}>, flat: [] }.
function groupForVisualization(walk) {
  const appGroups    = new Map()
  const rollupGroups = new Map()
  const flat         = []
  const allNodes = [
    // Seeds + reached nodes; mark seeds for the root highlight.
    ...walk.seeds.map(s => ({ ...s, _seed: true, label: walk.root.label === 'Application' ? 'Component' : walk.root.label })),
    ...walk.nodes,
  ]
  // Dedup — a seed may also appear in nodes if a walk re-enters it.
  const byId = new Map()
  for (const n of allNodes) {
    if (n?.id && !byId.has(n.id)) byId.set(n.id, n)
  }

  // Pre-count rollup membership so we only create cluster boxes for
  // buckets with ≥2 members (single-member clusters add noise).
  const rollupCount = new Map()
  for (const n of byId.values()) {
    if (n.label !== 'Infra' || !n.rollupKey) continue
    rollupCount.set(n.rollupKey, (rollupCount.get(n.rollupKey) || 0) + 1)
  }

  for (const n of byId.values()) {
    if (n.label === 'Component') {
      // For seed Components under an Application root, the owner is the
      // root itself — and seeds don't carry ownerApp* annotations
      // (bfsWalk only joins those for depth>0 reached components), so
      // fall back to root.{id,name,tier} for the cluster header.
      const isRootSeed = n._seed && walk.root.label === 'Application'
      const appId   = n.ownerAppId   || (isRootSeed ? walk.root.id   : null)
      const appName = n.ownerAppName || (isRootSeed ? walk.root.name : null)
      const appTier = n.ownerAppTier || (isRootSeed ? walk.root.tier : null)
      if (appId) {
        if (!appGroups.has(appId)) appGroups.set(appId, { name: appName, tier: appTier, members: [] })
        appGroups.get(appId).members.push(n)
        continue
      }
    }
    if (n.label === 'Infra' && n.rollupKey && rollupCount.get(n.rollupKey) >= 2) {
      const key = `${n.rollupKind}::${n.rollupKey}`
      if (!rollupGroups.has(key)) rollupGroups.set(key, { kind: n.rollupKind, name: n.rollupKey, members: [] })
      rollupGroups.get(key).members.push(n)
      continue
    }
    flat.push(n)
  }
  return { appGroups, rollupGroups, flat, byId }
}

// ── Mermaid ──────────────────────────────────────────────────────────────────

/**
 * Build a Mermaid `flowchart LR` diagram from a bfsWalk result. The
 * output is GitHub-renderable — embed it directly in a README between
 * ` ```mermaid ` fences.
 */
export function toMermaid(walk, { direction = 'outbound' } = {}) {
  const { appGroups, rollupGroups, flat, byId } = groupForVisualization(walk)
  const out = []
  out.push('%%{init: {"theme":"default","flowchart":{"curve":"basis"}}}%%')
  out.push('flowchart LR')
  out.push(`  %% ${direction === 'outbound' ? 'Dependencies' : 'Impact'} walk from ${walk.root.label} "${walk.root.name || walk.root.id}"`)
  out.push(`  %% ${walk.stats.nodesReturned} nodes, ${walk.stats.edgesReturned} edges, reached depth ${walk.stats.reachedDepth}${walk.truncated ? ' (truncated)' : ''}`)

  const seedIds = new Set(walk.seeds.map(s => s.id))
  const rootId  = walk.root.id
  const renderNode = (n) => {
    const sid   = safeMermaidId(n.id)
    const label = escapeMermaidLabel(n.name || n.id)
    const depthTag = n._seed ? ' (root)' : (n.depth ? ` (d${n.depth})` : '')
    if (n.label === 'Application') return `    ${sid}["${label}${depthTag}"]`
    if (n.label === 'Infra')       return `    ${sid}[("${label}${depthTag}")]`           // cylinder
    return `    ${sid}("${label}${depthTag}")`                                              // rounded box for Components
  }

  // Subgraphs per Application
  for (const [appId, app] of appGroups) {
    const sid = safeMermaidId(`app__${appId}`)
    const tierTag = app.tier ? ` tier ${app.tier}` : ''
    out.push(`  subgraph ${sid}["${escapeMermaidLabel(app.name || appId)}${tierTag}"]`)
    out.push(`    direction TB`)
    for (const m of app.members) out.push(renderNode(m))
    out.push(`  end`)
  }

  // Subgraphs per rollup bucket (Infra with ≥2 in the same bucket)
  for (const [, rg] of rollupGroups) {
    const sid = safeMermaidId(`rg__${rg.kind}__${rg.name}`)
    out.push(`  subgraph ${sid}["${escapeMermaidLabel(rg.name)} (${rg.kind})"]`)
    out.push(`    direction TB`)
    for (const m of rg.members) out.push(renderNode(m))
    out.push(`  end`)
  }

  // Flat nodes
  for (const n of flat) out.push(renderNode(n))

  // Edges
  for (const e of walk.edges) {
    const from = safeMermaidId(e.from)
    const to   = safeMermaidId(e.to)
    const lbl  = escapeMermaidLabel(e.via || '')
    out.push(`  ${from} -->|${lbl}| ${to}`)
  }

  // Styling
  out.push(`  classDef appNode   fill:${APP_FILL},stroke:${APP_STROKE},stroke-width:1px`)
  out.push(`  classDef compNode  fill:${COMP_FILL},stroke:${COMP_STROKE},stroke-width:1px`)
  out.push(`  classDef infraNode fill:${INFRA_FILL},stroke:${INFRA_STROKE},stroke-width:1px`)
  out.push(`  classDef rootNode  stroke:${ROOT_STROKE},stroke-width:3px,font-weight:bold`)

  const componentIds = [], infraIds = [], appIds = [], rootIds = []
  for (const n of byId.values()) {
    const sid = safeMermaidId(n.id)
    if (n.label === 'Application') appIds.push(sid)
    else if (n.label === 'Infra')  infraIds.push(sid)
    else                           componentIds.push(sid)
    if (n.id === rootId || seedIds.has(n.id)) rootIds.push(sid)
  }
  if (componentIds.length) out.push(`  class ${componentIds.join(',')} compNode`)
  if (infraIds.length)     out.push(`  class ${infraIds.join(',')} infraNode`)
  if (appIds.length)       out.push(`  class ${appIds.join(',')} appNode`)
  if (rootIds.length)      out.push(`  class ${rootIds.join(',')} rootNode`)

  return out.join('\n') + '\n'
}

// ── DOT (Graphviz) ───────────────────────────────────────────────────────────

/**
 * Build a DOT digraph from a bfsWalk result. Pipe through Graphviz
 * (`dot -Tpng`, `dot -Tsvg`) to produce a static image suitable for
 * commit alongside a runbook.
 */
export function toDot(walk, { direction = 'outbound' } = {}) {
  const { appGroups, rollupGroups, flat, byId } = groupForVisualization(walk)
  const seedIds = new Set(walk.seeds.map(s => s.id))
  const rootId  = walk.root.id
  const out = []
  out.push(`digraph appcloud_${direction} {`)
  out.push(`  rankdir=LR;`)
  out.push(`  bgcolor="transparent";`)
  out.push(`  node [style=filled, fontname="Helvetica", fontsize=11];`)
  out.push(`  edge [fontname="Helvetica", fontsize=9, color="#666666"];`)
  out.push(`  // ${direction === 'outbound' ? 'Dependencies' : 'Impact'} walk from ${walk.root.label} "${walk.root.name || walk.root.id}"`)
  out.push(`  // ${walk.stats.nodesReturned} nodes, ${walk.stats.edgesReturned} edges${walk.truncated ? ' (truncated)' : ''}`)

  let clusterIdx = 0
  const nodeAttrs = (n) => {
    const labelLines = [escapeDotLabel(n.name || n.id)]
    if (n._seed) labelLines.push('(root)')
    else if (n.depth) labelLines.push(`d${n.depth}`)
    const label = labelLines.join('\\n')
    const baseStroke = n.label === 'Application' ? APP_STROKE : n.label === 'Infra' ? INFRA_STROKE : COMP_STROKE
    const fill       = n.label === 'Application' ? APP_FILL   : n.label === 'Infra' ? INFRA_FILL   : COMP_FILL
    const shape      = n.label === 'Infra' ? 'cylinder' : n.label === 'Application' ? 'box' : 'box'
    const peripheries= (n.id === rootId || seedIds.has(n.id)) ? 2 : 1
    const stroke     = (n.id === rootId || seedIds.has(n.id)) ? ROOT_STROKE : baseStroke
    return `[label="${label}", shape=${shape}, fillcolor="${fill}", color="${stroke}", peripheries=${peripheries}]`
  }

  for (const [appId, app] of appGroups) {
    const tierTag = app.tier ? ` (tier ${app.tier})` : ''
    out.push(`  subgraph cluster_${clusterIdx++} {`)
    out.push(`    label="${escapeDotLabel(app.name || appId)}${tierTag}";`)
    out.push(`    style="rounded,filled"; fillcolor="${APP_FILL}33"; color="${APP_STROKE}";`)
    for (const m of app.members) out.push(`    "${m.id}" ${nodeAttrs(m)};`)
    out.push(`  }`)
  }
  for (const [, rg] of rollupGroups) {
    out.push(`  subgraph cluster_${clusterIdx++} {`)
    out.push(`    label="${escapeDotLabel(rg.name)} (${rg.kind})";`)
    out.push(`    style="rounded,dashed"; color="${INFRA_STROKE}";`)
    for (const m of rg.members) out.push(`    "${m.id}" ${nodeAttrs(m)};`)
    out.push(`  }`)
  }
  for (const n of flat) out.push(`  "${n.id}" ${nodeAttrs(n)};`)

  for (const e of walk.edges) {
    out.push(`  "${e.from}" -> "${e.to}" [label="${escapeDotLabel(e.via || '')}"];`)
  }
  out.push(`}`)
  return out.join('\n') + '\n'
}
