// routes/infra.js
export default async function infraRoutes(fastify) {
const toInt = v => v == null ? null : typeof v.toNumber === 'function' ? v.toNumber() : Number(v)
  const { query, write } = fastify.neo4j

  // GET /infra
  fastify.get('/', async (req, reply) => {
    const { provider, public: isPublic } = req.query
    const filters = []
    if (provider) filters.push('i.provider = $provider')
    if (isPublic !== undefined) filters.push('i.public = $isPublic')
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

    const records = await query(`
      MATCH (i:Infra)
      ${where}
      RETURN i ORDER BY i.provider, i.name
    `, { provider, isPublic: isPublic === 'true' })

    return records.map(r => r.get('i').properties)
  })

  // GET /infra/:id
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (i:Infra {id: $id})
      OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      OPTIONAL MATCH (i)-[:NETWORK_CONNECTS]->(i2:Infra)
      RETURN i,
        collect(DISTINCT {component: c.name, application: a.name}) AS deployments,
        collect(DISTINCT i2) AS networkConnections
    `, { id: req.params.id })

    if (!records.length) return reply.notFound('Infra resource not found')
    const r = records[0]
    return {
      ...r.get('i').properties,
      deployments: r.get('deployments').filter(d => d.component !== null),
      networkConnections: r.get('networkConnections').map(n => n.properties)
    }
  })

  // POST /infra
  fastify.post('/', async (req, reply) => {
    const { provider, resource_type, name, region, public: isPublic } = req.body
    const records = await write(`
      CREATE (i:Infra {
        id: randomUUID(),
        provider: $provider,
        resource_type: $resource_type,
        name: $name,
        region: $region,
        public: $public
      }) RETURN i
    `, { provider, resource_type, name, region, public: isPublic ?? false })

    reply.code(201)
    return records[0].get('i').properties
  })

  // PATCH /infra/:id
  fastify.patch('/:id', async (req, reply) => {
    const { provider, resource_type, name, region, public: isPublic } = req.body
    const records = await write(`
      MATCH (i:Infra {id: $id})
      SET i += {
        provider: coalesce($provider, i.provider),
        resource_type: coalesce($resource_type, i.resource_type),
        name: coalesce($name, i.name),
        region: coalesce($region, i.region),
        public: coalesce($public, i.public)
      }
      RETURN i
    `, { id: req.params.id, provider, resource_type, name, region, public: isPublic ?? null })

    if (!records.length) return reply.notFound('Infra resource not found')
    return records[0].get('i').properties
  })

  // DELETE /infra/:id
  fastify.delete('/:id', async (req, reply) => {
    await write('MATCH (i:Infra {id: $id}) DETACH DELETE i', { id: req.params.id })
    reply.code(204).send()
  })

  // POST /infra/:id/network-connections
  fastify.post('/:id/network-connections', async (req, reply) => {
    const { targetId } = req.body
    await write(`
      MATCH (a:Infra {id: $id}), (b:Infra {id: $targetId})
      MERGE (a)-[:NETWORK_CONNECTS]->(b)
    `, { id: req.params.id, targetId })
    reply.code(201).send({ message: 'Network connection created' })
  })

  // GET /infra/shared — infra used by multiple apps
  fastify.get('/shared/resources', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application)-[:CONTAINS]->(c:Component)-[:DEPLOYED_ON]->(i:Infra)
      WITH i, collect(DISTINCT a.name) AS apps, count(DISTINCT a) AS appCount
      WHERE appCount > 1
      RETURN i, apps, appCount ORDER BY appCount DESC
    `)
    return records.map(r => ({
      ...r.get('i').properties,
      usedByApps: r.get('apps'),
      appCount: toInt(r.get('appCount'))
    }))
  })

  // GET /infra/public/exposed — all public-facing infra with context
  fastify.get('/public/exposed', async (req, reply) => {
    const records = await query(`
      MATCH (i:Infra {public: true})
      OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN i, c.name AS component, a.name AS application, a.tier AS tier
      ORDER BY a.tier ASC
    `)
    return records.map(r => ({
      ...r.get('i').properties,
      component: r.get('component'),
      application: r.get('application'),
      tier: r.get('tier')
    }))
  })
}
