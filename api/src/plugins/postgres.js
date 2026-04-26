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

  // Apply the audit_log evolution that adds actor_key_id + actor_scope
  // columns. Idempotent (`ALTER TABLE … ADD COLUMN IF NOT EXISTS …`) so
  // it's safe to run on every startup; mirrors postgres-init/11-audit-evolution.sql.
  try {
    await pool.query(`
      ALTER TABLE audit_log
        ADD COLUMN IF NOT EXISTS actor_key_id UUID
          REFERENCES api_keys(id) ON DELETE SET NULL;
      ALTER TABLE audit_log
        ADD COLUMN IF NOT EXISTS actor_scope TEXT;
      CREATE INDEX IF NOT EXISTS idx_audit_log_actor_key
        ON audit_log(actor_key_id) WHERE actor_key_id IS NOT NULL;
    `)
  } catch (err) {
    // The api_keys FK may not exist yet on a brand-new DB if the auth
    // plugin runs after this. Log + continue; the auth plugin's CREATE
    // TABLE IF NOT EXISTS api_keys runs before any audit() call.
    fastify.log.warn(`[pg] audit_log evolution skipped: ${err.message}`)
  }

  fastify.decorate('pg', {
    pool,
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    // audit() accepts the actor as a string (legacy) OR an object of the
    // shape { name, keyId, scope } (since slice 5 — RBAC). The object form
    // populates the new audit_log columns; the string form leaves them
    // NULL, which means rows from system jobs / schedulers stay readable
    // but with no key attribution.
    audit: async (actor, action, resourceType, resourceId, resourceName, metadata = {}, diff = null) => {
      try {
        let actorName, actorKeyId = null, actorScope = null
        if (typeof actor === 'string') {
          actorName = actor
        } else if (actor && typeof actor === 'object') {
          actorName  = actor.name  || 'system'
          actorKeyId = actor.keyId || null
          actorScope = actor.scope || null
        } else {
          actorName = 'system'
        }
        await pool.query(
          `INSERT INTO audit_log(actor, actor_key_id, actor_scope, action, resource_type, resource_id, resource_name, metadata, diff)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [actorName, actorKeyId, actorScope,
           action, resourceType, resourceId, resourceName,
           JSON.stringify(metadata), diff ? JSON.stringify(diff) : null]
        )
      } catch {}
    }
  })

  fastify.addHook('onClose', async () => pool.end())
}