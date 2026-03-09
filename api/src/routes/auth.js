// routes/auth.js
// POST /auth/register  — create account in Postgres + Neo4j stub
// POST /auth/login     — verify against Postgres, return JWT
// GET  /auth/me        — current user from token
// POST /auth/refresh   — fresh token from valid one
// POST /auth/logout    — stateless; clears session hint

let bcrypt
try { bcrypt = (await import('bcrypt')).default } catch { bcrypt = null }

const SALT_ROUNDS = 10

export default async function authRoutes(fastify) {
  const { write: neo4jWrite } = fastify.neo4j
  const pg          = fastify.pg
  const authEnabled = !!fastify.jwt

  // ── helpers ──────────────────────────────────────────────────────────────────
  const hashPw   = (plain)        => bcrypt ? bcrypt.hash(plain, SALT_ROUNDS)
                                            : Promise.resolve('auth-disabled')
  const verifyPw = (plain, hash)  => {
    if (!bcrypt || hash === 'auth-disabled') return Promise.resolve(true)
    return bcrypt.compare(plain, hash)
  }
  const signToken = (u) => fastify.jwt.sign({
    id: u.id, name: u.name, email: u.email, role: u.role,
  })
  // Ensure a lightweight stub node exists in Neo4j for graph relationships
  const upsertNeo4jStub = (id, name) =>
    neo4jWrite(
      'MERGE (u:User {id: $id}) SET u.name = $name',
      { id, name }
    ).catch(() => {})

  // ── POST /auth/register ───────────────────────────────────────────────────
  fastify.post('/register', async (req, reply) => {
    const { name, email, password } = req.body || {}
    if (!name || !email || !password)
      return reply.badRequest('name, email and password are required')

    // First registered user becomes admin
    const countRows = await pg.query('SELECT COUNT(*) AS cnt FROM users')
    const isFirst   = parseInt(countRows[0]?.cnt ?? '0') === 0
    const role      = isFirst ? 'admin' : 'user'
    const hash      = await hashPw(password)

    let user
    try {
      const rows = await pg.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, role, created_at`,
        [name, email, hash, role]
      )
      user = rows[0]
    } catch (err) {
      if (err.code === '23505') return reply.conflict('Email already registered')
      throw err
    }

    // Keep Neo4j stub in sync
    await upsertNeo4jStub(user.id, user.name)

    pg.audit(user.name, 'register', 'User', user.id, user.name).catch(() => {})

    const token = authEnabled ? signToken(user) : null
    reply.code(201).send({ token, user })
  })

  // ── POST /auth/login ──────────────────────────────────────────────────────
  fastify.post('/login', async (req, reply) => {
    const { email, password } = req.body || {}
    if (!email || !password)
      return reply.badRequest('email and password are required')

    const rows = await pg.query(
      'SELECT id, name, email, password_hash, role FROM users WHERE email = $1 LIMIT 1',
      [email]
    )
    if (!rows.length) return reply.unauthorized('Invalid email or password')

    const user  = rows[0]
    const valid = await verifyPw(password, user.password_hash)
    if (!valid) return reply.unauthorized('Invalid email or password')

    // Update last_login_at
    pg.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]).catch(() => {})
    pg.audit(user.name, 'login', 'User', user.id, user.name).catch(() => {})

    const { password_hash: _, ...safeUser } = user
    const token = authEnabled ? signToken(safeUser) : null
    return { token, user: safeUser }
  })

  // ── GET /auth/me ──────────────────────────────────────────────────────────
  fastify.get('/me', { preHandler: fastify.authenticate }, async (req) => {
    const rows = await pg.query(
      'SELECT id, name, email, role, created_at, last_login_at FROM users WHERE id = $1 LIMIT 1',
      [req.user.id]
    )
    if (!rows.length) return { ...req.user }   // fallback to token payload
    return rows[0]
  })

  // ── POST /auth/refresh ────────────────────────────────────────────────────
  fastify.post('/refresh', { preHandler: fastify.authenticate }, async (req) => {
    const { passwordHash: _, password_hash: __, ...payload } = req.user
    return { token: signToken(payload) }
  })

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  fastify.post('/logout', async (req, reply) => {
    // Log the logout event if the request carries a valid token
    try {
      const user = await req.jwtVerify()
      pg.audit(user.name, 'logout', 'User', user.id, user.name).catch(() => {})
    } catch {}
    reply.code(204).send()
  })
}