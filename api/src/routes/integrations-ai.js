// routes/integrations-ai.js
// CRUD for server-side Cloud AI configuration stored encrypted in PostgreSQL.
// Only one active config row at a time — upserts replace the existing row.
// Secret fields (apiKey) are AES-256-GCM encrypted before INSERT and decrypted on SELECT.

import { encrypt, decrypt } from '../utils/encrypt.js'
import { createCloudProviderFromOptions } from '../utils/ai-providers.js'

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ai_config (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider    TEXT NOT NULL,
    config      JSONB NOT NULL DEFAULT '{}',
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`

function maskKey(key) {
  if (!key || typeof key !== 'string') return ''
  if (key.includes(':')) return '••••••••' // encrypted value, don't show
  if (key.length <= 8) return '••••'
  return '••••' + key.slice(-4)
}

function encryptAiConfig(config) {
  if (!config || typeof config !== 'object') return config
  const out = { ...config }
  if (out.apiKey) out.apiKey = encrypt(out.apiKey)
  return out
}

function decryptAiConfig(config) {
  if (!config || typeof config !== 'object') return config
  const out = { ...config }
  if (out.apiKey) {
    try { out.apiKey = decrypt(out.apiKey) } catch {}
  }
  return out
}

export default async function aiConfigRoutes(fastify) {
  const audit = (...a) => fastify.pg?.audit?.(...a).catch(() => {})
  const actor = (req) => req.user?.name || req.user?.id || 'system'

  // Ensure table exists
  fastify.addHook('onReady', async () => {
    if (!fastify.pg?.pool) return
    try {
      await fastify.pg.query(CREATE_TABLE_SQL)
      fastify.log.info('[AiConfig] Table ready')
    } catch (err) {
      fastify.log.warn(`[AiConfig] Table init warning: ${err.message}`)
    }
  })

  // ── GET /integrations/ai ────────────────────────────────────────────────────
  // Returns the saved config with apiKey masked.
  fastify.get('/ai', async (req, reply) => {
    if (!fastify.pg?.pool) return { configured: false }
    try {
      const rows = await fastify.pg.query(
        `SELECT id, provider, config, enabled, created_at, updated_at
         FROM ai_config ORDER BY updated_at DESC LIMIT 1`
      )
      if (!rows.length) return { configured: false }
      const row = rows[0]
      const decrypted = decryptAiConfig(row.config || {})
      return {
        configured: true,
        id: row.id,
        provider: row.provider,
        enabled: row.enabled,
        model: decrypted.model || 'auto',
        apiKeyMasked: maskKey(decrypted.apiKey),
        azureEndpoint: decrypted.azureEndpoint || null,
        azureDeployment: decrypted.azureDeployment || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    } catch (err) {
      fastify.log.error(`[AiConfig] GET error: ${err.message}`)
      return { configured: false }
    }
  })

  // ── POST /integrations/ai ───────────────────────────────────────────────────
  // Upsert: deletes existing row and inserts a new one.
  fastify.post('/ai', async (req, reply) => {
    if (!fastify.pg?.pool)
      return reply.serviceUnavailable('Database not available')

    const { provider, apiKey, model, azureEndpoint, azureDeployment } = req.body || {}
    if (!provider)
      return reply.badRequest('provider is required (anthropic, openai, gemini, azure)')
    if (!['anthropic', 'openai', 'gemini', 'azure'].includes(provider))
      return reply.badRequest('provider must be anthropic, openai, gemini, or azure')
    if (!apiKey)
      return reply.badRequest('apiKey is required')

    const config = {
      apiKey,
      model: model || 'auto',
      ...(provider === 'azure' ? {
        azureEndpoint: azureEndpoint || '',
        azureDeployment: azureDeployment || '',
      } : {}),
    }

    try {
      const encrypted = encryptAiConfig(config)

      // Delete existing config (only one active at a time)
      await fastify.pg.query('DELETE FROM ai_config')

      const rows = await fastify.pg.query(
        `INSERT INTO ai_config (provider, config, enabled)
         VALUES ($1, $2, true)
         RETURNING id, provider, enabled, created_at, updated_at`,
        [provider, JSON.stringify(encrypted)]
      )
      const row = rows[0]
      audit(actor(req), 'create', 'AiConfig', row.id, `ai:${provider}`, { provider })

      // Refresh the AI plugin's cloud provider from DB
      if (fastify.ai?.refreshCloudFromDb) {
        await fastify.ai.refreshCloudFromDb()
      }

      reply.code(201)
      return {
        configured: true,
        id: row.id,
        provider: row.provider,
        enabled: row.enabled,
        model: config.model,
        apiKeyMasked: maskKey(apiKey),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    } catch (err) {
      fastify.log.error(`[AiConfig] POST error: ${err.message}`)
      return reply.internalServerError(`Failed to save AI config: ${err.message}`)
    }
  })

  // ── DELETE /integrations/ai ─────────────────────────────────────────────────
  fastify.delete('/ai', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Database not available')
    try {
      const existing = await fastify.pg.query('SELECT id, provider FROM ai_config LIMIT 1')
      if (!existing.length) return reply.notFound('No AI config found')
      await fastify.pg.query('DELETE FROM ai_config')
      audit(actor(req), 'delete', 'AiConfig', existing[0].id,
        `ai:${existing[0].provider}`, {})

      // Clear the DB-sourced cloud provider
      if (fastify.ai?.refreshCloudFromDb) {
        await fastify.ai.refreshCloudFromDb()
      }

      reply.code(204)
    } catch (err) {
      fastify.log.error(`[AiConfig] DELETE error: ${err.message}`)
      return reply.internalServerError(`Failed to delete AI config: ${err.message}`)
    }
  })

  // ── POST /integrations/ai/test ──────────────────────────────────────────────
  // Tests the saved config by creating a provider and sending a trivial message.
  fastify.post('/ai/test', async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Database not available')

    try {
      // Read the saved config
      const rows = await fastify.pg.query(
        'SELECT provider, config FROM ai_config WHERE enabled = true LIMIT 1'
      )
      if (!rows.length)
        return { ok: false, error: 'No AI config saved — save credentials first' }

      const row = rows[0]
      const config = decryptAiConfig(row.config || {})

      // Create provider from saved config
      const provider = createCloudProviderFromOptions(fastify.log, {
        provider: row.provider,
        apiKey: config.apiKey,
        model: config.model,
        azureEndpoint: config.azureEndpoint,
        azureDeployment: config.azureDeployment,
      })

      if (!provider)
        return { ok: false, error: 'Failed to create provider from saved config' }

      // Trivial test chat
      const result = await provider.chat([
        { role: 'user', content: 'Reply with exactly: OK' },
      ], { maxTokens: 16 })

      return {
        ok: true,
        provider: result.provider || row.provider,
        model: result.model || config.model,
        response: result.text?.trim(),
      }
    } catch (err) {
      fastify.log.error(`[AiConfig] Test error: ${err.message}`)
      return { ok: false, error: err.message }
    }
  })
}
