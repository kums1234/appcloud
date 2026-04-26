// ── Audit Log Query API ───────────────────────────────────────────────────────
// GET /audit                  — paginated log with filters
// GET /audit/stats            — counts by action, resource_type, actor
// GET /audit/resource/:type/:id — full history for one resource
// GET /audit/actor/:name      — all actions by one actor
//
// All routes here are flagged `config.requireAdmin: true` — the audit log
// reveals operational patterns (who-did-what-when), so it shouldn't be
// readable with a regular API key. Admin tier comes from
// APPCLOUD_ADMIN_API_KEY{,_FILE}; when unset the routes return 503.

export default async function auditRoutes(fastify) {
  // Gracefully no-op when Postgres is unavailable
  const pgOk = () => !!fastify.pg?.pool

  // Shared row → response shape. Includes the slice-5 RBAC fields
  // (actorKeyId, actorScope) so admins can trace each row back to the
  // specific stored API key that performed the action.
  const mapRow = (r) => ({
    id:           r.id,
    actor:        r.actor,
    actorKeyId:   r.actor_key_id ?? null,
    actorScope:   r.actor_scope  ?? null,
    action:       r.action,
    resourceType: r.resource_type,
    resourceId:   r.resource_id,
    resourceName: r.resource_name,
    diff:         r.diff,
    metadata:     r.metadata,
    createdAt:    r.created_at,
  })

  // SELECT list reused across every audit query — keeping the column set
  // here means a future evolution (more attribution columns, indexed
  // tags, …) is one diff.
  const SELECT_COLS = `
    id, actor, actor_key_id, actor_scope, action,
    resource_type, resource_id, resource_name,
    diff, metadata, created_at
  `

  // Allowed scope values for the ?scope= filter — mirrors the auth-plugin
  // SCOPES constant but kept inline so this file has no extra runtime
  // dependency on the plugin.
  const SCOPE_FILTER_VALUES = new Set(['admin', 'write', 'read'])

  // ── GET /audit — paginated, filterable log ──────────────────────────────────
  fastify.get('/', {
    config: { requireAdmin: true },
    schema: {
      summary:     'Paginated audit log',
      description: 'Every mutation API call writes a row here. `actor` is exact-match by default — pass `?like=true` to opt into the legacy substring/ILIKE behaviour (separate keys with similar names like `ci-deploy-staging` / `ci-deploy-prod` previously collapsed into one query, which is now opt-in). Other filters: `action`, `resourceType`, `resourceId`, `keyId` (exact UUID), `scope` (admin|write|read), `from`/`to` (ISO date), `q` (substring on `resource_name` OR `actor`). Returns `{ rows, total, page, pageSize, pages }`. Each row includes `actorKeyId` and `actorScope` so a row can be traced back to the specific API key that performed the action.',
      querystring: { type: 'object', additionalProperties: false, properties: {
        page:         { type: ['integer', 'string'] },
        pageSize:     { type: ['integer', 'string'] },
        action:       { type: 'string' },
        resourceType: { type: 'string' },
        resourceId:   { type: 'string' },
        actor:        { type: 'string', description: 'Exact match by default. Set `like=true` for case-insensitive substring (legacy).' },
        like:         { type: 'string', enum: ['true', 'false'], description: 'Opt-in substring match for `actor` (default false = exact match).' },
        keyId:        { type: 'string', format: 'uuid', description: 'Exact match on actor_key_id — see GET /admin/api-keys for ids.' },
        scope:        { type: 'string', enum: ['admin', 'write', 'read'] },
        from:         { type: 'string', format: 'date-time' },
        to:           { type: 'string', format: 'date-time' },
        q:            { type: 'string' },
      } },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!pgOk()) return { rows: [], total: 0, page: 1, pageSize: 50, note: 'Postgres unavailable' }

    const {
      page       = 1,
      pageSize   = 50,
      action,          // filter by action: create|update|delete|approve|reject|login|...
      resourceType,    // filter by resource_type: Application|Component|Infra|User|...
      resourceId,      // filter by specific resource
      actor,           // filter by actor name (exact match by default)
      like,            // 'true' to opt into substring match on `actor` (legacy)
      keyId,           // filter by actor_key_id (exact)
      scope,           // filter by actor_scope (admin|write|read)
      from,            // ISO date string — lower bound on created_at
      to,              // ISO date string — upper bound on created_at
      q,               // free-text search on resource_name + actor
    } = req.query

    if (scope && !SCOPE_FILTER_VALUES.has(scope)) {
      return reply.badRequest(`scope must be one of ${[...SCOPE_FILTER_VALUES].join(', ')}`)
    }

    const limit  = Math.min(parseInt(pageSize) || 50, 200)
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit

    // Build WHERE clauses dynamically. The `actor` matcher flips between
    // exact (default) and ILIKE-substring (opt-in via like=true) — substring
    // match was the previous default but collapsed across similarly-named
    // keys (e.g. `ci-deploy` matching `ci-deploy-staging`/`ci-deploy-prod`).
    const conditions = []
    const params     = []
    let   p          = 1

    if (action)       { conditions.push(`action = $${p++}`)        ; params.push(action) }
    if (resourceType) { conditions.push(`resource_type = $${p++}`) ; params.push(resourceType) }
    if (resourceId)   { conditions.push(`resource_id = $${p++}`)   ; params.push(resourceId) }
    if (actor) {
      if (like === 'true') { conditions.push(`actor ILIKE $${p++}`); params.push(`%${actor}%`) }
      else                 { conditions.push(`actor = $${p++}`)    ; params.push(actor) }
    }
    if (keyId)        { conditions.push(`actor_key_id = $${p++}`)  ; params.push(keyId) }
    if (scope)        { conditions.push(`actor_scope = $${p++}`)   ; params.push(scope) }
    if (from)         { conditions.push(`created_at >= $${p++}`)   ; params.push(from) }
    if (to)           { conditions.push(`created_at <= $${p++}`)   ; params.push(to) }
    if (q) {
      conditions.push(`(resource_name ILIKE $${p} OR actor ILIKE $${p})`)
      params.push(`%${q}%`)
      p++
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const [rows, countRows] = await Promise.all([
      fastify.pg.query(
        `SELECT ${SELECT_COLS}
         FROM audit_log
         ${where}
         ORDER BY created_at DESC
         LIMIT $${p} OFFSET $${p + 1}`,
        [...params, limit, offset]
      ),
      fastify.pg.query(
        `SELECT COUNT(*) AS total FROM audit_log ${where}`,
        params
      ),
    ])

    const total = parseInt(countRows[0]?.total || 0)
    return {
      rows: rows.map(mapRow),
      total,
      page:     parseInt(page),
      pageSize: limit,
      pages:    Math.ceil(total / limit),
    }
  })

  // ── GET /audit/stats — aggregated counts ──────────────────────────────────
  fastify.get('/stats', {
    config: { requireAdmin: true },
    schema: {
      summary:     'Audit-log analytics for the last N days',
      description: 'Returns counts grouped by action / resource_type / actor plus a daily-activity series for sparklines. Default window is 30 days; pass `?days=N` to widen.',
      querystring: { type: 'object', properties: { days: { type: ['integer', 'string'], default: 30 } } },
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!pgOk()) return { byAction: {}, byResourceType: {}, byActor: [], byScope: {}, recentActivity: [] }

    const { days = 30 } = req.query

    const [byAction, byType, byActor, byScope, daily] = await Promise.all([
      // Count by action
      fastify.pg.query(`
        SELECT action, COUNT(*) AS cnt
        FROM audit_log
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY action ORDER BY cnt DESC
      `, [parseInt(days)]),

      // Count by resource_type
      fastify.pg.query(`
        SELECT resource_type, COUNT(*) AS cnt
        FROM audit_log
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY resource_type ORDER BY cnt DESC
      `, [parseInt(days)]),

      // Top actors — group by (actor_key_id, actor) so two keys that
      // happened to share a display name (e.g. a name reused after the
      // original key was revoked, or two bootstrap rows from different
      // env files) surface as separate rows instead of collapsing into
      // one. The actor_key_id is NULL for system / unauthenticated rows;
      // those still group together under their text actor.
      fastify.pg.query(`
        SELECT actor,
               actor_key_id,
               COUNT(*) AS cnt,
               array_agg(DISTINCT action       ORDER BY action)       AS actions,
               array_agg(DISTINCT actor_scope) FILTER (WHERE actor_scope IS NOT NULL) AS scopes
        FROM audit_log
        WHERE created_at >= now() - ($1 || ' days')::interval
          AND actor IS NOT NULL
        GROUP BY actor_key_id, actor
        ORDER BY cnt DESC LIMIT 20
      `, [parseInt(days)]),

      // Count by actor_scope — pre-RBAC rows show up under '(none)' so
      // operators can see the migration progress.
      fastify.pg.query(`
        SELECT COALESCE(actor_scope, '(none)') AS scope, COUNT(*) AS cnt
        FROM audit_log
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY actor_scope ORDER BY cnt DESC
      `, [parseInt(days)]),

      // Daily activity for sparkline (last 30 days)
      fastify.pg.query(`
        SELECT date_trunc('day', created_at)::date AS day,
               COUNT(*) AS cnt
        FROM audit_log
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY day ORDER BY day ASC
      `, [parseInt(days)]),
    ])

    return {
      period:         `${days}d`,
      byAction:       Object.fromEntries(byAction.map(r => [r.action, parseInt(r.cnt)])),
      byResourceType: Object.fromEntries(byType.map(r => [r.resource_type, parseInt(r.cnt)])),
      byScope:        Object.fromEntries(byScope.map(r => [r.scope, parseInt(r.cnt)])),
      topActors:      byActor.map(r => ({
        actor:      r.actor,
        actorKeyId: r.actor_key_id ?? null,    // null for system / pre-RBAC rows
        count:      parseInt(r.cnt),
        actions:    r.actions,
        scopes:     r.scopes ?? [],
      })),
      dailyActivity: daily.map(r => ({
        day:   r.day,
        count: parseInt(r.cnt),
      })),
    }
  })

  // ── GET /audit/resource/:type/:id — full history for one resource ──────────
  fastify.get('/resource/:type/:id', {
    config: { requireAdmin: true },
    schema: {
      summary:     'Full audit history for a specific resource',
      description: 'Up to the last 500 events for one (resource_type, resource_id) pair, newest first. `resource_type` is one of `Application`, `Component`, `Infra`, `CloudAccount`, etc.',
      params:      { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' } } },
      response:    { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req, reply) => {
    if (!pgOk()) return []
    const rows = await fastify.pg.query(`
      SELECT ${SELECT_COLS}
      FROM audit_log
      WHERE resource_type = $1 AND resource_id = $2
      ORDER BY created_at DESC
      LIMIT 500
    `, [req.params.type, req.params.id])

    return rows.map(mapRow)
  })

  // ── GET /audit/actor/:name — all actions by a specific actor ──────────────
  // Constrain the actor name to a sane character set. The Postgres query
  // itself is parameterised so this is not an injection guard — it's a log-
  // injection guard for downstream log aggregators (ELK, Splunk) that often
  // splat `actor=<value>` into a single line; a value containing a newline
  // would forge a fake audit entry in those systems.
  const ACTOR_NAME_RE = /^[A-Za-z0-9._@:+-]{1,128}$/

  fastify.get('/actor/:name', {
    config: { requireAdmin: true },
    schema: {
      summary:     'All audit events by a specific actor (paginated)',
      description: 'Exact match on the `actor` column by default. Pass `?like=true` for case-insensitive substring (legacy behaviour, collapses across similarly-named keys). Optional `?keyId=<uuid>` narrows to a specific stored API key (exact match on actor_key_id) — preferable to substring-name matching once you know the key id. Optional `?scope=admin|write|read` narrows to one privilege tier.',
      params:      { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^[A-Za-z0-9._@:+-]{1,128}$' } } },
      querystring: { type: 'object', additionalProperties: false, properties: {
        page:     { type: ['integer', 'string'] },
        pageSize: { type: ['integer', 'string'] },
        keyId:    { type: 'string', format: 'uuid' },
        scope:    { type: 'string', enum: ['admin', 'write', 'read'] },
        like:     { type: 'string', enum: ['true', 'false'], description: 'Opt-in substring match (default false = exact match).' },
      } },
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!ACTOR_NAME_RE.test(req.params.name)) {
      return reply.badRequest('actor name must match [A-Za-z0-9._@:+-]{1,128}')
    }
    if (!pgOk()) return { rows: [], total: 0 }
    const { page = 1, pageSize = 50, keyId, scope, like } = req.query
    if (scope && !SCOPE_FILTER_VALUES.has(scope)) {
      return reply.badRequest(`scope must be one of ${[...SCOPE_FILTER_VALUES].join(', ')}`)
    }
    const limit  = Math.min(parseInt(pageSize) || 50, 200)
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit

    // Mirror the filter wiring in GET / so the param-numbering is explicit.
    // Substring matching is opt-in via ?like=true; default is exact match
    // so two keys named `ci-deploy-staging` and `ci-deploy-prod` no longer
    // collide on a query for `ci-deploy`.
    const conditions = like === 'true'
      ? [`actor ILIKE $1`]
      : [`actor = $1`]
    const params     = like === 'true'
      ? [`%${req.params.name}%`]
      : [req.params.name]
    let   p          = 2
    if (keyId) { conditions.push(`actor_key_id = $${p++}`); params.push(keyId) }
    if (scope) { conditions.push(`actor_scope  = $${p++}`); params.push(scope) }
    const where = `WHERE ${conditions.join(' AND ')}`

    const [rows, countRows] = await Promise.all([
      fastify.pg.query(`
        SELECT ${SELECT_COLS}
        FROM audit_log
        ${where}
        ORDER BY created_at DESC
        LIMIT $${p} OFFSET $${p + 1}
      `, [...params, limit, offset]),
      fastify.pg.query(
        `SELECT COUNT(*) AS total FROM audit_log ${where}`,
        params
      ),
    ])

    return {
      rows:     rows.map(mapRow),
      total:    parseInt(countRows[0]?.total || 0),
      page:     parseInt(page),
      pageSize: limit,
    }
  })
}