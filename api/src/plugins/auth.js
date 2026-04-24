// plugins/auth.js
// Headless API-key gate. Reads the expected key from (in order):
//   1. APPCLOUD_API_KEY_FILE  (file path — typical k8s secret mount)
//   2. APPCLOUD_API_KEY       (env var — typical docker-compose / local dev)
//
// When neither is set, auth is disabled and fastify.authenticate is a no-op
// so the same preHandler works in both modes. This matches the previous JWT
// plugin's behaviour and keeps local dev frictionless.
//
// Callers authenticate by sending:  X-API-Key: <key>
// A missing or mismatched key on a protected route returns 401.
import fs from 'fs'

function readKey() {
  const filePath = process.env.APPCLOUD_API_KEY_FILE
  if (filePath) {
    try { return fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  return (process.env.APPCLOUD_API_KEY || '').trim()
}

export async function authPlugin(fastify) {
  const expected = readKey()

  if (!expected) {
    fastify.log.warn('[auth] APPCLOUD_API_KEY not set — authentication disabled, all routes open')
    fastify.decorate('authenticate', async () => {})
    return
  }

  fastify.decorate('authenticate', async (req, reply) => {
    const provided = (req.headers['x-api-key'] || '').trim()
    if (!provided || provided !== expected) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Valid X-API-Key header required' })
    }
  })

  fastify.log.info('[auth] API-key authentication enabled (X-API-Key header)')
}
