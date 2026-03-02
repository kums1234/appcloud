// routes/components.js
export default async function componentRoutes(fastify) {
  const { query, write } = fastify.neo4j

  // GET /components
  fastify.get('/', async (req, reply) => {
    const { type } = req.query
    const records = await query(`
      MATCH (c:Component)
      ${type ? 'WHERE c.type = $type' : ''}
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN c, a.name AS application, a.id AS applicationId
      ORDER BY c.name
    `, { type })
    return records.map(r => ({
      ...r.get('c').properties,
      application: r.get('application'),
      applicationId: r.get('applicationId'),
    }))
  })

  // GET /components/:id
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (c:Component {id: $id})
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      OPTIONAL MATCH (c)-[out:CONNECTS_TO]->(target:Component)
      OPTIONAL MATCH (source:Component)-[inc:CONNECTS_TO]->(c)
      RETURN c,
        a.name AS application,
        collect(DISTINCT i) AS infra,
        collect(DISTINCT {name: target.name, id: target.id, protocol: out.protocol, port: out.port}) AS outbound,
        collect(DISTINCT {name: source.name, id: source.id, protocol: inc.protocol, port: inc.port}) AS inbound
    `, { id: req.params.id })

    if (!records.length) return reply.notFound('Component not found')
    const r = records[0]
    return {
      ...r.get('c').properties,
      application: r.get('application'),
      infra: r.get('infra').map(i => i.properties),
      outbound: r.get('outbound').filter(o => o.name !== null),
      inbound: r.get('inbound').filter(i => i.name !== null)
    }
  })

  // POST /components
  fastify.post('/', async (req, reply) => {
    const { name, type, runtime, applicationId } = req.body
    const records = await write(`
      CREATE (c:Component {id: randomUUID(), name: $name, type: $type, runtime: $runtime})
      WITH c
      OPTIONAL MATCH (a:Application {id: $applicationId})
      FOREACH (_ IN CASE WHEN a IS NOT NULL THEN [1] ELSE [] END |
        CREATE (a)-[:CONTAINS]->(c)
      )
      RETURN c
    `, { name, type, runtime, applicationId: applicationId || null })

    reply.code(201)
    return records[0].get('c').properties
  })

  // PATCH /components/:id
  fastify.patch('/:id', async (req, reply) => {
    const { name, type, runtime } = req.body
    const records = await write(`
      MATCH (c:Component {id: $id})
      SET c += {
        name: coalesce($name, c.name),
        type: coalesce($type, c.type),
        runtime: coalesce($runtime, c.runtime)
      }
      RETURN c
    `, { id: req.params.id, name, type, runtime })

    if (!records.length) return reply.notFound('Component not found')
    return records[0].get('c').properties
  })

  // DELETE /components/:id
  fastify.delete('/:id', async (req, reply) => {
    await write('MATCH (c:Component {id: $id}) DETACH DELETE c', { id: req.params.id })
    reply.code(204).send()
  })

  // POST /components/:id/connections — add CONNECTS_TO edge
  fastify.post('/:id/connections', async (req, reply) => {
    const { targetId, protocol, port } = req.body
    await write(`
      MATCH (src:Component {id: $id}), (dst:Component {id: $targetId})
      MERGE (src)-[r:CONNECTS_TO {protocol: $protocol, port: $port}]->(dst)
    `, { id: req.params.id, targetId, protocol, port: parseInt(port) })

    reply.code(201).send({ message: 'Connection created' })
  })

  // DELETE /components/:id/connections/:targetId
  fastify.delete('/:id/connections/:targetId', async (req, reply) => {
    await write(`
      MATCH (src:Component {id: $id})-[r:CONNECTS_TO]->(dst:Component {id: $targetId})
      DELETE r
    `, { id: req.params.id, targetId: req.params.targetId })
    reply.code(204).send()
  })

  // POST /components/:id/deploy — link to Infra
  fastify.post('/:id/deploy', async (req, reply) => {
    const { infraId } = req.body
    await write(`
      MATCH (c:Component {id: $id}), (i:Infra {id: $infraId})
      MERGE (c)-[:DEPLOYED_ON]->(i)
    `, { id: req.params.id, infraId })
    reply.code(201).send({ message: 'Deployed' })
  })
}