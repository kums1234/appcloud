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
    expires_at:   { type: ['string', 'null'], format: 'date-time', description: 'NULL = never expires; otherwise the key is rejected once now() crosses this instant.' },
    is_bootstrap: { type: 'boolean' },
  },
}

const CreateBodySchema = {
  type: 'object',
  required: ['name', 'scopes'],
  additionalProperties: false,
  properties: {
    name:      { type: 'string', pattern: '^[A-Za-z0-9._@:+-]{1,128}$', description: 'Human-readable identifier — appears in audit logs as the actor.' },
    scopes:    { type: 'array', minItems: 1, items: { type: 'string', enum: ['admin', 'write', 'read'] } },
    expiresAt: { type: ['string', 'null'], format: 'date-time', description: 'Optional expiry. Omit (or pass null) for never-expires. The key stops working at the moment now() crosses this instant.' },
  },
  example: {
    name:      'ci-deploy-bot',
    scopes:    ['write'],
    expiresAt: '2026-12-31T23:59:59Z',
  },
}

const PatchBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name:      { type: 'string', pattern: '^[A-Za-z0-9._@:+-]{1,128}$' },
    scopes:    { type: 'array', minItems: 1, items: { type: 'string', enum: ['admin', 'write', 'read'] } },
    expiresAt: { type: ['string', 'null'], format: 'date-time', description: 'Pass null to clear (never-expires). Pass an ISO date-time to set or extend.' },
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
    const { name, scopes, expiresAt } = req.body
    if (!NAME_RE.test(name)) return reply.badRequest('name must match [A-Za-z0-9._@:+-]{1,128}')
    // expiresAt is optional. If passed, it must be in the future; rejecting
    // a same-instant or already-past value at create time prevents a class
    // of accidentally-DOA keys (the key would be rejected on first use).
    let parsedExpiresAt = null
    if (expiresAt) {
      const ts = new Date(expiresAt)
      if (Number.isNaN(ts.getTime())) return reply.badRequest('expiresAt must be a valid ISO date-time')
      if (ts <= new Date())            return reply.badRequest('expiresAt must be in the future')
      parsedExpiresAt = ts
    }

    let normalised
    try { normalised = normaliseScopes(scopes) }
    catch (e) { return reply.badRequest(e.message) }

    // Generate the plaintext, derive hash + prefix, INSERT. The plaintext
    // never leaves this function except through the response body.
    const plaintext  = generateKey()
    const key_hash   = hashKey(plaintext)
    const key_prefix = prefixOf(plaintext)

    // Phase 1d: api_keys.tenant_id is NOT NULL. Default to the issuer's
    // tenant (the bootstrap admin key is tenant-bound to `default`, so
    // operators get the obvious behaviour out of the box). Fall back to a
    // subquery against control.tenants when the principal somehow has no
    // tenantId — defensive; super-admin keys are also tenant-bound at
    // bootstrap, but a request that authenticates without tenantId at all
    // would otherwise NPE the INSERT.
    const tenantId = req.principal?.tenantId || null

    let rows
    try {
      rows = await fastify.pg.query(`
        INSERT INTO api_keys (name, key_hash, key_prefix, scopes, created_by, expires_at, is_bootstrap, tenant_id)
        VALUES ($1, $2, $3, $4, $5, $6, false,
                COALESCE($7::uuid, (SELECT id FROM control.tenants WHERE slug = 'default')))
        RETURNING id, name, key_prefix, scopes, created_at, created_by, last_used_at, revoked_at, expires_at, is_bootstrap
      `, [name, key_hash, key_prefix, normalised, req.principal?.name || 'unknown', parsedExpiresAt, tenantId])
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
             last_used_at, revoked_at, expires_at, is_bootstrap
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
      summary:     'Update an API key (name / scopes / expiresAt)',
      description: 'Updates the row metadata. The secret cannot be patched — generate a new key and revoke the old one. Bootstrap rows are read-only. Pass `expiresAt: null` to clear an expiry, or an ISO instant to set/extend.',
      params:      { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body:        PatchBodySchema,
      response:    { 200: ApiKeyRowSchema, 404: StandardErrorResponses[404], 409: StandardErrorResponses[409] },
    },
  }, async (req, reply) => {
    if (!pgOk()) return reply.serviceUnavailable('Postgres not available')
    const { name, scopes, expiresAt } = req.body || {}
    if (name !== undefined && !NAME_RE.test(name)) {
      return reply.badRequest('name must match [A-Za-z0-9._@:+-]{1,128}')
    }
    let normalised
    if (scopes !== undefined) {
      try { normalised = normaliseScopes(scopes) }
      catch (e) { return reply.badRequest(e.message) }
    }

    // expiresAt patches: undefined = leave alone, null = clear (never
    // expires), ISO date-time = set/extend (validated). Unlike create,
    // we allow extending into the past — useful for forcing an early
    // expiry to revoke without bumping revoked_at.
    let parsedExpiresAt
    let touchExpiresAt = false
    if (expiresAt !== undefined) {
      touchExpiresAt = true
      if (expiresAt === null) {
        parsedExpiresAt = null
      } else {
        const ts = new Date(expiresAt)
        if (Number.isNaN(ts.getTime())) return reply.badRequest('expiresAt must be a valid ISO date-time or null')
        parsedExpiresAt = ts
      }
    }

    const existing = await fastify.pg.query(
      `SELECT is_bootstrap FROM api_keys WHERE id = $1`,
      [req.params.id],
    )
    if (!existing.length) return reply.notFound('API key not found')
    if (existing[0].is_bootstrap) {
      return reply.conflict('bootstrap keys cannot be patched — rotate APPCLOUD_API_KEY{,_FILE} or change scopes in the plugin code')
    }

    // Build SET clauses dynamically so each field is independently
    // patchable. expires_at gets a literal-NULL path (the COALESCE pattern
    // would treat null as "leave alone").
    const sets = []
    const params = []
    let p = 1
    if (name !== undefined)       { sets.push(`name = $${p++}`)        ; params.push(name) }
    if (normalised !== undefined) { sets.push(`scopes = $${p++}::text[]`); params.push(normalised) }
    if (touchExpiresAt)           { sets.push(`expires_at = $${p++}`)   ; params.push(parsedExpiresAt) }

    if (!sets.length) {
      // Nothing to update — return the current row.
      const current = await fastify.pg.query(`
        SELECT id, name, key_prefix, scopes, created_at, created_by,
               last_used_at, revoked_at, expires_at, is_bootstrap
        FROM api_keys WHERE id = $1
      `, [req.params.id])
      return current[0]
    }

    let rows
    try {
      rows = await fastify.pg.query(`
        UPDATE api_keys
        SET ${sets.join(', ')}
        WHERE id = $${p}
        RETURNING id, name, key_prefix, scopes, created_at, created_by,
                  last_used_at, revoked_at, expires_at, is_bootstrap
      `, [...params, req.params.id])
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
