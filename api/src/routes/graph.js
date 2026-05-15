import neo4j from 'neo4j-driver'
import { props, serialize } from '../utils/serialize.js'
import { actorFromReq } from '../utils/audit.js'

// Neo4j requires `LIMIT $x` parameters to be Integer (not Number).
// Convert here so route-level params can stay plain JS ints.
const neo4jInt = (n) => neo4j.int(n)
import {
  GraphTopologyResponseSchema,
  GraphWalkResponseSchema,
  StandardErrorResponses,
} from '../schemas/openapi.js'

// BFS defaults shared by /graph/impact (inbound) and /graph/dependencies
// (outbound). maxDepth=10 covers realistic structural chains
// (VM→NIC→Subnet→VNet→…) plus a few service-to-service hops; nodeCap=500
// keeps a single response payload reasonable even for a noisy shared
// resource. Whichever fires first sets `truncated: true`.
const WALK_DEFAULT_MAX_DEPTH = 10
const WALK_DEFAULT_NODE_CAP  = 500
const WALK_MAX_NODE_CAP      = 5000

const WALK_QUERYSTRING = {
  type: 'object',
  required: ['id'],
  properties: {
    id:            { type: 'string', description: 'Root node id (UUID).' },
    maxDepth:      { type: 'integer', minimum: 1, maximum: 20,   default: WALK_DEFAULT_MAX_DEPTH },
    nodeCap:       { type: 'integer', minimum: 1, maximum: WALK_MAX_NODE_CAP, default: WALK_DEFAULT_NODE_CAP },
    minConfidence: { type: 'integer', minimum: 0, maximum: 100, default: 0 },
  },
}

// Shared BFS implementation for `/graph/impact` (inbound) and
// `/graph/dependencies` (outbound). One Cypher round-trip per depth
// layer keeps the cap behaviour predictable and avoids the exponential
// blow-up of unbounded variable-length patterns. Edges are returned in
// the writer-emitted direction (`from` → `to`) regardless of BFS
// direction — that way an SRE consuming the JSON sees the structural
// arrow the way the scanner wrote it, not the reverse of however we
// happened to walk.
async function bfsWalk({ query, rootId, direction, maxDepth, nodeCap, minConfidence }) {
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

  const rootProps = props(rootNode)
  const nodes = [...visited.entries()]
    .filter(([, v]) => v.depth > 0)
    .map(([, v]) => ({ ...v.props, label: v.label, depth: v.depth }))
    .sort((a, b) => a.depth - b.depth || (a.name || '').localeCompare(b.name || ''))

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

export default async function graphRoutes(fastify) {
  const actor = actorFromReq
  const { query } = fastify.neo4j

  // GET /graph/summary
  fastify.get('/summary', {
    schema: {
      summary:     'Counts: applications, components, infra, connections, public-exposed',
      description: 'A single-shot summary of the graph: total counts plus components-by-type and infra-by-provider histograms. Used by dashboard tiles.',
      response:    {
        200: {
          type: 'object', additionalProperties: true,
          properties: {
            applications:     { type: 'integer' },
            components:       { type: 'integer' },
            infraResources:   { type: 'integer' },
            users:            { type: 'integer' },
            publicInfraCount: { type: 'integer' },
            connections:      { type: 'integer' },
            componentsByType: { type: 'array', items: { type: 'object', additionalProperties: true } },
            infraByProvider:  { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (req, reply) => {
    const [countRecords, compTypeRecords, infraProviderRecords, connRecords] = await Promise.all([
      query(`
        OPTIONAL MATCH (a:Application)
        OPTIONAL MATCH (c:Component)
        OPTIONAL MATCH (i:Infra)
        OPTIONAL MATCH (u:User)
        OPTIONAL MATCH (i2:Infra {public: true})
        RETURN count(DISTINCT a)   AS appCount,
               count(DISTINCT c)   AS componentCount,
               count(DISTINCT i)   AS infraCount,
               count(DISTINCT u)   AS userCount,
               count(DISTINCT i2)  AS publicInfra
      `),
      query(`MATCH (c:Component) RETURN c.type AS type, count(c) AS cnt ORDER BY cnt DESC`),
      query(`MATCH (i:Infra) RETURN i.provider AS provider, count(i) AS cnt ORDER BY cnt DESC`),
      query(`OPTIONAL MATCH ()-[r:CONNECTS_TO]->() RETURN count(r) AS connCount`),
    ])
    const r = countRecords[0]
    return {
      applications:     serialize(r.get('appCount')),
      components:       serialize(r.get('componentCount')),
      infraResources:   serialize(r.get('infraCount')),
      users:            serialize(r.get('userCount')),
      publicInfraCount: serialize(r.get('publicInfra')),
      connections:      serialize(connRecords[0]?.get('connCount') ?? 0),
      componentsByType: compTypeRecords.map(r => ({
        type: r.get('type') || 'Unknown', count: serialize(r.get('cnt'))
      })),
      infraByProvider: infraProviderRecords.map(r => ({
        provider: r.get('provider') || 'unknown', count: serialize(r.get('cnt'))
      })),
    }
  })

  // GET /graph/topology
  fastify.get('/topology', {
    schema: {
      summary:     'Full graph snapshot — apps, components, connections, deployments, infra',
      description: 'Single response covering every Application, Component, Component↔Component connection (with protocol/port), Component→Infra deployment, and the unique Infra referenced. Drives the topology canvas.',
      response:    { 200: GraphTopologyResponseSchema },
    },
  }, async (req, reply) => {
    const [appRecords, compRecords, connRecords, deployRecords] = await Promise.all([
      query(`
        MATCH (a:Application)
        OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
        RETURN a, collect(DISTINCT {id: c.id, name: c.name, type: c.type, runtime: c.runtime}) AS components
        ORDER BY a.tier ASC, a.name ASC
      `),
      query(`
        MATCH (c:Component)
        OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
        RETURN c, a.id AS appId, a.name AS appName
      `),
      query(`
        MATCH (c1:Component)-[r:CONNECTS_TO]->(c2:Component)
        OPTIONAL MATCH (a1:Application)-[:CONTAINS]->(c1)
        OPTIONAL MATCH (a2:Application)-[:CONTAINS]->(c2)
        RETURN c1.id AS fromId, a1.id AS fromAppId,
               c2.id AS toId,   a2.id AS toAppId,
               r.protocol AS protocol, r.port AS port
      `),
      query(`
        MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i:Infra)
        RETURN c.id AS compId, i.id AS infraId, i.name AS infraName,
               i.provider AS provider, i.region AS region, i.resource_type AS resourceType
      `),
    ])

    const apps = appRecords.map(r => ({
      ...props(r.get('a')),
      components: serialize(r.get('components')).filter(c => c.id !== null),
    }))
    const components = compRecords.map(r => ({
      ...props(r.get('c')),
      appId:   r.get('appId'),
      appName: r.get('appName'),
    }))
    const connections = connRecords.map(r => ({
      fromId:   r.get('fromId'),
      fromAppId:r.get('fromAppId'),
      toId:     r.get('toId'),
      toAppId:  r.get('toAppId'),
      protocol: r.get('protocol') || 'HTTPS',
      port:     serialize(r.get('port')),
    }))

    const infraMap = {}
    deployRecords.forEach(r => {
      const id = r.get('infraId')
      if (id && !infraMap[id]) infraMap[id] = {
        id, name: r.get('infraName'), provider: r.get('provider'),
        region: r.get('region'), resourceType: r.get('resourceType'),
      }
    })
    const deployments = deployRecords.map(r => ({
      compId: r.get('compId'), infraId: r.get('infraId')
    }))

    return { apps, components, connections, deployments, infra: Object.values(infraMap) }
  })

  // GET /graph/impact?id=<uuid>&maxDepth=&nodeCap=&minConfidence=
  fastify.get('/impact', {
    schema: {
      summary:     'Blast-radius — what is impacted if this Application, Component, or Infra changes',
      description: [
        'Given an impacted root node, returns the inbound subgraph reachable via',
        '`:CONNECTS_TO` as a depth-aware tree — every node that *depends on* the root,',
        'transitively. This is the symmetric inverse of `/graph/dependencies`.',
        '',
        'Walk semantics:',
        '- Root is auto-detected: Application fans out to contained Components as BFS seeds; Component or Infra seeds itself.',
        '- Edges followed: any `:CONNECTS_TO` inbound to the frontier. For an Infra root this surfaces every Component deployed on it and every upstream Infra that uses it (a NIC root surfaces the VM, a subnet root surfaces every NIC in it). For a Component root it surfaces every other Component calling it.',
        '- BFS is bounded by `maxDepth` (default 10) and `nodeCap` (default 500, max 5000). Whichever fires first sets `truncated: true` in the stats.',
        '- Optional `minConfidence` skips edges below the threshold.',
        '',
        'Every node carries its `depth` (1 = direct dependent); every edge carries the full `:CONNECTS_TO` property contract (`source`, `via`, `confidence`, `evidence`) plus writer-specific extras. Edges are always presented in the writer-emitted direction (`from` → `to`), not the BFS direction. Reached Components are annotated with their owning Application.',
      ].join('\n'),
      querystring: WALK_QUERYSTRING,
      response: {
        200: GraphWalkResponseSchema,
        400: StandardErrorResponses[400],
        404: StandardErrorResponses[404],
      },
    },
  }, async (req, reply) => {
    const { id } = req.query
    if (!id) return reply.badRequest('id required')
    const result = await bfsWalk({
      query,
      rootId:        id,
      direction:     'inbound',
      maxDepth:      req.query.maxDepth      ?? WALK_DEFAULT_MAX_DEPTH,
      nodeCap:       Math.min(req.query.nodeCap ?? WALK_DEFAULT_NODE_CAP, WALK_MAX_NODE_CAP),
      minConfidence: req.query.minConfidence  ?? 0,
    })
    if (!result) return reply.notFound('No Application, Component, or Infra with that id')
    return result
  })

  // GET /graph/dependencies?id=<uuid>&maxDepth=&nodeCap=&minConfidence=
  fastify.get('/dependencies', {
    schema: {
      summary:     'Inverse of /graph/impact — what an Application or Component depends on',
      description: [
        'Given an impacted Application or Component, returns the outbound dependency subgraph',
        'reachable via `:CONNECTS_TO` edges as a depth-aware tree.',
        '',
        'Walk semantics:',
        '- Root is auto-detected. When an Application id is supplied, every contained Component is used as a BFS seed; when a Component id is supplied, that Component is the only seed. Infra ids 404 here — use `/graph/impact` for the inbound direction.',
        '- Edges followed: any `:CONNECTS_TO` outbound from a seed. This naturally covers Component→Component service calls, Component→Infra `via: component-mapping` deployments, and the transitive Infra→Infra structural chain (VM→NIC→Subnet→VNet on Azure, Compute→Subnet/Network/Disk/SA on GCP, Instance→ENI/VPC/SG/IAM-Role on AWS).',
        '- BFS is bounded by `maxDepth` (default 10) and `nodeCap` (default 500, max 5000). Whichever fires first sets `truncated: true` in the stats.',
        '- Optional `minConfidence` skips edges below the threshold, useful for filtering out auto-link suggestions when only structural certainty matters.',
        '',
        'Every node carries its `depth` (1 = direct dependency); every edge carries the full `:CONNECTS_TO` property contract (`source`, `via`, `confidence`, `evidence`) plus writer-specific extras (protocol, port, role, observed-tcp stats…). Reached Components are annotated with their owning Application.',
      ].join('\n'),
      querystring: WALK_QUERYSTRING,
      response: {
        200: GraphWalkResponseSchema,
        400: StandardErrorResponses[400],
        404: StandardErrorResponses[404],
      },
    },
  }, async (req, reply) => {
    const { id } = req.query
    if (!id) return reply.badRequest('id required')
    const result = await bfsWalk({
      query,
      rootId:        id,
      direction:     'outbound',
      maxDepth:      req.query.maxDepth      ?? WALK_DEFAULT_MAX_DEPTH,
      nodeCap:       Math.min(req.query.nodeCap ?? WALK_DEFAULT_NODE_CAP, WALK_MAX_NODE_CAP),
      minConfidence: req.query.minConfidence  ?? 0,
    })
    if (!result) return reply.notFound('No Application or Component with that id (Infra ids use /graph/impact)')
    return result
  })

  // GET /graph/cross-app-dependencies
  fastify.get('/cross-app-dependencies', {
    schema: {
      summary:     'Every Component → Component edge that crosses an Application boundary',
      description: 'Returns one row per cross-application Component connection: `from` (app, tier, component), `connection` (protocol, port), `to` (app, tier, component). Used for change-coordination dashboards.',
      response:    { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req, reply) => {
    const records = await query(`
      MATCH (a1:Application)-[:CONTAINS]->(c1:Component)
            -[conn:CONNECTS_TO]->(c2:Component)<-[:CONTAINS]-(a2:Application)
      WHERE a1.id <> a2.id
      RETURN a1.name AS fromApp, a1.tier AS fromTier, c1.name AS fromComponent,
             conn.protocol AS protocol, conn.port AS port,
             a2.name AS toApp,   a2.tier AS toTier,   c2.name AS toComponent
      ORDER BY a1.tier, a1.name
    `)
    return records.map(r => ({
      from:       { app: r.get('fromApp'), tier: serialize(r.get('fromTier')), component: r.get('fromComponent') },
      connection: { protocol: r.get('protocol'), port: serialize(r.get('port')) },
      to:         { app: r.get('toApp'),   tier: serialize(r.get('toTier')),   component: r.get('toComponent') },
    }))
  })

  // GET /graph/path?from=&to=
  fastify.get('/path', {
    schema: {
      summary:     'Shortest path between two Components',
      description: 'Returns the shortest directed path of any relationship type from `from` to `to`, with the node sequence and hop count. 404 when no path exists.',
      querystring: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
      response:    { 200: { type: 'object', additionalProperties: true, properties: { hops: { type: 'integer' }, path: { type: 'array', items: { type: 'object', additionalProperties: true } } } }, 400: StandardErrorResponses[400], 404: StandardErrorResponses[404] },
    },
  }, async (req, reply) => {
    const { from, to } = req.query
    if (!from || !to) return reply.badRequest('from and to required')
    const records = await query(`
      MATCH (src:Component {id: $from}), (dst:Component {id: $to})
      MATCH path = shortestPath((src)-[*]->(dst))
      RETURN [n IN nodes(path) | {label: labels(n)[0], name: n.name, id: n.id}] AS nodes,
             length(path) AS hops
    `, { from, to })
    if (!records.length) return reply.notFound('No path found')
    return { hops: serialize(records[0].get('hops')), path: records[0].get('nodes') }
  })

  // GET /graph/snapshots
  fastify.get('/snapshots', {
    schema: {
      summary:     'List topology snapshots',
      description: 'Returns saved snapshots, newest first. Capped at `limit` (default 100, max 1000) — long-running deployments can accumulate thousands; the cap keeps response payloads bounded.',
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        },
      },
      response:    { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req, reply) => {
    const limit = req.query?.limit ?? 100
    const records = await query(
      `MATCH (s:Snapshot) RETURN s ORDER BY s.createdAt DESC LIMIT $limit`,
      { limit: neo4jInt(limit) },
    )
    return records.map(r => props(r.get('s')))
  })

  // POST /graph/snapshots
  fastify.post('/snapshots', {
    schema: {
      summary:     'Capture a topology snapshot',
      description: 'Creates a `:Snapshot` node with the current node counts and an optional `label`. Snapshots are append-only — there\'s no DELETE endpoint.',
      body:        { type: 'object', additionalProperties: true, properties: { label: { type: 'string' }, name: { type: 'string', description: 'Alias for label' } } },
      response:    { 201: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const { label } = req.body
    const records = await query(`
      MATCH (a:Application) WITH count(a) AS appCount
      MATCH (c:Component)   WITH appCount, count(c) AS componentCount
      MATCH (i:Infra)       WITH appCount, componentCount, count(i) AS infraCount
      CREATE (s:Snapshot {
        id: randomUUID(), createdAt: datetime(), label: $label,
        nodeCount: appCount + componentCount + infraCount
      }) RETURN s
    `, { label })
    const snap = props(records[0].get('s'))
    req.audit(actor(req), 'create', 'Snapshot', snap.id, label || snap.id,
      { nodeCount: snap.nodeCount }).catch(() => {})
    reply.code(201)
    return snap
  })
}