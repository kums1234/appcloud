import { props, serialize } from '../utils/serialize.js'

export default async function componentRoutes(fastify) {
  const { query, write } = fastify.neo4j

  // GET /components
  fastify.get('/', async (req, reply) => {
    const { type } = req.query
    const records = await query(`
      MATCH (c:Component)
      ${type ? 'WHERE c.type = $type' : ''}
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN c, a.id AS appId, a.name AS appName
      ORDER BY c.name ASC
    `, { type })
    return records.map(r => ({
      ...props(r.get('c')),
      appId:   r.get('appId'),
      appName: r.get('appName'),
    }))
  })

  // GET /components/:id
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (c:Component {id: $id})
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      RETURN c, a, collect(DISTINCT i) AS infra
    `, { id: req.params.id })
    if (!records.length) return reply.notFound('Component not found')
    const r = records[0]
    return {
      ...props(r.get('c')),
      application: props(r.get('a')),
      infra: r.get('infra').map(props),
    }
  })

  // POST /components
  fastify.post('/', async (req, reply) => {
    const { name, type, runtime, appId } = req.body
    const records = await write(`
      CREATE (c:Component { id: randomUUID(), name: $name, type: $type, runtime: $runtime })
      WITH c
      OPTIONAL MATCH (a:Application {id: $appId})
      FOREACH (_ IN CASE WHEN a IS NOT NULL THEN [1] ELSE [] END |
        CREATE (a)-[:CONTAINS]->(c)
      )
      RETURN c
    `, { name, type, runtime: runtime || null, appId: appId || null })
    reply.code(201)
    return props(records[0].get('c'))
  })

  // PATCH /components/:id
  fastify.patch('/:id', async (req, reply) => {
    const { name, type, runtime } = req.body
    const records = await write(`
      MATCH (c:Component {id: $id})
      SET c.name    = coalesce($name, c.name),
          c.type    = coalesce($type, c.type),
          c.runtime = coalesce($runtime, c.runtime)
      RETURN c
    `, { id: req.params.id, name, type, runtime })
    if (!records.length) return reply.notFound('Component not found')
    return props(records[0].get('c'))
  })

  // DELETE /components/:id
  fastify.delete('/:id', async (req, reply) => {
    await write(`MATCH (c:Component {id: $id}) DETACH DELETE c`, { id: req.params.id })
    reply.code(204)
  })

  // POST /components/:id/connections
  fastify.post('/:id/connections', async (req, reply) => {
    const { targetId, protocol, port } = req.body
    await write(`
      MATCH (c1:Component {id: $id}), (c2:Component {id: $targetId})
      MERGE (c1)-[r:CONNECTS_TO]->(c2)
      SET r.protocol = $protocol, r.port = $port
    `, { id: req.params.id, targetId, protocol, port: port ? parseInt(port) : null })
    reply.code(201)
    return { connected: true }
  })

  // POST /components/:id/deploy
  fastify.post('/:id/deploy', async (req, reply) => {
    const { infraId } = req.body
    await write(`
      MATCH (c:Component {id: $id}), (i:Infra {id: $infraId})
      MERGE (c)-[:DEPLOYED_ON]->(i)
    `, { id: req.params.id, infraId })
    reply.code(201)
    return { deployed: true }
  })
}