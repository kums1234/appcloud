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

  const resolveApplicationId = async (key) => {
    const appRecords = await query(`
      MATCH (a:Application)
      WHERE a.id = $key OR a.name = $key
      RETURN a.id AS id
      LIMIT 1
    `, { key })
    return appRecords[0]?.get('id')
  }

  // GET /applications/:id
  fastify.get('/:id', async (req, reply) => {
    const appId = await resolveApplicationId(req.params.id)
    if (!appId) return reply.notFound('Application not found')

    const records = await query(`
      MATCH (a:Application {id: $id})
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      RETURN a, collect(DISTINCT c) AS components, collect(DISTINCT i) AS infra
    `, { id: appId })
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
    const appId = await resolveApplicationId(req.params.id)
    if (!appId) return reply.notFound('Application not found')

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
    `, { id: appId, name, tier: tier ? parseInt(tier) : null,
         owner, environment, availability, confidentiality, domain })
    if (!records.length) return reply.notFound('Application not found')
    const result = props(records[0].get('a'))
    fastify.pg.audit(actor(req), 'update', 'Application', result.id, result.name,
      { changes: req.body }).catch(() => {})
    return result
  })

  // DELETE /applications/:id
  fastify.delete('/:id', { ...auth }, async (req, reply) => {
    const appId = await resolveApplicationId(req.params.id)
    if (!appId) return reply.notFound('Application not found')

    // Fetch the app name first (non-destructive)
    const pre = await query('MATCH (a:Application {id: $id}) RETURN a.name AS name', { id: appId })
    const name = pre[0]?.get('name') || req.params.id

    // Components that belong only to this app (not shared with another app)
    const appComponents = await query(`
      MATCH (a:Application {id: $id})-[:CONTAINS]->(c:Component)
      WHERE NOT EXISTS {
        MATCH (c)<-[:CONTAINS]-(other:Application)
        WHERE other.id <> $id
      }
      RETURN collect(DISTINCT c.id) AS componentIds
    `, { id: appId })

    const componentIds = appComponents[0]?.get('componentIds') || []

    // Infra exclusively used by the components we will remove (not by any outside component)
    const appInfra = await query(`
      MATCH (i:Infra)<-[:DEPLOYED_ON]-(c:Component)
      WHERE c.id IN $componentIds
        AND NOT EXISTS {
          MATCH (i)<-[:DEPLOYED_ON]-(other:Component)
          WHERE NOT other.id IN $componentIds
        }
      RETURN collect(DISTINCT i.id) AS infraIds
    `, { componentIds })

    const infraIds = appInfra[0]?.get('infraIds') || []

    // Delete exclusively-owned components first
    if (componentIds.length > 0) {
      await write(`
        MATCH (c:Component)
        WHERE c.id IN $componentIds
        DETACH DELETE c
      `, { componentIds })
    }

    // Delete exclusively-owned infra next
    if (infraIds.length > 0) {
      await write(`
        MATCH (i)
        WHERE i.id IN $infraIds
        DETACH DELETE i
      `, { infraIds })
    }

    // Finally delete the application itself (DETACH removes CONTAINS relations)
    await write(`MATCH (a:Application {id: $id}) DETACH DELETE a`, { id: req.params.id })

    fastify.pg.audit(actor(req), 'delete', 'Application', req.params.id, name).catch(() => {})
    reply.code(204)
  })

  // GET /applications/:id/topology
  fastify.get('/:id/topology', async (req, reply) => {
    const appId = await resolveApplicationId(req.params.id)
    if (!appId) return reply.notFound('Application not found')

    const records = await query(`
      MATCH (a:Application {id: $id})
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      OPTIONAL MATCH (c)-[conn:CONNECTS_TO]->(c2:Component)
      RETURN a,
        collect(DISTINCT c)    AS components,
        collect(DISTINCT i)    AS infra,
        collect(DISTINCT {from: c.id, to: c2.id, protocol: conn.protocol, port: conn.port}) AS connections
    `, { id: appId })
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
    const appId = await resolveApplicationId(req.params.id)
    if (!appId) return reply.notFound('Application not found')

    const records = await query(`
      MATCH (a:Application {id: $id})-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:CONNECTS_TO]->(dep:Component)<-[:CONTAINS]-(depApp:Application)
      WHERE depApp.id <> $id
      RETURN collect(DISTINCT {app: depApp.name, component: dep.name}) AS deps
    `, { id: appId })
    return { dependencies: serialize(records[0]?.get('deps') ?? []) }
  })
}