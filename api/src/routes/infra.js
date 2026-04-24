import { props, serialize } from '../utils/serialize.js'

export default async function infraRoutes(fastify) {
  const { query, write } = fastify.neo4j
  const auth  = { preHandler: fastify.authenticate }
  const actor = (req) => req.headers['x-actor'] || 'system'

  // GET /infra
  fastify.get('/', async (req, reply) => {
    const { provider, public: isPublic } = req.query
    const filters = []
    if (provider)             filters.push('i.provider = $provider')
    if (isPublic !== undefined) filters.push('i.public = $isPublic')
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const records = await query(`
      MATCH (i:Infra) ${where}
      RETURN i ORDER BY i.provider, i.name
    `, { provider, isPublic: isPublic === 'true' })
    return records.map(r => props(r.get('i')))
  })

  // GET /infra/:id
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (i:Infra {id: $id})
      OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN i,
        collect(DISTINCT {component: c.name, application: a.name}) AS deployments
    `, { id: req.params.id })
    if (!records.length) return reply.notFound('Infra resource not found')
    const r = records[0]
    return {
      ...props(r.get('i')),
      deployments: r.get('deployments').filter(d => d.component !== null),
    }
  })

  // POST /infra
  fastify.post('/', { ...auth }, async (req, reply) => {
    const { name, provider, resource_type, region, public: isPublic } = req.body
    const records = await write(`
      CREATE (i:Infra {
        id: randomUUID(), name: $name, provider: $provider,
        resource_type: $resource_type, region: $region, public: $public
      }) RETURN i
    `, { name, provider, resource_type, region: region || '', public: !!isPublic })
    const result = props(records[0].get('i'))
    fastify.pg.audit(actor(req), 'create', 'Infra', result.id, result.name,
      { provider, resource_type }).catch(() => {})
    reply.code(201)
    return result
  })

  // PATCH /infra/:id
  fastify.patch('/:id', { ...auth }, async (req, reply) => {
    const { name, region, public: isPublic } = req.body
    const records = await write(`
      MATCH (i:Infra {id: $id})
      SET i.name   = coalesce($name, i.name),
          i.region = coalesce($region, i.region),
          i.public = coalesce($public, i.public)
      RETURN i
    `, { id: req.params.id, name, region, public: isPublic })
    if (!records.length) return reply.notFound('Infra not found')
    const result = props(records[0].get('i'))
    fastify.pg.audit(actor(req), 'update', 'Infra', result.id, result.name,
      { changes: req.body }).catch(() => {})
    return result
  })

  // DELETE /infra/:id
  fastify.delete('/:id', { ...auth }, async (req, reply) => {
    const pre = await query('MATCH (i:Infra {id: $id}) RETURN i.name AS name',
      { id: req.params.id })
    const name = pre[0]?.get('name') || req.params.id
    await write(`MATCH (i:Infra {id: $id}) DETACH DELETE i`, { id: req.params.id })
    fastify.pg.audit(actor(req), 'delete', 'Infra', req.params.id, name).catch(() => {})
    reply.code(204)
  })

  // GET /infra/shared/resources
  fastify.get('/shared/resources', async (req, reply) => {
    const records = await query(`
      MATCH (i:Infra)<-[:DEPLOYED_ON]-(c:Component)<-[:CONTAINS]-(a:Application)
      WITH i, count(DISTINCT a) AS appCount
      WHERE appCount > 1
      RETURN i, appCount ORDER BY appCount DESC
    `)
    return records.map(r => ({ ...props(r.get('i')), usedByApps: serialize(r.get('appCount')) }))
  })

  // GET /infra/public/exposed
  fastify.get('/public/exposed', async (req, reply) => {
    const records = await query(`
      MATCH (i:Infra {public: true})
      OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
      RETURN i, collect(DISTINCT c.name) AS components
    `)
    return records.map(r => ({ ...props(r.get('i')), components: r.get('components') }))
  })
}