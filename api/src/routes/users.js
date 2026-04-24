// routes/users.js
// Profile and role data lives in Postgres.
// Neo4j User nodes are lightweight stubs (id + name) kept as identity anchors
// for future provenance relationships (e.g. which user authored an assessment).

import { serialize } from '../utils/serialize.js'

export default async function userRoutes(fastify) {
  const { write } = fastify.neo4j
  const pg   = fastify.pg
  const auth = { preHandler: fastify.authenticate }
  const actor = (req) => req.user?.name || req.user?.id || 'system'

  // ── GET /users ──────────────────────────────────────────────────────────────
  fastify.get('/', async (req, reply) => {
    return pg.query(
      'SELECT id, name, email, role, created_at, last_login_at FROM users ORDER BY name'
    )
  })

  // ── GET /users/:id ──────────────────────────────────────────────────────────
  fastify.get('/:id', async (req, reply) => {
    const rows = await pg.query(
      'SELECT id, name, email, role, created_at, last_login_at FROM users WHERE id = $1 LIMIT 1',
      [req.params.id]
    )
    if (!rows.length) return reply.notFound('User not found')
    return rows[0]
  })

  // ── POST /users ─────────────────────────────────────────────────────────────
  // Creates a profile without a password (use /auth/register for full signup).
  // Useful for seeding viewer/admin entries from the Users admin page.
  fastify.post('/', { ...auth }, async (req, reply) => {
    const { name, email, role = 'user' } = req.body
    if (!name || !email) return reply.badRequest('name and email are required')

    let user
    try {
      const rows = await pg.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, 'unset', $3)
         RETURNING id, name, email, role, created_at`,
        [name, email, role]
      )
      user = rows[0]
    } catch (err) {
      if (err.code === '23505') return reply.conflict('Email already registered')
      throw err
    }

    // Create Neo4j stub so this user is a stable identity in the graph.
    await write('MERGE (u:User {id: $id}) SET u.name = $name', { id: user.id, name: user.name })
      .catch(() => {})

    pg.audit(actor(req), 'create', 'User', user.id, user.name).catch(() => {})
    reply.code(201)
    return user
  })

  // ── PATCH /users/:id ────────────────────────────────────────────────────────
  fastify.patch('/:id', { ...auth }, async (req, reply) => {
    const { name, email, role } = req.body
    const rows = await pg.query(
      `UPDATE users
       SET name  = COALESCE($2, name),
           email = COALESCE($3, email),
           role  = COALESCE($4, role)
       WHERE id = $1
       RETURNING id, name, email, role, created_at, last_login_at`,
      [req.params.id, name, email, role]
    )
    if (!rows.length) return reply.notFound('User not found')
    const user = rows[0]

    // Keep Neo4j stub name in sync
    if (name) {
      await write('MATCH (u:User {id: $id}) SET u.name = $name',
        { id: req.params.id, name }).catch(() => {})
    }

    pg.audit(actor(req), 'update', 'User', user.id, user.name, { changes: req.body }).catch(() => {})
    return user
  })

  // ── DELETE /users/:id ───────────────────────────────────────────────────────
  fastify.delete('/:id', { ...auth }, async (req, reply) => {
    const rows = await pg.query(
      'DELETE FROM users WHERE id = $1 RETURNING name', [req.params.id]
    )
    if (!rows.length) return reply.notFound('User not found')

    // Remove Neo4j stub and its relationships.
    await write('MATCH (u:User {id: $id}) DETACH DELETE u', { id: req.params.id }).catch(() => {})

    pg.audit(actor(req), 'delete', 'User', req.params.id, rows[0].name).catch(() => {})
    reply.code(204)
  })
}