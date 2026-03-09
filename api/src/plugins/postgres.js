import fs from 'fs'

function readSecret(fileEnvVar, plainEnvVar, fallback = '') {
  const filePath = process.env[fileEnvVar]
  if (filePath) {
    try { return fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  return process.env[plainEnvVar] || fallback
}

const stub = { pool: null, query: async () => [], audit: async () => {} }

// Called directly on the root fastify instance — no encapsulation issues
export async function postgresPlugin(fastify) {
  const host = process.env.POSTGRES_HOST || ''
  if (!host) {
    fastify.decorate('pg', stub)
    return
  }

  let pg
  try {
    pg = (await import('pg')).default
  } catch {
    fastify.log.warn('pg package not installed — PostgreSQL disabled')
    fastify.decorate('pg', stub)
    return
  }

  const user     = readSecret('PG_USERNAME_FILE', 'POSTGRES_USER', 'postgres')
  const password = readSecret('PG_PASSWORD_FILE', 'POSTGRES_PASSWORD', '')
  const database = process.env.POSTGRES_DB || 'appcloud'
  const port     = parseInt(process.env.POSTGRES_PORT || '5432')
  const pool     = new pg.Pool({ host, port, database, user, password, max: 10,
    connectionTimeoutMillis: 3000 })

  try {
    const client = await pool.connect()
    client.release()
    fastify.log.info('PostgreSQL connected')
  } catch (err) {
    fastify.log.warn(`PostgreSQL unavailable (${err.message}) — disabled`)
    fastify.decorate('pg', stub)
    return
  }

  fastify.decorate('pg', {
    pool,
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    audit: async (actor, action, resourceType, resourceId, resourceName, metadata = {}, diff = null) => {
      try {
        await pool.query(
          `INSERT INTO audit_log(actor,action,resource_type,resource_id,resource_name,metadata,diff)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [actor, action, resourceType, resourceId, resourceName,
           JSON.stringify(metadata), diff ? JSON.stringify(diff) : null]
        )
      } catch {}
    }
  })

  fastify.addHook('onClose', async () => pool.end())
}