import neo4j from 'neo4j-driver'
import { props, serialize } from '../utils/serialize.js'
import { actorFromReq } from '../utils/audit.js'
import { rollupForInfra } from '../utils/cloud-rollup.js'
import { bfsWalk, WALK_DEFAULTS } from '../services/graph-walk.js'
import { toMermaid, toDot, simplifyWalk } from '../services/graph-visualize.js'

// Neo4j requires `LIMIT $x` parameters to be Integer (not Number).
// Convert here so route-level params can stay plain JS ints.
const neo4jInt = (n) => neo4j.int(n)
import {
  GraphTopologyResponseSchema,
  GraphWalkResponseSchema,
  StandardErrorResponses,
} from '../schemas/openapi.js'

const WALK_QUERYSTRING = {
  type: 'object',
  required: ['id'],
  properties: {
    id:            { type: 'string', description: 'Root node id (UUID).' },
    maxDepth:      { type: 'integer', minimum: 1, maximum: 20,   default: WALK_DEFAULTS.maxDepth },
    nodeCap:       { type: 'integer', minimum: 1, maximum: WALK_DEFAULTS.maxNodeCap, default: WALK_DEFAULTS.nodeCap },
    minConfidence: { type: 'integer', minimum: 0, maximum: 100, default: 0 },
  },
}

export default async function graphRoutes(fastify) {
  const actor = actorFromReq
  const { query } = fastify.neo4j

  // GET /graph/summary
  fastify.get('/summary', {
    schema: {
      summary:     'Counts: applications, components, infra, connections, public-exposed',
      description: 'A single-shot summary of the graph: total counts, components-by-type, infra-by-provider, and infra-by-rollup-bucket (resource-group / GCP project / AWS account+region). Used by dashboard tiles.',
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
            infraByRollup: {
              type: 'array',
              description: 'Per-rollup-bucket Infra counts (kind=azure-resource-group/gcp-project/aws-account-region, key=bucket id). Sorted by count desc. Cheap because the per-cloud parsers run in JS over the same Infra list `infraByProvider` already needs.',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    // Single `infraRows` pass pulls (provider, cloud_id) for every
    // Infra node; both `infraByProvider` and `infraByRollup` are
    // computed in JS over that one result set instead of two separate
    // MATCH (i:Infra) scans. The per-cloud rollup parsers run client-
    // side, so the dashboard and bfsWalk's per-node annotation agree on
    // bucket names.
    const [countRecords, compTypeRecords, connRecords, infraRows] = await Promise.all([
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
      query(`OPTIONAL MATCH ()-[r:CONNECTS_TO]->() RETURN count(r) AS connCount`),
      query(`MATCH (i:Infra) RETURN i.provider AS provider, i.cloud_id AS cloud_id`),
    ])
    const r = countRecords[0]

    // Two histograms over the same Infra rows.
    const providerHist = new Map()
    const rollupHist   = new Map()
    for (const rec of infraRows) {
      const provider = rec.get('provider')
      providerHist.set(provider, (providerHist.get(provider) || 0) + 1)

      const rollup = rollupForInfra({ provider, cloud_id: rec.get('cloud_id') })
      if (!rollup) continue
      const k = `${rollup.kind}::${rollup.key}`
      const prev = rollupHist.get(k)
      if (prev) prev.count += 1
      else rollupHist.set(k, { kind: rollup.kind, key: rollup.key, count: 1 })
    }

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
      infraByProvider: [...providerHist.entries()]
        .map(([provider, count]) => ({ provider: provider || 'unknown', count }))
        .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider)),
      infraByRollup: [...rollupHist.values()].sort((a, b) =>
        b.count - a.count || a.key.localeCompare(b.key)
      ),
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
      maxDepth:      req.query.maxDepth      ?? WALK_DEFAULTS.maxDepth,
      nodeCap:       Math.min(req.query.nodeCap ?? WALK_DEFAULTS.nodeCap, WALK_DEFAULTS.maxNodeCap),
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
      maxDepth:      req.query.maxDepth      ?? WALK_DEFAULTS.maxDepth,
      nodeCap:       Math.min(req.query.nodeCap ?? WALK_DEFAULTS.nodeCap, WALK_DEFAULTS.maxNodeCap),
      minConfidence: req.query.minConfidence  ?? 0,
    })
    if (!result) return reply.notFound('No Application or Component with that id (Infra ids use /graph/impact)')
    return result
  })

  // GET /graph/visualize?id=&direction=&format=&maxDepth=&nodeCap=&minConfidence=
  fastify.get('/visualize', {
    schema: {
      summary:     'Render a dependency/impact walk as Mermaid or DOT for inline visualisation',
      description: [
        'Runs the same polymorphic `bfsWalk` as `/graph/{dependencies,impact}`, then renders the result as text in one of two graph formats:',
        '',
        '- `mermaid` (default): GitHub renders this natively. Wrap the response in ```` ```mermaid ```` fences and commit alongside an incident runbook or design doc.',
        '- `dot`: Graphviz source. Pipe through `dot -Tpng > impact.png` or `dot -Tsvg > impact.svg` to produce a static image.',
        '',
        'Both formats group Components into per-Application subgraphs, group Infra into per-rollup-bucket clusters when multiple resources share a bucket, label edges with the `via` property, and highlight the root + seeds. Response is `text/plain`; status codes and error envelopes match `/graph/{dependencies,impact}`.',
      ].join('\n'),
      querystring: {
        type: 'object',
        required: ['id'],
        properties: {
          id:            { type: 'string', description: 'Root node id (UUID).' },
          direction:     { type: 'string', enum: ['outbound', 'inbound'], default: 'outbound', description: '`outbound` walks dependencies (what this leans on); `inbound` walks impact (what depends on this).' },
          format:        { type: 'string', enum: ['mermaid', 'dot'],      default: 'mermaid' },
          maxDepth:      { type: 'integer', minimum: 1, maximum: 20,   default: WALK_DEFAULTS.maxDepth },
          nodeCap:       { type: 'integer', minimum: 1, maximum: WALK_DEFAULTS.maxNodeCap, default: WALK_DEFAULTS.nodeCap },
          minConfidence: { type: 'integer', minimum: 0, maximum: 100, default: 0 },
          simplify:      { type: 'integer', minimum: 1, description: 'Collapse per-Application and per-rollup-bucket clusters with more than N members into a single placeholder node. Keeps Mermaid renderable on GitHub (which struggles past ~150 nodes) for big walks. Omitted = no simplification.' },
        },
      },
      response: {
        200: { type: 'string', description: 'Rendered graph text. Content-Type is text/plain.' },
        400: StandardErrorResponses[400],
        404: StandardErrorResponses[404],
      },
    },
  }, async (req, reply) => {
    const { id } = req.query
    const direction = req.query.direction ?? 'outbound'
    const format    = req.query.format    ?? 'mermaid'
    if (!id) return reply.badRequest('id required')

    const walk = await bfsWalk({
      query,
      rootId:        id,
      direction,
      maxDepth:      req.query.maxDepth      ?? WALK_DEFAULTS.maxDepth,
      nodeCap:       Math.min(req.query.nodeCap ?? WALK_DEFAULTS.nodeCap, WALK_DEFAULTS.maxNodeCap),
      minConfidence: req.query.minConfidence  ?? 0,
    })
    if (!walk) {
      return reply.notFound(direction === 'outbound'
        ? 'No Application or Component with that id (Infra ids use direction=inbound)'
        : 'No Application, Component, or Infra with that id')
    }
    const result = req.query.simplify ? simplifyWalk(walk, { collapseAt: req.query.simplify }) : walk
    const text = format === 'dot' ? toDot(result, { direction }) : toMermaid(result, { direction })
    reply.type('text/plain; charset=utf-8')
    return text
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