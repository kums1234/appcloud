import { props, serialize } from '../utils/serialize.js'

export default async function graphRoutes(fastify) {
  const { query } = fastify.neo4j

  // GET /graph/summary
  fastify.get('/summary', async (req, reply) => {
    const [countRecords, compTypeRecords, infraProviderRecords, connRecords] = await Promise.all([
      query(`
        OPTIONAL MATCH (a:Application)
        OPTIONAL MATCH (c:Component)
        OPTIONAL MATCH (i:Infra)
        OPTIONAL MATCH (ch:Change)
        OPTIONAL MATCH (u:User)
        OPTIONAL MATCH (ch2:Change {status: "draft"})
        OPTIONAL MATCH (i2:Infra {public: true})
        RETURN count(DISTINCT a)   AS appCount,
               count(DISTINCT c)   AS componentCount,
               count(DISTINCT i)   AS infraCount,
               count(DISTINCT ch)  AS changeCount,
               count(DISTINCT u)   AS userCount,
               count(DISTINCT ch2) AS pendingChanges,
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
      changes:          serialize(r.get('changeCount')),
      users:            serialize(r.get('userCount')),
      pendingChanges:   serialize(r.get('pendingChanges')),
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
  fastify.get('/topology', async (req, reply) => {
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
        MATCH (c:Component)-[:DEPLOYED_ON]->(i:Infra)
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
  fastify.get('/impact', async (req, reply) => {
    const { infraId } = req.query
    if (!infraId) return reply.badRequest('infraId required')
    const records = await query(`
      MATCH (i:Infra {id: $infraId})<-[:DEPLOYED_ON]-(c:Component)<-[:CONTAINS]-(a:Application)
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
  fastify.get('/cross-app-dependencies', async (req, reply) => {
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
  fastify.get('/path', async (req, reply) => {
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
  fastify.get('/snapshots', async (req, reply) => {
    const records = await query(`MATCH (s:Snapshot) RETURN s ORDER BY s.createdAt DESC`)
    return records.map(r => props(r.get('s')))
  })

  // POST /graph/snapshots
  fastify.post('/snapshots', async (req, reply) => {
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
    reply.code(201)
    return props(records[0].get('s'))
  })
}