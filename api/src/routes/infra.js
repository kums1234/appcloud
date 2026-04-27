import neo4j from 'neo4j-driver'
import { props, serialize } from '../utils/serialize.js'
import { makeRouteHelpers } from '../utils/route-helpers.js'
import { actorFromReq } from '../utils/audit.js'
import {
  InfraSchema,
  InfraCreateBodySchema,
  InfraPatchBodySchema,
  IdParamSchema,
  StandardErrorResponses,
} from '../schemas/openapi.js'

export default async function infraRoutes(fastify) {
  const { query, write } = fastify.neo4j
  const { withAuth } = makeRouteHelpers(fastify)
  const actor = actorFromReq

  // GET /infra
  fastify.get('/', {
    schema: {
      summary:     'List Infra',
      description: 'Returns Infra nodes ordered by provider then name. Filter by `provider` (aws/azure/gcp) and/or `public` (true/false). Paginated — default page size 500, max 5000. At realistic data volumes (10k+ resources) pulling everything in one response is multi-second + memory-spike on the client; use `?offset=` to page through.',
      querystring: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['aws', 'azure', 'gcp'] },
          public:   { type: 'string', enum: ['true', 'false'] },
          limit:    { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
          offset:   { type: 'integer', minimum: 0, default: 0 },
        },
      },
      response:    { 200: { type: 'array', items: InfraSchema } },
    },
  }, async (req, reply) => {
    const { provider, public: isPublic, limit = 500, offset = 0 } = req.query
    const filters = []
    if (provider)             filters.push('i.provider = $provider')
    if (isPublic !== undefined) filters.push('i.public = $isPublic')
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const records = await query(`
      MATCH (i:Infra) ${where}
      RETURN i ORDER BY i.provider, i.name
      SKIP $offset LIMIT $limit
    `, { provider, isPublic: isPublic === 'true', limit: neo4j.int(limit), offset: neo4j.int(offset) })
    return records.map(r => props(r.get('i')))
  })

  // GET /infra/:id
  fastify.get('/:id', {
    schema: {
      summary:     'Get one Infra node',
      description: 'Returns the Infra plus its `deployments` — every Component that owns it (with the containing Application name when available).',
      params:      IdParamSchema,
      response:    { 200: InfraSchema, 404: StandardErrorResponses[404] },
    },
  }, async (req, reply) => {
    const records = await query(`
      MATCH (i:Infra {id: $id})
      OPTIONAL MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
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
  fastify.post('/', withAuth({
    schema: {
      summary:     'Manually create an Infra node',
      description: 'Most Infra comes from discovery scans (`/discovery/scan/*`). Use this for resources that aren\'t in any cloud-API surface — e.g. an on-prem appliance you want represented in the graph.',
      body:        InfraCreateBodySchema,
      response:    { 201: InfraSchema },
    },
  }), async (req, reply) => {
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
  fastify.patch('/:id', withAuth({
    schema: {
      summary:     'Update an Infra node (name / region / public flag)',
      params:      IdParamSchema,
      body:        InfraPatchBodySchema,
      response:    { 200: InfraSchema, 404: StandardErrorResponses[404] },
    },
  }), async (req, reply) => {
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
  fastify.delete('/:id', withAuth({
    schema: {
      summary:     'Delete an Infra node',
      description: 'DETACH-deletes the node and every relationship it participates in. The next discovery scan will re-create it if it still exists in the cloud.',
      params:      IdParamSchema,
      response:    { 204: { type: 'null' } },
    },
  }), async (req, reply) => {
    const pre = await query('MATCH (i:Infra {id: $id}) RETURN i.name AS name',
      { id: req.params.id })
    const name = pre[0]?.get('name') || req.params.id
    await write(`MATCH (i:Infra {id: $id}) DETACH DELETE i`, { id: req.params.id })
    fastify.pg.audit(actor(req), 'delete', 'Infra', req.params.id, name).catch(() => {})
    reply.code(204)
  })

  // GET /infra/shared/resources
  fastify.get('/shared/resources', {
    schema: {
      summary:     'Infra owned by more than one Application (shared services)',
      description: 'Returns Infra nodes whose owning Components live in two or more distinct Applications, ordered by `usedByApps` desc. Useful for surfacing shared services that need coordination during change windows.',
      response:    { 200: { type: 'array', items: { ...InfraSchema, properties: { ...InfraSchema.properties, usedByApps: { type: 'integer' } } } } },
    },
  }, async (req, reply) => {
    const records = await query(`
      MATCH (i:Infra)<-[:CONNECTS_TO {via: 'component-mapping'}]-(c:Component)<-[:CONTAINS]-(a:Application)
      WITH i, count(DISTINCT a) AS appCount
      WHERE appCount > 1
      RETURN i, appCount ORDER BY appCount DESC
    `)
    return records.map(r => ({ ...props(r.get('i')), usedByApps: serialize(r.get('appCount')) }))
  })

  // GET /infra/public/exposed
  fastify.get('/public/exposed', {
    schema: {
      summary:     'Internet-exposed Infra (public = true)',
      description: 'Returns every Infra node flagged `public: true` plus the names of any Components that own them. Cross-cuts the security review surface.',
      response:    { 200: { type: 'array', items: { ...InfraSchema, properties: { ...InfraSchema.properties, components: { type: 'array', items: { type: 'string' } } } } } },
    },
  }, async (req, reply) => {
    const records = await query(`
      MATCH (i:Infra {public: true})
      OPTIONAL MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
      RETURN i, collect(DISTINCT c.name) AS components
    `)
    return records.map(r => ({ ...props(r.get('i')), components: r.get('components') }))
  })
}