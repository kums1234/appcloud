// routes/users.js
export default async function userRoutes(fastify) {
const toInt = v => v == null ? null : typeof v.toNumber === 'function' ? v.toNumber() : Number(v)
  const { query, write } = fastify.neo4j

  // GET /users
  fastify.get('/', async (req, reply) => {
    const records = await query('MATCH (u:User) RETURN u ORDER BY u.name')
    return records.map(r => r.get('u').properties)
  })

  // GET /users/:id
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (u:User {id: $id})
      OPTIONAL MATCH (u)-[:SUBMITTED]->(submitted:Change)
      OPTIONAL MATCH (u)-[:APPROVED]->(approved:Change)
      OPTIONAL MATCH (u)-[:REJECTED]->(rejected:Change)
      RETURN u,
        count(DISTINCT submitted) AS submittedCount,
        count(DISTINCT approved) AS approvedCount,
        count(DISTINCT rejected) AS rejectedCount
    `, { id: req.params.id })

    if (!records.length) return reply.notFound('User not found')
    const r = records[0]
    return {
      ...r.get('u').properties,
      activity: {
        submitted: toInt(r.get('submittedCount')),
        approved: toInt(r.get('approvedCount')),
        rejected: toInt(r.get('rejectedCount'))
      }
    }
  })

  // POST /users
  fastify.post('/', async (req, reply) => {
    const { name, role, email } = req.body
    const records = await write(`
      CREATE (u:User {id: randomUUID(), name: $name, role: $role, email: $email})
      RETURN u
    `, { name, role, email })

    reply.code(201)
    return records[0].get('u').properties
  })

  // PATCH /users/:id
  fastify.patch('/:id', async (req, reply) => {
    const { name, role, email } = req.body
    const records = await write(`
      MATCH (u:User {id: $id})
      SET u += {
        name: coalesce($name, u.name),
        role: coalesce($role, u.role),
        email: coalesce($email, u.email)
      }
      RETURN u
    `, { id: req.params.id, name, role, email })

    if (!records.length) return reply.notFound('User not found')
    return records[0].get('u').properties
  })

  // GET /users/:id/changes — all changes a user has interacted with
  fastify.get('/:id/changes', async (req, reply) => {
    const records = await query(`
      MATCH (u:User {id: $id})
      OPTIONAL MATCH (u)-[:SUBMITTED]->(s:Change)
      OPTIONAL MATCH (u)-[:APPROVED]->(a:Change)
      OPTIONAL MATCH (u)-[rej:REJECTED]->(r:Change)
      RETURN
        collect(DISTINCT {change: s, action: "submitted"}) AS submitted,
        collect(DISTINCT {change: a, action: "approved"}) AS approved,
        collect(DISTINCT {change: r, action: "rejected"}) AS rejected
    `, { id: req.params.id })

    if (!records.length) return reply.notFound('User not found')
    const r = records[0]
    const flatten = (list, action) =>
      list.filter(i => i.change !== null).map(i => ({ ...i.change.properties, action }))

    return [
      ...flatten(r.get('submitted'), 'submitted'),
      ...flatten(r.get('approved'), 'approved'),
      ...flatten(r.get('rejected'), 'rejected')
    ].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1)
  })
}
