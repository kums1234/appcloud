import neo4j from 'neo4j-driver'
import { props, serialize } from '../utils/serialize.js'
import { actorFromReq } from '../utils/audit.js'

// Neo4j requires `LIMIT $x` parameters to be Integer (not Number).
// Convert here so route-level params can stay plain JS ints.
const neo4jInt = (n) => neo4j.int(n)
import {
  GraphTopologyResponseSchema,
  GraphImpactResponseSchema,
  GraphDependenciesResponseSchema,
} from '../schemas/openapi.js'

// /graph/dependencies defaults. BFS is bounded by both — whichever caps first
// wins. maxDepth=10 covers realistic structural chains (VM→NIC→Subnet→VNet→…)
// plus a few service-to-service hops; nodeCap=500 keeps a single response
// payload reasonable even for a noisy shared resource.
const DEPS_DEFAULT_MAX_DEPTH = 10
const DEPS_DEFAULT_NODE_CAP  = 500
const DEPS_MAX_NODE_CAP      = 5000

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

  // GET /graph/impact?infraId=x
  fastify.get('/impact', {
    schema: {
      summary:     'Blast-radius for a single Infra resource',
      description: 'Walks Infra ← Component ← Application and returns every Component / Application that depends on the given Infra. Applications come back sorted by tier (1 = critical first).',
      querystring: { type: 'object', required: ['infraId'], properties: { infraId: { type: 'string', format: 'uuid' } } },
      response:    { 200: GraphImpactResponseSchema, 400: { type: 'object', properties: { error: { type: 'string' } } }, 404: { type: 'object', properties: { error: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const { infraId } = req.query
    if (!infraId) return reply.badRequest('infraId required')
    const records = await query(`
      MATCH (i:Infra {id: $infraId})<-[:CONNECTS_TO {via: 'component-mapping'}]-(c:Component)<-[:CONTAINS]-(a:Application)
      RETURN i.name AS infra,
             collect(DISTINCT {name: c.name, type: c.type}) AS components,
             collect(DISTINCT {name: a.name, tier: a.tier, environment: a.environment}) AS applications
    `, { infraId })
    if (!records.length) return reply.notFound('Infra not found or has no deployments')
    const r = records[0]
    return {
      infra:                r.get('infra'),
      impactedComponents:   r.get('components'),
      impactedApplications: serialize(r.get('applications')).sort((a,b) => (a.tier||9) - (b.tier||9)),
    }
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
        '- Root is auto-detected. When an Application id is supplied, every contained Component is used as a BFS seed; when a Component id is supplied, that Component is the only seed.',
        '- Edges followed: any `:CONNECTS_TO` outbound from a seed. This naturally covers Component→Component service calls, Component→Infra `via: component-mapping` deployments, and the transitive Infra→Infra structural chain (VM→NIC→Subnet→VNet on Azure, Compute→Subnet/Network/Disk/SA on GCP, Instance→ENI/VPC/SG/IAM-Role on AWS).',
        '- BFS is bounded by `maxDepth` (default 10) and `nodeCap` (default 500, max 5000). Whichever fires first sets `truncated: true` in the stats.',
        '- Optional `minConfidence` skips edges below the threshold, useful for filtering out auto-link suggestions when only structural certainty matters.',
        '',
        'Every node carries its `depth` (1 = direct dependency); every edge carries the full `:CONNECTS_TO` property contract (`source`, `via`, `confidence`, `evidence`) plus writer-specific extras (protocol, port, role, observed-tcp stats…). Application owners of reached Components are joined back in for context.',
      ].join('\n'),
      querystring: {
        type: 'object',
        required: ['id'],
        properties: {
          id:            { type: 'string', description: 'Application or Component id (UUID).' },
          maxDepth:      { type: 'integer', minimum: 1, maximum: 20,   default: DEPS_DEFAULT_MAX_DEPTH },
          nodeCap:       { type: 'integer', minimum: 1, maximum: DEPS_MAX_NODE_CAP, default: DEPS_DEFAULT_NODE_CAP },
          minConfidence: { type: 'integer', minimum: 0, maximum: 100, default: 0 },
        },
      },
      response: {
        200: GraphDependenciesResponseSchema,
        400: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    const { id } = req.query
    const maxDepth      = req.query.maxDepth      ?? DEPS_DEFAULT_MAX_DEPTH
    const nodeCap       = Math.min(req.query.nodeCap ?? DEPS_DEFAULT_NODE_CAP, DEPS_MAX_NODE_CAP)
    const minConfidence = req.query.minConfidence ?? 0
    if (!id) return reply.badRequest('id required')

    // Resolve the root and expand to BFS seeds. Application → contained
    // Components; Component → itself. Anything else is a 404 — Infra has
    // /graph/impact (the forward direction), not /dependencies.
    const rootRecords = await query(`
      MATCH (root {id: $id})
      WHERE root:Application OR root:Component
      OPTIONAL MATCH (root)-[:CONTAINS]->(c:Component)
      WITH root, labels(root) AS lbls,
           CASE WHEN root:Application THEN collect(DISTINCT c) ELSE [root] END AS seeds
      RETURN root, lbls, seeds
    `, { id })
    if (!rootRecords.length) {
      return reply.notFound('No Application or Component with that id (Infra ids use /graph/impact)')
    }

    const rootNode  = rootRecords[0].get('root')
    const rootLabels = rootRecords[0].get('lbls') || []
    const rootLabel = rootLabels.includes('Application') ? 'Application' : 'Component'
    const seedNodes = rootRecords[0].get('seeds') || []
    const startComponents = seedNodes.map(n => ({
      ...props(n),
    }))

    // BFS frontier — one Cypher round-trip per depth layer. Predictable
    // cap behaviour, no exponential blow-up from variable-length paths,
    // and we get to enforce nodeCap mid-layer without truncating
    // mid-relationship.
    const visited  = new Map()   // id -> { props, label, depth }
    const edges    = []
    const edgeKeys = new Set()
    let truncated = false
    let reachedDepth = 0

    // Seed the visited set with the start components themselves at depth 0,
    // so a seed that's also a downstream dependency doesn't get re-walked.
    for (const seed of seedNodes) {
      const sp = props(seed)
      if (sp?.id) visited.set(sp.id, { props: sp, label: 'Component', depth: 0 })
    }

    let frontier = seedNodes.map(n => n.properties.id).filter(Boolean)

    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      if (visited.size >= nodeCap) { truncated = true; break }
      const records = await query(`
        UNWIND $fromIds AS fromId
        MATCH (from {id: fromId})-[r:CONNECTS_TO]->(to)
        WHERE coalesce(r.confidence, 0) >= $minConfidence
        RETURN fromId, to, r, labels(to) AS toLabels
      `, { fromIds: frontier, minConfidence })

      const nextFrontier = []
      let layerHadHit = false
      for (const rec of records) {
        const fromId  = rec.get('fromId')
        const toNode  = rec.get('to')
        const edgeRel = rec.get('r')
        const toLabelsArr = rec.get('toLabels') || []
        const toProps = props(toNode)
        const toId    = toProps?.id
        if (!toId) continue
        layerHadHit = true

        // Dedup edges on the writer-MERGE key analogue: from/to/via/source.
        // (Role/role-level grants and per-protocol observed flows stay
        // distinct as a result, matching how the writers emit them.)
        const edgeProps = serialize(edgeRel.properties || {})
        const edgeKey = `${fromId}::${toId}::${edgeProps.via || ''}::${edgeProps.source || ''}::${edgeProps.role || ''}::${edgeProps.protocol || ''}`
        if (!edgeKeys.has(edgeKey)) {
          edgeKeys.add(edgeKey)
          edges.push({ from: fromId, to: toId, ...edgeProps })
        }

        if (!visited.has(toId)) {
          const label = toLabelsArr.find(l => ['Application', 'Component', 'Infra'].includes(l)) || toLabelsArr[0] || 'Node'
          visited.set(toId, { props: toProps, label, depth })
          reachedDepth = Math.max(reachedDepth, depth)
          if (visited.size >= nodeCap) { truncated = true; break }
          // Only Components and Infra propagate the walk — Applications are
          // join-back metadata, not a BFS frontier.
          if (label === 'Component' || label === 'Infra') nextFrontier.push(toId)
        }
      }
      if (!layerHadHit) break
      if (truncated) break
      frontier = nextFrontier
    }
    if (frontier.length && reachedDepth === maxDepth) {
      // We hit maxDepth and the frontier wasn't empty — more reachable.
      truncated = true
    }

    // Join back the owning Application for every reached Component (incident
    // responders care which app a leaked-in service belongs to).
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
      .filter(([, v]) => v.depth > 0)            // exclude seeds from the dependency list
      .map(([, v]) => ({ ...v.props, label: v.label, depth: v.depth }))
      .sort((a, b) => a.depth - b.depth || (a.name || '').localeCompare(b.name || ''))

    return {
      root: {
        id:    rootProps?.id,
        label: rootLabel,
        name:  rootProps?.name,
        tier:  serialize(rootProps?.tier),
      },
      startComponents,
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
      response:    { 200: { type: 'object', additionalProperties: true, properties: { hops: { type: 'integer' }, path: { type: 'array', items: { type: 'object', additionalProperties: true } } } }, 404: { type: 'object', properties: { error: { type: 'string' } } } },
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