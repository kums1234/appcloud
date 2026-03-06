import { props, serialize } from '../utils/serialize.js'

export default async function applicationRoutes(fastify) {
  const { query, write } = fastify.neo4j

  // GET /applications
  fastify.get('/', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application)
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      RETURN a, count(c) AS componentCount
      ORDER BY a.tier ASC, a.name ASC
    `)
    return records.map(r => ({
      ...props(r.get('a')),
      componentCount: serialize(r.get('componentCount')),
    }))
  })

  // GET /applications/:id
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application {id: $id})
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      RETURN a, collect(DISTINCT c) AS components, collect(DISTINCT i) AS infra
    `, { id: req.params.id })
    if (!records.length) return reply.notFound('Application not found')
    const r = records[0]
    return {
      ...props(r.get('a')),
      components: r.get('components').map(props),
      infra:      r.get('infra').map(props),
    }
  })

  // POST /applications
  fastify.post('/', async (req, reply) => {
    const { name, tier, owner, environment } = req.body
    const records = await write(`
      CREATE (a:Application {
        id: randomUUID(), name: $name, tier: $tier,
        owner: $owner, environment: $environment
      }) RETURN a
    `, { name, tier: parseInt(tier), owner, environment })
    reply.code(201)
    return props(records[0].get('a'))
  })

  // PATCH /applications/:id
  fastify.patch('/:id', async (req, reply) => {
    const { name, tier, owner, environment } = req.body
    const records = await write(`
      MATCH (a:Application {id: $id})
      SET a.name        = coalesce($name, a.name),
          a.tier        = coalesce($tier, a.tier),
          a.owner       = coalesce($owner, a.owner),
          a.environment = coalesce($environment, a.environment)
      RETURN a
    `, { id: req.params.id, name, tier: tier ? parseInt(tier) : null, owner, environment })
    if (!records.length) return reply.notFound('Application not found')
    return props(records[0].get('a'))
  })

  // DELETE /applications/:id
  fastify.delete('/:id', async (req, reply) => {
    await write(`MATCH (a:Application {id: $id}) DETACH DELETE a`, { id: req.params.id })
    reply.code(204)
  })

  // GET /applications/:id/topology
  fastify.get('/:id/topology', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application {id: $id})
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      OPTIONAL MATCH (c)-[conn:CONNECTS_TO]->(c2:Component)
      RETURN a,
        collect(DISTINCT c)    AS components,
        collect(DISTINCT i)    AS infra,
        collect(DISTINCT {from: c.id, to: c2.id, protocol: conn.protocol, port: conn.port}) AS connections
    `, { id: req.params.id })
    if (!records.length) return reply.notFound('Application not found')
    const r = records[0]
    return {
      application: props(r.get('a')),
      components:  r.get('components').map(props),
      infra:       r.get('infra').map(props),
      connections: serialize(r.get('connections').filter(c => c.from && c.to)),
    }
  })

  // GET /applications/:id/dependencies
  fastify.get('/:id/dependencies', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application {id: $id})-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:CONNECTS_TO]->(dep:Component)<-[:CONTAINS]-(depApp:Application)
      WHERE depApp.id <> $id
      RETURN collect(DISTINCT {app: depApp.name, component: dep.name}) AS deps
    `, { id: req.params.id })
    return { dependencies: serialize(records[0]?.get('deps') ?? []) }
  })
}