// routes/integrations-cloud.js
// CRUD for cloud accounts stored in PostgreSQL.
// Supports multiple accounts per provider — one row per subscription/account.
// Secret fields (clientSecret, secretAccessKey, private_key) are
// AES-256-GCM encrypted before INSERT and decrypted on SELECT.

import { encryptConfig, decryptConfig } from '../utils/encrypt.js'
import {
  CloudAccountSchema,
  CloudAccountCreateBodySchema,
  IdParamSchema,
  StandardErrorResponses,
} from '../schemas/openapi.js'

// SQL to ensure the table exists — run once at startup via onReady hook
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS cloud_accounts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider    TEXT NOT NULL,
    name        TEXT NOT NULL,
    config      JSONB NOT NULL DEFAULT '{}',
    enabled     BOOLEAN NOT NULL DEFAULT true,
    last_scan_at       TIMESTAMPTZ,
    last_scan_status   TEXT,
    last_scan_total    INTEGER DEFAULT 0,
    last_scan_error    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, name)
  );
  CREATE INDEX IF NOT EXISTS idx_cloud_accounts_provider ON cloud_accounts(provider);
`

export default async function cloudAccountRoutes(fastify) {
  const audit = (...a) => fastify.pg.audit(...a).catch(() => {})
  const actor = (req) => req.headers['x-actor'] || 'system'

  // Ensure table exists when server starts — non-fatal if Postgres unavailable
  fastify.addHook('onReady', async () => {
    if (!fastify.pg?.pool) return
    try {
      await fastify.pg.query(CREATE_TABLE_SQL)
      fastify.log.info('[CloudAccounts] Table ready')
    } catch (err) {
      fastify.log.warn(`[CloudAccounts] Table init warning: ${err.message}`)
    }
  })

  // ── GET /integrations/cloud ──────────────────────────────────────────────
  fastify.get('/cloud', {
    schema: {
      summary:     'List all cloud accounts (decrypted config)',
      description: 'Returns every cloud account row with its decrypted `config` (the on-disk row stores AES-256-GCM-encrypted secrets — clientSecret, secretAccessKey, private_key — which are decrypted on read).',
      response:    { 200: { type: 'array', items: CloudAccountSchema } },
    },
  }, async (req, reply) => {
    if (!fastify.pg?.pool) return []
    try {
      const rows = await fastify.pg.query(
        `SELECT id, provider, name, config, enabled,
                last_scan_at, last_scan_status, last_scan_total, last_scan_error,
                created_at, updated_at
         FROM cloud_accounts
         ORDER BY provider, name`
      )
      return rows.map(row => ({
        ...row,
        config: decryptConfig(row.config || {}),
      }))
    } catch (err) {
      fastify.log.error(`[CloudAccounts] GET error: ${err.message}`)
      return []
    }
  })

  // ── GET /integrations/cloud/:provider ────────────────────────────────────
  fastify.get('/cloud/:provider', {
    schema: {
      summary:     'List enabled cloud accounts for a provider',
      description: 'Filters by provider (aws / azure / gcp) and `enabled = true`. Discovery scans use this same query indirectly via the `loadAccounts` helper.',
      params:      { type: 'object', required: ['provider'], properties: { provider: { type: 'string', enum: ['aws', 'azure', 'gcp'] } } },
      response:    { 200: { type: 'array', items: CloudAccountSchema } },
    },
  }, async (req, reply) => {
    if (!fastify.pg?.pool) return []
    try {
      const rows = await fastify.pg.query(
        `SELECT id, provider, name, config, enabled,
                last_scan_at, last_scan_status, last_scan_total
         FROM cloud_accounts
         WHERE provider = $1 AND enabled = true
         ORDER BY name`,
        [req.params.provider]
      )
      return rows.map(row => ({
        ...row,
        config: decryptConfig(row.config || {}),
      }))
    } catch (err) {
      return []
    }
  })

  // ── POST /integrations/cloud ─────────────────────────────────────────────
  fastify.post('/cloud', {
    schema: {
      summary:     'Create or upsert a cloud account',
      description: 'On unique-key conflict (provider, name) the row is updated, not duplicated. Secret fields in `config` (clientSecret, secretAccessKey, private_key) are AES-256-GCM-encrypted before INSERT.',
      body:        CloudAccountCreateBodySchema,
      response:    { 201: CloudAccountSchema, 400: StandardErrorResponses[400], 503: StandardErrorResponses[503] },
    },
  }, async (req, reply) => {
    if (!fastify.pg?.pool)
      return reply.serviceUnavailable('Database not available — check Postgres connection')

    const { provider, name, config = {}, enabled = true } = req.body || {}
    if (!provider || !name)
      return reply.badRequest('provider and name are required')
    if (!['aws', 'azure', 'gcp'].includes(provider))
      return reply.badRequest('provider must be aws, azure, or gcp')

    try {
      const encryptedConfig = encryptConfig({ ...config })

      const rows = await fastify.pg.query(
        `INSERT INTO cloud_accounts (provider, name, config, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, name) DO UPDATE
           SET config     = EXCLUDED.config,
               enabled    = EXCLUDED.enabled,
               updated_at = now()
         RETURNING id, provider, name, enabled, created_at, updated_at`,
        [provider, name, JSON.stringify(encryptedConfig), enabled]
      )
      const row = rows[0]
      audit(actor(req), 'create', 'CloudAccount', row.id, `${provider}:${name}`, { provider })
      reply.code(201)
      return { ...row, config: decryptConfig(encryptedConfig) }
    } catch (err) {
      fastify.log.error(`[CloudAccounts] POST error: ${err.message}`)
      return reply.internalServerError(`Failed to save account: ${err.message}`)
    }
  })

  // ── PATCH /integrations/cloud/:id ────────────────────────────────────────
  fastify.patch('/cloud/:id', {
    schema: {
      summary:     'Update a cloud account (partial)',
      description: 'Any subset of `name` / `config` / `enabled`. The `config` shape is *merged* into the existing decrypted config and re-encrypted, so you can patch one secret without re-supplying the others.',
      params:      IdParamSchema,
      body: { type: 'object', additionalProperties: true, properties: {
        name:    { type: 'string' },
        config:  { type: 'object', additionalProperties: true },
        enabled: { type: 'boolean' },
      } },
      response: { 200: CloudAccountSchema, 404: StandardErrorResponses[404] },
    },
  }, async (req, reply) => {
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
         SET name    = COALESCE($1, name),
             config  = $2,
             enabled = COALESCE($3, enabled),
             updated_at = now()
         WHERE id = $4
         RETURNING id, provider, name, enabled, updated_at`,
        [name ?? null, JSON.stringify(newConfig), enabled ?? null, req.params.id]
      )
      audit(actor(req), 'update', 'CloudAccount', req.params.id,
        `${current.provider}:${current.name}`, {})
      return { ...rows[0], config: decryptConfig(newConfig) }
    } catch (err) {
      fastify.log.error(`[CloudAccounts] PATCH error: ${err.message}`)
      return reply.internalServerError(`Failed to update account: ${err.message}`)
    }
  })

  // ── DELETE /integrations/cloud/:id ───────────────────────────────────────
  fastify.delete('/cloud/:id', {
    schema: {
      summary:     'Delete a cloud account',
      description: 'Removes the Postgres row. Discovery-emitted Infra nodes already in Neo4j are *not* deleted; they\'ll be marked stale on the next scan that runs without this account.',
      params:      IdParamSchema,
      response:    { 204: { type: 'null' }, 404: StandardErrorResponses[404] },
    },
  }, async (req, reply) => {
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
      fastify.log.error(`[CloudAccounts] DELETE error: ${err.message}`)
      return reply.internalServerError(`Failed to delete account: ${err.message}`)
    }
  })

  // ── PATCH /integrations/cloud/:id/scan-result ────────────────────────────
  // ── POST /integrations/cloud/sync-from-neo4j ─────────────────────────────
  // One-time migration: copies CloudAccount nodes from Neo4j into Postgres.
  // Safe to run multiple times — uses ON CONFLICT DO UPDATE.
  // Call this if "Run Now" finds no accounts to scan.
  fastify.post('/cloud/sync-from-neo4j', {
    schema: {
      summary:     'One-time migration: copy CloudAccount nodes from Neo4j to Postgres',
      description: 'For graphs that pre-date the Postgres backing store. Idempotent (`ON CONFLICT (provider, name) DO UPDATE`). Returns the count of accounts migrated.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!fastify.pg?.pool)  return reply.serviceUnavailable('Database not available')
    if (!fastify.neo4j)     return reply.serviceUnavailable('Neo4j not available')

    try {
      const records = await fastify.neo4j.query(
        `MATCH (a:CloudAccount) RETURN a.provider AS provider, a.name AS name, a.config AS config`
      )
      if (!records.length) return { migrated: 0, message: 'No CloudAccount nodes found in Neo4j' }

      let migrated = 0
      for (const r of records) {
        const provider = r.get('provider')
        const name     = r.get('name')
        let config = {}
        try { config = JSON.parse(r.get('config') || '{}') } catch {}

        if (!provider || !name) continue
        if (!['aws','azure','gcp'].includes(provider)) continue

        const enc = encryptConfig({ ...config })
        await fastify.pg.query(
          `INSERT INTO cloud_accounts (provider, name, config, enabled)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (provider, name) DO UPDATE
             SET config = EXCLUDED.config, updated_at = now()`,
          [provider, name, JSON.stringify(enc)]
        )
        migrated++
      }

      return { migrated, message: `Migrated ${migrated} account(s) from Neo4j to Postgres` }
    } catch (err) {
      fastify.log.error(`[CloudAccounts] sync-from-neo4j error: ${err.message}`)
      return reply.internalServerError(`Migration failed: ${err.message}`)
    }
  })

  fastify.patch('/cloud/:id/scan-result', {
    schema: {
      summary:     'Internal — record a scan outcome on a cloud account',
      description: 'Called by the scan handlers in discovery.js to stamp `last_scan_at / last_scan_status / last_scan_total / last_scan_error` on the account row. Not typically called directly by external consumers.',
      params:      IdParamSchema,
      body: { type: 'object', additionalProperties: true, properties: {
        status: { type: 'string', enum: ['success', 'error'] },
        total:  { type: 'integer' },
        error:  { type: ['string', 'null'] },
      } },
      response: { 200: { type: 'object', properties: { updated: { type: 'boolean' } } } },
    },
  }, async (req, reply) => {
    if (!fastify.pg?.pool) return { updated: false }
    try {
      const { status, total, error } = req.body || {}
      await fastify.pg.query(
        `UPDATE cloud_accounts
         SET last_scan_at     = now(),
             last_scan_status = $1,
             last_scan_total  = $2,
             last_scan_error  = $3
         WHERE id = $4`,
        [status, total || 0, error || null, req.params.id]
      )
      return { updated: true }
    } catch {
      return { updated: false }
    }
  })
}