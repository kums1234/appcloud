// ── Audit Log Query API ───────────────────────────────────────────────────────
// GET /audit                  — paginated log with filters
// GET /audit/stats            — counts by action, resource_type, actor
// GET /audit/resource/:type/:id — full history for one resource
// GET /audit/actor/:name      — all actions by one actor

export default async function auditRoutes(fastify) {
  // Gracefully no-op when Postgres is unavailable
  const pgOk = () => !!fastify.pg?.pool

  // ── GET /audit — paginated, filterable log ──────────────────────────────────
  fastify.get('/', async (req, reply) => {
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
  fastify.get('/stats', async (req, reply) => {
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
  fastify.get('/resource/:type/:id', async (req, reply) => {
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
  fastify.get('/actor/:name', async (req, reply) => {
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