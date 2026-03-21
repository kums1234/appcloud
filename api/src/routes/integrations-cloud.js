// routes/integrations-cloud.js
import { encryptConfig, decryptConfig } from '../utils/encrypt.js'

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS cloud_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL, name TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_scan_at TIMESTAMPTZ, last_scan_status TEXT,
    last_scan_total INTEGER DEFAULT 0, last_scan_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, name)
  );
  CREATE INDEX IF NOT EXISTS idx_cloud_accounts_provider ON cloud_accounts(provider);
`

export default async function cloudAccountRoutes(fastify) {
  const audit = (...a) => fastify.pg.audit(...a).catch(() => {})
  const actor = (req) => req.user?.name || req.user?.id || 'system'

  fastify.addHook('onReady', async () => {
    if (!fastify.pg?.pool) return
    try {
      await fastify.pg.query(CREATE_TABLE_SQL)
      fastify.log.info('[CloudAccounts] Table ready')
    } catch (err) {
      fastify.log.warn(`[CloudAccounts] Table init warning: ${err.message}`)
    }
  })

  fastify.get('/cloud', async () => {
    if (!fastify.pg?.pool) return []
    try {
      const rows = await fastify.pg.query(
        `SELECT id, provider, name, config, enabled,
                last_scan_at, last_scan_status, last_scan_total, last_scan_error,
                created_at, updated_at
         FROM cloud_accounts ORDER BY provider, name`
      )
      return rows.map(r => ({ ...r, config: decryptConfig(r.config || {}) }))
    } catch { return [] }
  })

  fastify.get('/cloud/:provider', async (req) => {
    if (!fastify.pg?.pool) return []
    try {
      const rows = await fastify.pg.query(
        `SELECT id, provider, name, config, enabled,
                last_scan_at, last_scan_status, last_scan_total
         FROM cloud_accounts WHERE provider = $1 AND enabled = true ORDER BY name`,
        [req.params.provider]
      )
      return rows.map(r => ({ ...r, config: decryptConfig(r.config || {}) }))
    } catch { return [] }
  })

  fastify.post('/cloud', async (req, reply) => {
    if (!fastify.pg?.pool)
      return reply.serviceUnavailable('Database not available')
    const { provider, name, config = {}, enabled = true } = req.body || {}
    if (!provider || !name) return reply.badRequest('provider and name are required')
    if (!['aws','azure','gcp'].includes(provider))
      return reply.badRequest('provider must be aws, azure, or gcp')
    try {
      const enc = encryptConfig({ ...config })
      const rows = await fastify.pg.query(
        `INSERT INTO cloud_accounts (provider, name, config, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, name) DO UPDATE
           SET config = EXCLUDED.config, enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING id, provider, name, enabled, created_at, updated_at`,
        [provider, name, JSON.stringify(enc), enabled]
      )
      audit(actor(req), 'create', 'CloudAccount', rows[0].id, `${provider}:${name}`, { provider })
      reply.code(201)
      return { ...rows[0], config: decryptConfig(enc) }
    } catch (err) {
      fastify.log.error(`[CloudAccounts] POST error: ${err.message}`)
      return reply.internalServerError(`Failed to save: ${err.message}`)
    }
  })

  fastify.patch('/cloud/:id', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Database not available')
    try {
      const existing = await fastify.pg.query(
        `SELECT * FROM cloud_accounts WHERE id = $1`, [req.params.id]
      )
      if (!existing.length) return reply.notFound('Cloud account not found')
      const current = existing[0]
      const { name, config, enabled } = req.body || {}
      const newConfig = config
        ? encryptConfig({ ...decryptConfig(current.config || {}), ...config })
        : current.config
      const rows = await fastify.pg.query(
        `UPDATE cloud_accounts
         SET name = COALESCE($1, name), config = $2,
             enabled = COALESCE($3, enabled), updated_at = now()
         WHERE id = $4 RETURNING id, provider, name, enabled, updated_at`,
        [name ?? null, JSON.stringify(newConfig), enabled ?? null, req.params.id]
      )
      audit(actor(req), 'update', 'CloudAccount', req.params.id, `${current.provider}:${current.name}`, {})
      return { ...rows[0], config: decryptConfig(newConfig) }
    } catch (err) {
      return reply.internalServerError(`Failed to update: ${err.message}`)
    }
  })

  fastify.delete('/cloud/:id', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Database not available')
    try {
      const existing = await fastify.pg.query(
        `SELECT provider, name FROM cloud_accounts WHERE id = $1`, [req.params.id]
      )
      if (!existing.length) return reply.notFound('Cloud account not found')
      await fastify.pg.query(`DELETE FROM cloud_accounts WHERE id = $1`, [req.params.id])
      audit(actor(req), 'delete', 'CloudAccount', req.params.id,
        `${existing[0].provider}:${existing[0].name}`, {})
      reply.code(204)
    } catch (err) {
      return reply.internalServerError(`Failed to delete: ${err.message}`)
    }
  })

  fastify.patch('/cloud/:id/scan-result', async (req, reply) => {
    if (!fastify.pg?.pool) return { updated: false }
    try {
      const { status, total, error } = req.body || {}
      await fastify.pg.query(
        `UPDATE cloud_accounts
         SET last_scan_at = now(), last_scan_status = $1,
             last_scan_total = $2, last_scan_error = $3
         WHERE id = $4`,
        [status, total || 0, error || null, req.params.id]
      )
      return { updated: true }
    } catch { return { updated: false } }
  })
}
