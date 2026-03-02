// routes/graph.js — advanced graph queries and search
export default async function graphRoutes(fastify) {
const toInt = v => v == null ? null : typeof v.toNumber === 'function' ? v.toNumber() : Number(v)
  const { query } = fastify.neo4j

  // GET /graph/path?from=componentId&to=componentId — shortest path between two components
  fastify.get('/path', async (req, reply) => {
    const { from, to } = req.query
    if (!from || !to) return reply.badRequest('from and to query params required')

    const records = await query(`
      MATCH (src:Component {id: $from}), (dst:Component {id: $to})
      MATCH path = shortestPath((src)-[*]->(dst))
      RETURN [n IN nodes(path) | {label: labels(n)[0], name: n.name, id: n.id}] AS nodes,
             length(path) AS hops
    `, { from, to })

    if (!records.length) return reply.notFound('No path found between these components')
    const r = records[0]
    return {
      hops: toInt(r.get('hops')),
      path: r.get('nodes')
    }
  })

  // GET /graph/cross-app-dependencies — all cross-app component connections
  fastify.get('/cross-app-dependencies', async (req, reply) => {
    const records = await query(`
      MATCH (a1:Application)-[:CONTAINS]->(c1:Component)
            -[conn:CONNECTS_TO]->(c2:Component)<-[:CONTAINS]-(a2:Application)
      WHERE a1 <> a2
      RETURN DISTINCT
        a1.name AS fromApp, a1.tier AS fromTier,
        c1.name AS fromComponent,
        conn.protocol AS protocol, conn.port AS port,
        c2.name AS toComponent,
        a2.name AS toApp, a2.tier AS toTier
      ORDER BY a1.tier, a1.name
    `)

    return records.map(r => ({
      from: { app: r.get('fromApp'), tier: r.get('fromTier'), component: r.get('fromComponent') },
      connection: { protocol: r.get('protocol'), port: r.get('port') ? toInt(r.get('port')) : null },
      to: { app: r.get('toApp'), tier: r.get('toTier'), component: r.get('toComponent') }
    }))
  })

  // GET /graph/summary — high-level counts and stats
  fastify.get('/summary', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application) WITH count(a) AS appCount
      MATCH (c:Component) WITH appCount, count(c) AS componentCount
      MATCH (i:Infra) WITH appCount, componentCount, count(i) AS infraCount
      MATCH (ch:Change) WITH appCount, componentCount, infraCount, count(ch) AS changeCount
      MATCH (u:User) WITH appCount, componentCount, infraCount, changeCount, count(u) AS userCount
      MATCH (ch2:Change {status: "draft"}) WITH appCount, componentCount, infraCount, changeCount, userCount, count(ch2) AS pendingChanges
      MATCH (i2:Infra {public: true}) WITH appCount, componentCount, infraCount, changeCount, userCount, pendingChanges, count(i2) AS publicInfra
      RETURN appCount, componentCount, infraCount, changeCount, userCount, pendingChanges, publicInfra
    `)

    const r = records[0]
    return {
      applications: toInt(r.get('appCount')),
      components: toInt(r.get('componentCount')),
      infraResources: toInt(r.get('infraCount')),
      changes: toInt(r.get('changeCount')),
      users: toInt(r.get('userCount')),
      pendingChanges: toInt(r.get('pendingChanges')),
      publicInfraCount: toInt(r.get('publicInfra'))
    }
  })

  // GET /graph/impact?infraId=x — what apps/components are affected if this infra goes down
  fastify.get('/impact', async (req, reply) => {
    const { infraId } = req.query
    if (!infraId) return reply.badRequest('infraId query param required')

    const records = await query(`
      MATCH (i:Infra {id: $infraId})<-[:DEPLOYED_ON]-(c:Component)<-[:CONTAINS]-(a:Application)
      RETURN i.name AS infra,
             collect(DISTINCT {name: c.name, type: c.type}) AS components,
             collect(DISTINCT {name: a.name, tier: a.tier, environment: a.environment}) AS applications
    `, { infraId })

    if (!records.length) return reply.notFound('Infra resource not found or has no deployments')
    const r = records[0]
    return {
      infra: r.get('infra'),
      impactedComponents: r.get('components'),
      impactedApplications: r.get('applications')
        .sort((a, b) => a.tier - b.tier)
    }
  })

  // GET /graph/all-connections — all CONNECTS_TO + DEPLOYED_ON edges for graph UI
  fastify.get('/all-connections', async (req, reply) => {
    const [connRecords, deployRecords] = await Promise.all([
      query(`
        MATCH (c1:Component)-[r:CONNECTS_TO]->(c2:Component)
        OPTIONAL MATCH (a1:Application)-[:CONTAINS]->(c1)
        OPTIONAL MATCH (a2:Application)-[:CONTAINS]->(c2)
        RETURN c1.id AS fromId, c1.name AS fromName, a1.name AS fromApp,
               c2.id AS toId,   c2.name AS toName,   a2.name AS toApp,
               r.protocol AS protocol, r.port AS port
      `),
      query(`
        MATCH (c:Component)-[:DEPLOYED_ON]->(i:Infra)
        RETURN c.id AS compId, i.id AS infraId
      `)
    ])

    return {
      connections: connRecords.map(r => ({
        fromId:   r.get('fromId'),
        fromName: r.get('fromName'),
        fromApp:  r.get('fromApp'),
        toId:     r.get('toId'),
        toName:   r.get('toName'),
        toApp:    r.get('toApp'),
        protocol: r.get('protocol'),
        port:     toInt(r.get('port')),
      })),
      deployments: deployRecords.map(r => ({
        compId:  r.get('compId'),
        infraId: r.get('infraId'),
      }))
    }
  })

  // GET /graph/snapshots — list snapshots
  fastify.get('/snapshots', async (req, reply) => {
    const records = await query(`
      MATCH (s:Snapshot)
      RETURN s ORDER BY s.createdAt DESC
    `)
    return records.map(r => r.get('s').properties)
  })

  // POST /graph/snapshots — create a new snapshot
  fastify.post('/snapshots', async (req, reply) => {
    const { label } = req.body
    const records = await query(`
      MATCH (a:Application) WITH count(a) AS appCount
      MATCH (c:Component) WITH appCount, count(c) AS componentCount
      MATCH (i:Infra) WITH appCount, componentCount, count(i) AS infraCount
      CREATE (s:Snapshot {
        id: randomUUID(),
        createdAt: datetime(),
        label: $label,
        nodeCount: appCount + componentCount + infraCount
      })
      RETURN s
    `, { label: label || `snapshot-${new Date().toISOString().split('T')[0]}` })

    reply.code(201)
    return records[0].get('s').properties
  })
}