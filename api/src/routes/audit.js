// ── Audit Log Query API ───────────────────────────────────────────────────────
// GET /audit                  — paginated log with filters
// GET /audit/stats            — counts by action, resource_type, actor
// GET /audit/resource/:type/:id — full history for one resource
// GET /audit/actor/:name      — all actions by one actor

export default async function auditRoutes(fastify) {
  // Gracefully no-op when Postgres is unavailable
  const pgOk = () => !!fastify.pg?.pool

  // ── GET /audit — paginated, filterable log ──────────────────────────────────
  fastify.get('/', {
    schema: {
      summary:     'Paginated audit log',
      description: 'Every mutation API call writes a row here. Filterable by `action` / `resourceType` / `resourceId` / `actor` / time window (`from`, `to`) / free-text (`q`). Returns `{ rows, total, page, pageSize, pages }`.',
      querystring: { type: 'object', additionalProperties: true, properties: {
        page:         { type: ['integer', 'string'] },
        pageSize:     { type: ['integer', 'string'] },
        action:       { type: 'string' },
        resourceType: { type: 'string' },
        resourceId:   { type: 'string' },
        actor:        { type: 'string' },
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
      actor,           // filter by actor name
      from,            // ISO date string — lower bound on created_at
      to,              // ISO date string — upper bound on created_at
      q,               // free-text search on resource_name + actor
    } = req.query

    const limit  = Math.min(parseInt(pageSize) || 50, 200)
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit

    // Build WHERE clauses dynamically
    const conditions = []
    const params     = []
    let   p          = 1

    if (action)       { conditions.push(`action = $${p++}`)        ; params.push(action) }
    if (resourceType) { conditions.push(`resource_type = $${p++}`) ; params.push(resourceType) }
    if (resourceId)   { conditions.push(`resource_id = $${p++}`)   ; params.push(resourceId) }
    if (actor)        { conditions.push(`actor ILIKE $${p++}`)      ; params.push(`%${actor}%`) }
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
        `SELECT id, actor, action, resource_type, resource_id,
                resource_name, diff, metadata, created_at
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
      rows: rows.map(r => ({
        id:           r.id,
        actor:        r.actor,
        action:       r.action,
        resourceType: r.resource_type,
        resourceId:   r.resource_id,
        resourceName: r.resource_name,
        diff:         r.diff,
        metadata:     r.metadata,
        createdAt:    r.created_at,
      })),
      total,
      page:     parseInt(page),
      pageSize: limit,
      pages:    Math.ceil(total / limit),
    }
  })

  // ── GET /audit/stats — aggregated counts ──────────────────────────────────
  fastify.get('/stats', {
    schema: {
      summary:     'Audit-log analytics for the last N days',
      description: 'Returns counts grouped by action / resource_type / actor plus a daily-activity series for sparklines. Default window is 30 days; pass `?days=N` to widen.',
      querystring: { type: 'object', properties: { days: { type: ['integer', 'string'], default: 30 } } },
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!pgOk()) return { byAction: {}, byResourceType: {}, byActor: [], recentActivity: [] }

    const { days = 30 } = req.query

    const [byAction, byType, byActor, daily] = await Promise.all([
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

      // Top actors
      fastify.pg.query(`
        SELECT actor, COUNT(*) AS cnt,
               array_agg(DISTINCT action ORDER BY action) AS actions
        FROM audit_log
        WHERE created_at >= now() - ($1 || ' days')::interval
          AND actor IS NOT NULL
        GROUP BY actor ORDER BY cnt DESC LIMIT 20
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
      topActors:      byActor.map(r => ({
        actor:   r.actor,
        count:   parseInt(r.cnt),
        actions: r.actions,
      })),
      dailyActivity: daily.map(r => ({
        day:   r.day,
        count: parseInt(r.cnt),
      })),
    }
  })

  // ── GET /audit/resource/:type/:id — full history for one resource ──────────
  fastify.get('/resource/:type/:id', {
    schema: {
      summary:     'Full audit history for a specific resource',
      description: 'Up to the last 500 events for one (resource_type, resource_id) pair, newest first. `resource_type` is one of `Application`, `Component`, `Infra`, `CloudAccount`, etc.',
      params:      { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' } } },
      response:    { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req, reply) => {
    if (!pgOk()) return []
    const rows = await fastify.pg.query(`
      SELECT id, actor, action, resource_type, resource_id,
             resource_name, diff, metadata, created_at
      FROM audit_log
      WHERE resource_type = $1 AND resource_id = $2
      ORDER BY created_at DESC
      LIMIT 500
    `, [req.params.type, req.params.id])

    return rows.map(r => ({
      id:           r.id,
      actor:        r.actor,
      action:       r.action,
      resourceType: r.resource_type,
      resourceId:   r.resource_id,
      resourceName: r.resource_name,
      diff:         r.diff,
      metadata:     r.metadata,
      createdAt:    r.created_at,
    }))
  })

  // ── GET /audit/actor/:name — all actions by a specific actor ──────────────
  // Constrain the actor name to a sane character set. The Postgres query
  // itself is parameterised so this is not an injection guard — it's a log-
  // injection guard for downstream log aggregators (ELK, Splunk) that often
  // splat `actor=<value>` into a single line; a value containing a newline
  // would forge a fake audit entry in those systems.
  const ACTOR_NAME_RE = /^[A-Za-z0-9._@:+-]{1,128}$/

  fastify.get('/actor/:name', {
    schema: {
      summary:     'All audit events by a specific actor (paginated)',
      description: 'Case-insensitive substring match on the `actor` column. Default actor for system-initiated calls is `system`; clients identify themselves via the `X-Actor` header.',
      params:      { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^[A-Za-z0-9._@:+-]{1,128}$' } } },
      querystring: { type: 'object', properties: { page: { type: ['integer', 'string'] }, pageSize: { type: ['integer', 'string'] } } },
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    if (!ACTOR_NAME_RE.test(req.params.name)) {
      return reply.badRequest('actor name must match [A-Za-z0-9._@:+-]{1,128}')
    }
    if (!pgOk()) return { rows: [], total: 0 }
    const { page = 1, pageSize = 50 } = req.query
    const limit  = Math.min(parseInt(pageSize) || 50, 200)
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit

    const [rows, countRows] = await Promise.all([
      fastify.pg.query(`
        SELECT id, actor, action, resource_type, resource_id,
               resource_name, diff, metadata, created_at
        FROM audit_log
        WHERE actor ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [`%${req.params.name}%`, limit, offset]),
      fastify.pg.query(
        `SELECT COUNT(*) AS total FROM audit_log WHERE actor ILIKE $1`,
        [`%${req.params.name}%`]
      ),
    ])

    return {
      rows: rows.map(r => ({
        id:           r.id,
        actor:        r.actor,
        action:       r.action,
        resourceType: r.resource_type,
        resourceId:   r.resource_id,
        resourceName: r.resource_name,
        diff:         r.diff,
        metadata:     r.metadata,
        createdAt:    r.created_at,
      })),
      total:    parseInt(countRows[0]?.total || 0),
      page:     parseInt(page),
      pageSize: limit,
    }
  })
}