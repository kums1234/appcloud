// routes/applications.js
export default async function applicationRoutes(fastify) {
const toInt = v => v == null ? null : typeof v.toNumber === 'function' ? v.toNumber() : Number(v)
  const { query, write } = fastify.neo4j

  // GET /applications — list all
  fastify.get('/', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application)
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      RETURN a, count(c) AS componentCount
      ORDER BY a.tier ASC, a.name ASC
    `)
    return records.map(r => ({
      ...r.get('a').properties,
      componentCount: toInt(r.get('componentCount'))
    }))
  })

  // GET /applications/:id — single app with full topology
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application {id: $id})
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      RETURN a,
        collect(DISTINCT c) AS components,
        collect(DISTINCT i) AS infra
    `, { id: req.params.id })

    if (!records.length) return reply.notFound('Application not found')

    const r = records[0]
    return {
      ...r.get('a').properties,
      components: r.get('components').map(c => c.properties),
      infra: r.get('infra').map(i => i.properties)
    }
  })

  // POST /applications — create
  fastify.post('/', async (req, reply) => {
    const { name, tier, owner, environment } = req.body
    const records = await write(`
      CREATE (a:Application {
        id: randomUUID(),
        name: $name,
        tier: $tier,
        owner: $owner,
        environment: $environment
      }) RETURN a
    `, { name, tier: parseInt(tier), owner, environment })

    reply.code(201)
    return records[0].get('a').properties
  })

  // PATCH /applications/:id — update
  fastify.patch('/:id', async (req, reply) => {
    const { name, tier, owner, environment } = req.body
    const records = await write(`
      MATCH (a:Application {id: $id})
      SET a += {
        name: coalesce($name, a.name),
        tier: coalesce($tier, a.tier),
        owner: coalesce($owner, a.owner),
        environment: coalesce($environment, a.environment)
      }
      RETURN a
    `, { id: req.params.id, name, tier: tier ? parseInt(tier) : null, owner, environment })

    if (!records.length) return reply.notFound('Application not found')
    return records[0].get('a').properties
  })

  // DELETE /applications/:id
  fastify.delete('/:id', async (req, reply) => {
    await write(`
      MATCH (a:Application {id: $id})
      DETACH DELETE a
    `, { id: req.params.id })
    reply.code(204).send()
  })

  // GET /applications/:id/topology — full graph traversal
  fastify.get('/:id/topology', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application {id: $id})-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      OPTIONAL MATCH (c)-[conn:CONNECTS_TO]->(c2:Component)
      RETURN a,
        collect(DISTINCT c) AS components,
        collect(DISTINCT i) AS infra,
        collect(DISTINCT {from: c.name, to: c2.name, protocol: conn.protocol, port: conn.port}) AS connections
    `, { id: req.params.id })

    if (!records.length) return reply.notFound('Application not found')
    const r = records[0]
    return {
      application: r.get('a').properties,
      components: r.get('components').map(c => c.properties),
      infra: r.get('infra').map(i => i.properties),
      connections: r.get('connections').filter(c => c.to !== null)
    }
  })

  // GET /applications/:id/dependencies — cross-app dependencies
  fastify.get('/:id/dependencies', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application {id: $id})-[:CONTAINS]->(c1:Component)
            -[:CONNECTS_TO]->(c2:Component)<-[:CONTAINS]-(a2:Application)
      WHERE a <> a2
      RETURN DISTINCT a2.name AS dependsOn, a2.id AS dependsOnId,
             collect({from: c1.name, to: c2.name}) AS via
    `, { id: req.params.id })

    return records.map(r => ({
      dependsOn: r.get('dependsOn'),
      dependsOnId: r.get('dependsOnId'),
      via: r.get('via')
    }))
  })
}
