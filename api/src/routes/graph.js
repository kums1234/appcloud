import neo4j from 'neo4j-driver'
import { props, serialize } from '../utils/serialize.js'
import { actorFromReq } from '../utils/audit.js'

// Neo4j requires `LIMIT $x` parameters to be Integer (not Number).
// Convert here so route-level params can stay plain JS ints.
const neo4jInt = (n) => neo4j.int(n)
import {
  GraphTopologyResponseSchema,
  GraphImpactResponseSchema,
} from '../schemas/openapi.js'

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