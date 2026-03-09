import jwt from '@fastify/jwt'

export async function authPlugin(fastify) {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    fastify.log.warn('[auth] JWT_SECRET not set — authentication disabled, all routes open')
    // Decorate with a no-op so routes that call fastify.authenticate don't crash
    fastify.decorate('authenticate', async () => {})
    return
  }

  await fastify.register(jwt, {
    secret,
    sign:   { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
    verify: { extractToken: req => {
      // Accept Bearer header OR httpOnly cookie
      const auth = req.headers.authorization
      if (auth?.startsWith('Bearer ')) return auth.slice(7)
      return req.cookies?.appcloud_token
    }},
  })

  // Decorator used as a preHandler on protected routes
  fastify.decorate('authenticate', async (req, reply) => {
    try {
      await req.jwtVerify()
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Valid JWT required' })
    }
  })

  fastify.log.info('[auth] JWT authentication enabled')
}