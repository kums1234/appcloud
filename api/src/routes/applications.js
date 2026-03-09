import { props, serialize } from '../utils/serialize.js'

export default async function applicationRoutes(fastify) {
  const { query, write } = fastify.neo4j
  const auth = { preHandler: fastify.authenticate }

  // ── actor helper — name from JWT or fallback ────────────────────────────────
  const actor = (req) => req.user?.name || req.user?.id || 'system'

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
  fastify.post('/', { ...auth }, async (req, reply) => {
    const { name, tier, owner, environment, availability, confidentiality, domain } = req.body
    const records = await write(`
      CREATE (a:Application {
        id: randomUUID(), name: $name, tier: $tier,
        owner: $owner, environment: $environment,
        availability: $availability, confidentiality: $confidentiality,
        domain: $domain
      }) RETURN a
    `, { name, tier: parseInt(tier), owner, environment,
         availability: availability || '99.9',
         confidentiality: confidentiality || 'internal',
         domain: domain || '' })
    const result = props(records[0].get('a'))
    fastify.pg.audit(actor(req), 'create', 'Application', result.id, result.name,
      { tier: result.tier, environment: result.environment }).catch(() => {})
    reply.code(201)
    return result
  })

  // PATCH /applications/:id
  fastify.patch('/:id', { ...auth }, async (req, reply) => {
    const { name, tier, owner, environment, availability, confidentiality, domain } = req.body
    const records = await write(`
      MATCH (a:Application {id: $id})
      SET a.name             = coalesce($name, a.name),
          a.tier             = coalesce($tier, a.tier),
          a.owner            = coalesce($owner, a.owner),
          a.environment      = coalesce($environment, a.environment),
          a.availability     = coalesce($availability, a.availability),
          a.confidentiality  = coalesce($confidentiality, a.confidentiality),
          a.domain           = coalesce($domain, a.domain)
      RETURN a
    `, { id: req.params.id, name, tier: tier ? parseInt(tier) : null,
         owner, environment, availability, confidentiality, domain })
    if (!records.length) return reply.notFound('Application not found')
    const result = props(records[0].get('a'))
    fastify.pg.audit(actor(req), 'update', 'Application', result.id, result.name,
      { changes: req.body }).catch(() => {})
    return result
  })

  // DELETE /applications/:id
  fastify.delete('/:id', { ...auth }, async (req, reply) => {
    const pre = await query('MATCH (a:Application {id: $id}) RETURN a.name AS name',
      { id: req.params.id })
    const name = pre[0]?.get('name') || req.params.id
    await write(`MATCH (a:Application {id: $id}) DETACH DELETE a`, { id: req.params.id })
    fastify.pg.audit(actor(req), 'delete', 'Application', req.params.id, name).catch(() => {})
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