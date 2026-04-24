import { props } from '../utils/serialize.js'

// ── Component taxonomy — single source of truth shared with the UI ──────────
// The Applications + Components + Infra pages previously each carried copies
// of these enums. GET /components/metadata exposes them so the UI hydrates
// once and renders consistently. Adding a new component subtype here
// surfaces in the UI without a React code change.
const COMPONENT_TYPES = [
  { id: 'api',    label: 'API',    color: '#38bdf8', icon: '⚡' },  // T.blue
  { id: 'db',     label: 'DB',     color: '#f59e0b', icon: '▤' },  // T.amber
  { id: 'worker', label: 'Worker', color: '#a78bfa', icon: '◐' },  // T.purple
  { id: 'ui',     label: 'UI',     color: '#ef4444', icon: '◈' },  // T.red
]

const TIERS = [
  { id: 1, label: 'Tier 1 — Mission critical', color: '#ef4444' },
  { id: 2, label: 'Tier 2 — Business critical', color: '#f59e0b' },
  { id: 3, label: 'Tier 3 — Important',         color: '#22c55e' },
  { id: 4, label: 'Tier 4 — Non-critical',      color: '#6b7280' },
]

const ENVIRONMENTS = ['production', 'staging', 'dev']

const AVAILABILITY_SLAS = [
  { id: '99.999', label: '99.999% (five nines, < 5 min/yr downtime)' },
  { id: '99.99',  label: '99.99% (four nines, < 53 min/yr)'           },
  { id: '99.9',   label: '99.9% (three nines, < 8.8 hr/yr)'           },
  { id: '99',     label: '99% (two nines, < 3.65 d/yr)'               },
]

const CONFIDENTIALITY = [
  { id: 'public',       label: 'Public',       color: '#22c55e' },
  { id: 'internal',     label: 'Internal',     color: '#38bdf8' },
  { id: 'confidential', label: 'Confidential', color: '#f59e0b' },
  { id: 'restricted',   label: 'Restricted',   color: '#ef4444' },
]

export default async function componentRoutes(fastify) {
  const { query, write } = fastify.neo4j
  const auth = { preHandler: fastify.authenticate }
  const audit = (...a) => fastify.pg.audit(...a).catch(() => {})
  const actor = (req) => req.headers['x-actor'] || 'system'

  // GET /components/metadata — taxonomy + enums for form builders
  fastify.get('/metadata', async () => ({
    componentTypes:   COMPONENT_TYPES,
    tiers:            TIERS,
    environments:     ENVIRONMENTS,
    availabilitySlas: AVAILABILITY_SLAS,
    confidentiality:  CONFIDENTIALITY,
  }))

  // GET /components
  fastify.get('/', async (req) => {
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
      // Return both field name variants so UI references work regardless
      // of whether they use appId/appName or applicationId/application
      appId:         r.get('appId'),
      applicationId: r.get('appId'),
      appName:       r.get('appName'),
      application:   r.get('appName'),
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
      // FIX 5: Guard against null — component may not belong to an application
      application: r.get('a') ? props(r.get('a')) : null,
      infra: r.get('infra').map(props),
    }
  })

  // POST /components
  fastify.post('/', { ...auth }, async (req, reply) => {
    const { name, type, runtime } = req.body
    // Accept both applicationId (sent by ComponentForm) and appId
    const appId = req.body.appId || req.body.applicationId || null
    const records = await write(`
      CREATE (c:Component { id: randomUUID(), name: $name, type: $type, runtime: $runtime })
      WITH c
      OPTIONAL MATCH (a:Application {id: $appId})
      FOREACH (_ IN CASE WHEN a IS NOT NULL THEN [1] ELSE [] END |
        CREATE (a)-[:CONTAINS]->(c)
      )
      RETURN c
    `, { name, type, runtime: runtime || null, appId })
    const result = props(records[0].get('c'))
    audit(actor(req), 'create', 'Component', result.id, result.name,
      { type: result.type, runtime: result.runtime, appId })
    reply.code(201)
    return result
  })

  // PATCH /components/:id — FIX 4: added auth guard
  fastify.patch('/:id', { ...auth }, async (req, reply) => {
    const { name, type, runtime } = req.body
    const records = await write(`
      MATCH (c:Component {id: $id})
      SET c.name    = coalesce($name, c.name),
          c.type    = coalesce($type, c.type),
          c.runtime = coalesce($runtime, c.runtime)
      RETURN c
    `, { id: req.params.id, name, type, runtime })
    if (!records.length) return reply.notFound('Component not found')
    const result = props(records[0].get('c'))
    audit(actor(req), 'update', 'Component', result.id, result.name,
      { changes: req.body })
    return result
  })

  // DELETE /components/:id — FIX 4: added auth guard
  fastify.delete('/:id', { ...auth }, async (req, reply) => {
    const pre = await query(
      `MATCH (c:Component {id:$id}) RETURN c.name AS name`, { id: req.params.id }
    )
    if (!pre.length) return reply.notFound('Component not found')
    const name = pre[0].get('name') || req.params.id
    await write(`MATCH (c:Component {id: $id}) DETACH DELETE c`, { id: req.params.id })
    audit(actor(req), 'delete', 'Component', req.params.id, name)
    reply.code(204)
  })

  // POST /components/:id/connections — FIX 4: added auth guard
  fastify.post('/:id/connections', { ...auth }, async (req, reply) => {
    const { targetId, protocol, port } = req.body
    await write(`
      MATCH (c1:Component {id: $id}), (c2:Component {id: $targetId})
      MERGE (c1)-[r:CONNECTS_TO]->(c2)
      SET r.protocol = $protocol, r.port = $port
    `, { id: req.params.id, targetId, protocol, port: port ? parseInt(port) : null })
    audit(actor(req), 'connect', 'Component', req.params.id, req.params.id,
      { targetId, protocol, port })
    reply.code(201)
    return { connected: true }
  })

  // POST /components/:id/deploy — FIX 4: added auth guard
  fastify.post('/:id/deploy', { ...auth }, async (req, reply) => {
    const { infraId } = req.body
    await write(`
      MATCH (c:Component {id: $id}), (i:Infra {id: $infraId})
      MERGE (c)-[:DEPLOYED_ON]->(i)
    `, { id: req.params.id, infraId })
    audit(actor(req), 'deploy', 'Component', req.params.id, req.params.id,
      { infraId })
    reply.code(201)
    return { deployed: true }
  })
}