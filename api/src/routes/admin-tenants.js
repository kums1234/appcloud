// routes/admin-tenants.js
//
// CRUD for control.tenants. Super-admin scope only — every route here
// flags `config.scope: 'super-admin'` so the auth plugin enforces the
// scope at the preHandler stage.
//
// Endpoints:
//   POST   /admin/tenants        create a tenant
//   GET    /admin/tenants        list tenants (active + suspended +
//                                pending_delete; query flag filters)
//   GET    /admin/tenants/:id    fetch one
//   PATCH  /admin/tenants/:id    update display_name / status / metadata
//   DELETE /admin/tenants/:id    soft-delete (status = pending_delete)
//
// Slug is immutable post-creation. Status transitions:
//
//   active → suspended           (PATCH)
//   active → pending_delete      (DELETE)
//   suspended → active           (PATCH)
//   suspended → pending_delete   (DELETE)
//   pending_delete → *           rejected (the tenant is on its way out)
//
// Hard delete (DROP DATABASE / DROP SCHEMA / DELETE rows) is a Phase 4
// concern; this file ships soft-delete only.

import { StandardErrorResponses } from '../schemas/openapi.js'

const SLUG_RE     = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const RESERVED_SLUGS = new Set(['admin', 'system', 'api'])
// 'default' is reserved too — it's the seeded tenant. Operators shouldn't
// be able to create a second 'default' or accidentally mint one with a
// slug that collides with the seed semantics.

const TenantRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id:              { type: 'string', format: 'uuid' },
    slug:            { type: 'string' },
    display_name:    { type: 'string' },
    status:          { type: 'string', enum: ['active', 'suspended', 'pending_delete'] },
    schema_name:     { type: 'string' },
    neo4j_database:  { type: 'string' },
    created_at:      { type: 'string', format: 'date-time' },
    created_by:      { type: ['string', 'null'] },
    metadata:        { type: 'object', additionalProperties: true },
  },
}

const CreateBodySchema = {
  type: 'object',
  required: ['slug', 'displayName'],
  additionalProperties: false,
  properties: {
    slug:        { type: 'string', pattern: SLUG_RE.source, description: 'URL-safe identifier, kebab-case, 3–40 chars. Immutable post-creation.' },
    displayName: { type: 'string', minLength: 1, maxLength: 200 },
    metadata:    { type: 'object', additionalProperties: true, description: 'Free-form metadata. Stored as JSONB.' },
  },
  example: {
    slug:        'acme-corp',
    displayName: 'Acme Corporation',
    metadata:    { region: 'us-east-1' },
  },
}

const PatchBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 200 },
    status:      { type: 'string', enum: ['active', 'suspended'], description: "Set to 'suspended' to pause the tenant; set back to 'active' to resume. Use DELETE to move to 'pending_delete'." },
    metadata:    { type: 'object', additionalProperties: true },
  },
}

// Compute the Neo4j database name + Postgres schema name for a new tenant.
// Both are derived from the UUID (dashes stripped) for stability — slug
// can be renamed in a future migration without rewriting these. Kept
// separate from the slug so a tenant rename never touches stored data.
function deriveTenantNames(tenantId) {
  const stripped = String(tenantId).replace(/-/g, '')
  return {
    schemaName:    `tenant_${stripped}`,
    neo4jDatabase: `tenant_${stripped}`,
  }
}

export default async function adminTenantRoutes(fastify) {
  const pgOk = () => !!fastify.pg?.query

  function invalidateTenantCache() {
    if (fastify.tenantCache) fastify.tenantCache.refreshedAt = 0
  }

  // ── POST /admin/tenants ──────────────────────────────────────────────────
  fastify.post('/tenants', {
    config: { scope: 'super-admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'Create a tenant',
      description: 'Inserts a new row in `control.tenants`. Phase 0 only creates the metadata — Phase 1 wires the per-tenant Postgres schema and Phase 2 the per-tenant Neo4j database.',
      body:        CreateBodySchema,
      response: {
        201: TenantRowSchema,
        400: StandardErrorResponses[400],
        409: StandardErrorResponses[409],
      },
    },
  }, async (req, reply) => {
    if (!pgOk()) return reply.serviceUnavailable('Postgres not available')
    const { slug, displayName, metadata } = req.body
    if (!SLUG_RE.test(slug)) {
      return reply.badRequest(`slug '${slug}' must match ${SLUG_RE.source}`)
    }
    if (RESERVED_SLUGS.has(slug) || slug.startsWith('_')) {
      return reply.badRequest(`slug '${slug}' is reserved`)
    }

    // Two-step insert: gen the UUID first (so we can derive schema_name and
    // neo4j_database from it), then insert. Doing it in one INSERT with
    // gen_random_uuid() in a CTE is possible but harder to read; the
    // performance difference is irrelevant here.
    let rows
    try {
      const idRows = await fastify.pg.query(`SELECT gen_random_uuid() AS id`)
      const id = idRows[0].id
      const { schemaName, neo4jDatabase } = deriveTenantNames(id)

      rows = await fastify.pg.query(`
        INSERT INTO control.tenants (id, slug, display_name, status, schema_name, neo4j_database, created_by, metadata)
        VALUES ($1, $2, $3, 'active', $4, $5, $6, $7::jsonb)
        RETURNING id, slug, display_name, status, schema_name, neo4j_database,
                  created_at, created_by, metadata
      `, [
        id,
        slug,
        displayName,
        schemaName,
        neo4jDatabase,
        req.principal?.name || 'unknown',
        JSON.stringify(metadata || {}),
      ])
    } catch (err) {
      if (String(err.code) === '23505') {
        return reply.conflict(`tenant slug '${slug}' already exists`)
      }
      throw err
    }

    invalidateTenantCache()
    reply.code(201)
    return rows[0]
  })

  // ── GET /admin/tenants ───────────────────────────────────────────────────
  fastify.get('/tenants', {
    config: { scope: 'super-admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'List tenants',
      description: 'Returns every tenant row, sorted by creation time (newest first). Filter by status with `?status=active|suspended|pending_delete`.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['active', 'suspended', 'pending_delete'] },
        },
      },
      response: {
        200: { type: 'array', items: TenantRowSchema },
      },
    },
  }, async (req) => {
    if (!pgOk()) return []
    const status = req.query?.status
    const where  = status ? 'WHERE status = $1' : ''
    const params = status ? [status] : []
    return await fastify.pg.query(`
      SELECT id, slug, display_name, status, schema_name, neo4j_database,
             created_at, created_by, metadata
      FROM control.tenants
      ${where}
      ORDER BY created_at DESC
    `, params)
  })

  // ── GET /admin/tenants/:id ───────────────────────────────────────────────
  fastify.get('/tenants/:id', {
    config: { scope: 'super-admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'Get a tenant by id',
      params:      { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response:    { 200: TenantRowSchema, 404: StandardErrorResponses[404] },
    },
  }, async (req, reply) => {
    if (!pgOk()) return reply.serviceUnavailable('Postgres not available')
    const rows = await fastify.pg.query(`
      SELECT id, slug, display_name, status, schema_name, neo4j_database,
             created_at, created_by, metadata
      FROM control.tenants
      WHERE id = $1
    `, [req.params.id])
    if (!rows.length) return reply.notFound('tenant not found')
    return rows[0]
  })

  // ── PATCH /admin/tenants/:id ─────────────────────────────────────────────
  fastify.patch('/tenants/:id', {
    config: { scope: 'super-admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'Update tenant (display name / status / metadata)',
      description: 'Updates the row metadata. Slug is immutable. Status can move active ↔ suspended; pending_delete is set via DELETE and cannot be reversed here.',
      params:      { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body:        PatchBodySchema,
      response: {
        200: TenantRowSchema,
        404: StandardErrorResponses[404],
        409: StandardErrorResponses[409],
      },
    },
  }, async (req, reply) => {
    if (!pgOk()) return reply.serviceUnavailable('Postgres not available')
    const { displayName, status, metadata } = req.body || {}

    // Existence + status-transition guard. We re-fetch under the same
    // request rather than relying on the cache so a freshly-mutated row
    // is reflected in the guard.
    const existing = await fastify.pg.query(
      `SELECT status FROM control.tenants WHERE id = $1`,
      [req.params.id],
    )
    if (!existing.length) return reply.notFound('tenant not found')
    if (existing[0].status === 'pending_delete') {
      return reply.conflict("tenant is pending_delete — patches are not accepted")
    }

    const sets = []
    const params = []
    let p = 1
    if (displayName !== undefined) { sets.push(`display_name = $${p++}`); params.push(displayName) }
    if (status !== undefined)      { sets.push(`status = $${p++}`);       params.push(status) }
    if (metadata !== undefined)    { sets.push(`metadata = $${p++}::jsonb`); params.push(JSON.stringify(metadata)) }

    if (!sets.length) {
      const current = await fastify.pg.query(`
        SELECT id, slug, display_name, status, schema_name, neo4j_database,
               created_at, created_by, metadata
        FROM control.tenants WHERE id = $1
      `, [req.params.id])
      return current[0]
    }

    const rows = await fastify.pg.query(`
      UPDATE control.tenants
      SET ${sets.join(', ')}
      WHERE id = $${p}
      RETURNING id, slug, display_name, status, schema_name, neo4j_database,
                created_at, created_by, metadata
    `, [...params, req.params.id])

    invalidateTenantCache()
    return rows[0]
  })

  // ── DELETE /admin/tenants/:id ────────────────────────────────────────────
  fastify.delete('/tenants/:id', {
    config: { scope: 'super-admin' },
    schema: {
      tags:        ['Admin'],
      summary:     'Soft-delete a tenant',
      description: 'Sets status = pending_delete. Hard delete (drop schema, drop Neo4j database, delete rows) is a Phase 4 background job. Cannot delete the seeded `default` tenant — that row is the migration backstop for single-tenant deployments.',
      params:      { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        204: { type: 'null' },
        404: StandardErrorResponses[404],
        409: StandardErrorResponses[409],
      },
    },
  }, async (req, reply) => {
    if (!pgOk()) return reply.serviceUnavailable('Postgres not available')

    const rows = await fastify.pg.query(
      `SELECT slug, status FROM control.tenants WHERE id = $1`,
      [req.params.id],
    )
    if (!rows.length) return reply.notFound('tenant not found')
    if (rows[0].slug === 'default') {
      return reply.conflict("the 'default' tenant cannot be deleted — it backstops single-tenant deployments")
    }
    if (rows[0].status === 'pending_delete') {
      return reply.conflict('tenant is already pending deletion')
    }

    // Refuse if the tenant still has active (non-revoked) keys. Forces
    // the operator to revoke them explicitly so a stale CI key doesn't
    // keep authenticating against a tenant we're about to drop.
    const keyRows = await fastify.pg.query(
      `SELECT count(*)::int AS active_keys
         FROM api_keys
        WHERE tenant_id = $1 AND revoked_at IS NULL`,
      [req.params.id],
    )
    const activeKeys = keyRows[0]?.active_keys ?? 0
    if (activeKeys > 0) {
      return reply.conflict(
        `tenant has ${activeKeys} active API key(s) — revoke them before deletion`,
      )
    }

    await fastify.pg.query(
      `UPDATE control.tenants SET status = 'pending_delete' WHERE id = $1`,
      [req.params.id],
    )
    invalidateTenantCache()
    reply.code(204)
  })
}
