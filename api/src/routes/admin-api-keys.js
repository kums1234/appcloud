// routes/admin-api-keys.js
//
// CRUD for the api_keys table. Admin scope only — every route here flags
// `config.scope: 'admin'`, which the auth plugin enforces via the
// requireScope('admin') preHandler.
//
// Endpoints:
//   POST   /admin/api-keys          create a key (returns plaintext ONCE)
//   GET    /admin/api-keys          list active + revoked, no plaintext
//   DELETE /admin/api-keys/:id      soft-delete (revoked_at = now())
//   PATCH  /admin/api-keys/:id      update name / scopes (not the secret)
//
// On every successful mutation we invalidate the auth-plugin's in-memory
// cache so the change takes effect on the next request, not after the TTL.
//
// Bootstrap rows (is_bootstrap = true) are read-only via the API: their
// hash + scopes come from the env vars and re-applying them would mask
// drift between the env and the DB.

import {
  generateKey,
  hashKey,
  prefixOf,
  normaliseScopes,
} from '../utils/api-keys.js'
import { StandardErrorResponses } from '../schemas/openapi.js'

const NAME_RE = /^[A-Za-z0-9._@:+-]{1,128}$/

const ApiKeyRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id:           { type: 'string', format: 'uuid' },
    name:         { type: 'string' },
    key_prefix:   { type: 'string' },
    scopes:       { type: 'array', items: { type: 'string', enum: ['admin', 'write', 'read'] } },
    created_at:   { type: 'string', format: 'date-time' },
    created_by:   { type: ['string', 'null'] },
    last_used_at: { type: ['string', 'null'], format: 'date-time' },
    revoked_at:   { type: ['string', 'null'], format: 'date-time' },
    is_bootstrap: { type: 'boolean' },
  },
}

const CreateBodySchema = {
  type: 'object',
  required: ['name', 'scopes'],
  additionalProperties: false,
  properties: {
    name:   { type: 'string', pattern: '^[A-Za-z0-9._@:+-]{1,128}$', description: 'Human-readable identifier — appears in audit logs as the actor.' },
    scopes: { type: 'array', minItems: 1, items: { type: 'string', enum: ['admin', 'write', 'read'] } },
  },
  example: {
    name:   'ci-deploy-bot',
    scopes: ['write'],
  },
}

const PatchBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name:   { type: 'string', pattern: '^[A-Za-z0-9._@:+-]{1,128}$' },
    scopes: { type: 'array', minItems: 1, items: { type: 'string', enum: ['admin', 'write', 'read'] } },
  },
}

export default async function adminApiKeyRoutes(fastify) {
  const pgOk = () => !!fastify.pg?.query

  // Bump the cache so a freshly created / revoked / patched key takes
  // effect immediately, not after CACHE_TTL_MS.
  function invalidateCache() {
    if (fastify.apiKeyCache) fastify.apiKeyCache.refreshedAt = 0
  }

  // ── POST /admin/api-keys ─────────────────────────────────────────────────
  fastify.post('/api-keys', {
    config: { scope: 'admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'Create a new API key',
      description: 'Generates a fresh `ak_…` plaintext, stores SHA-256(plaintext) + the requested scopes, and returns the plaintext **once**. Save it immediately — it is never recoverable.',
      body:        CreateBodySchema,
      response: {
        201: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...ApiKeyRowSchema.properties,
            plaintext: { type: 'string', description: 'The generated key. Shown ONCE; copy it now.' },
          },
        },
      },
    },
  }, async (req, reply) => {
    if (!pgOk()) return reply.serviceUnavailable('Postgres not available')
    const { name, scopes } = req.body
    if (!NAME_RE.test(name)) return reply.badRequest('name must match [A-Za-z0-9._@:+-]{1,128}')

    let normalised
    try { normalised = normaliseScopes(scopes) }
    catch (e) { return reply.badRequest(e.message) }

    // Generate the plaintext, derive hash + prefix, INSERT. The plaintext
    // never leaves this function except through the response body.
    const plaintext  = generateKey()
    const key_hash   = hashKey(plaintext)
    const key_prefix = prefixOf(plaintext)

    let rows
    try {
      rows = await fastify.pg.query(`
        INSERT INTO api_keys (name, key_hash, key_prefix, scopes, created_by, is_bootstrap)
        VALUES ($1, $2, $3, $4, $5, false)
        RETURNING id, name, key_prefix, scopes, created_at, created_by, last_used_at, revoked_at, is_bootstrap
      `, [name, key_hash, key_prefix, normalised, req.principal?.name || 'unknown'])
    } catch (err) {
      if (String(err.code) === '23505') {                    // unique_violation
        return reply.conflict(`api key name '${name}' already exists`)
      }
      throw err
    }

    invalidateCache()
    reply.code(201)
    return { ...rows[0], plaintext }
  })

  // ── GET /admin/api-keys ──────────────────────────────────────────────────
  fastify.get('/api-keys', {
    config: { scope: 'admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'List API keys',
      description: 'Returns every row including revoked ones, sorted by creation time (newest first). Plaintext is **never** returned — only the prefix and metadata.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          includeRevoked: { type: 'string', enum: ['true', 'false'] },
        },
      },
      response: {
        200: { type: 'array', items: ApiKeyRowSchema },
      },
    },
  }, async (req) => {
    if (!pgOk()) return []
    const includeRevoked = req.query?.includeRevoked === 'true'
    const where = includeRevoked ? '' : 'WHERE revoked_at IS NULL'
    const rows = await fastify.pg.query(`
      SELECT id, name, key_prefix, scopes, created_at, created_by,
             last_used_at, revoked_at, is_bootstrap
      FROM api_keys
      ${where}
      ORDER BY created_at DESC
    `)
    return rows
  })

  // ── DELETE /admin/api-keys/:id ───────────────────────────────────────────
  fastify.delete('/api-keys/:id', {
    config: { scope: 'admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'Revoke an API key',
      description: 'Soft-deletes the key by setting `revoked_at = now()`. Bootstrap rows (env-var-derived) cannot be revoked here — rotate the env var instead.',
      params:      { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response:    { 204: { type: 'null' }, 404: StandardErrorResponses[404], 409: StandardErrorResponses[409] },
    },
  }, async (req, reply) => {
    if (!pgOk()) return reply.serviceUnavailable('Postgres not available')
    // Don't allow revoking the key we're authenticating with — that would
    // brick admin access until a different admin key is created.
    if (req.principal?.id === req.params.id) {
      return reply.conflict('cannot revoke the key currently being used to authenticate this request')
    }
    const rows = await fastify.pg.query(
      `SELECT is_bootstrap, revoked_at FROM api_keys WHERE id = $1`,
      [req.params.id],
    )
    if (!rows.length) return reply.notFound('API key not found')
    if (rows[0].is_bootstrap) {
      return reply.conflict('bootstrap keys cannot be revoked here — rotate APPCLOUD_API_KEY{,_FILE} instead')
    }
    if (rows[0].revoked_at) {
      return reply.conflict('API key is already revoked')
    }
    await fastify.pg.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1`,
      [req.params.id],
    )
    invalidateCache()
    reply.code(204)
  })

  // ── PATCH /admin/api-keys/:id ────────────────────────────────────────────
  fastify.patch('/api-keys/:id', {
    config: { scope: 'admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'Update an API key (name / scopes)',
      description: 'Updates the row metadata. The secret cannot be patched — generate a new key and revoke the old one. Bootstrap rows are read-only.',
      params:      { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body:        PatchBodySchema,
      response:    { 200: ApiKeyRowSchema, 404: StandardErrorResponses[404], 409: StandardErrorResponses[409] },
    },
  }, async (req, reply) => {
    if (!pgOk()) return reply.serviceUnavailable('Postgres not available')
    const { name, scopes } = req.body || {}
    if (name !== undefined && !NAME_RE.test(name)) {
      return reply.badRequest('name must match [A-Za-z0-9._@:+-]{1,128}')
    }
    let normalised
    if (scopes !== undefined) {
      try { normalised = normaliseScopes(scopes) }
      catch (e) { return reply.badRequest(e.message) }
    }

    const existing = await fastify.pg.query(
      `SELECT is_bootstrap FROM api_keys WHERE id = $1`,
      [req.params.id],
    )
    if (!existing.length) return reply.notFound('API key not found')
    if (existing[0].is_bootstrap) {
      return reply.conflict('bootstrap keys cannot be patched — rotate APPCLOUD_API_KEY{,_FILE} or change scopes in the plugin code')
    }

    let rows
    try {
      rows = await fastify.pg.query(`
        UPDATE api_keys
        SET name   = COALESCE($1, name),
            scopes = COALESCE($2::text[], scopes)
        WHERE id = $3
        RETURNING id, name, key_prefix, scopes, created_at, created_by,
                  last_used_at, revoked_at, is_bootstrap
      `, [name ?? null, normalised ?? null, req.params.id])
    } catch (err) {
      if (String(err.code) === '23505') {
        return reply.conflict(`api key name '${name}' already exists`)
      }
      throw err
    }
    invalidateCache()
    return rows[0]
  })
}
