// routes/cmdb.js
//
// CMDB assessment API. Read-only views of the per-CI scores + :REPRESENTS
// edges that services/cmdb-assessment produces, plus a manual refresh
// endpoint for operational use.
//
// Endpoints:
//   GET  /cmdb/assessment          paginated list with filters
//   GET  /cmdb/assessment/state    current scheduler state (dirty / last run)
//   GET  /cmdb/assessment/runs     recent run history
//   GET  /cmdb/assessment/:sys_id  detail for one CI with matched Infra
//   POST /cmdb/assessment/refresh  fire-and-forget manual run

import { props, serialize } from '../utils/serialize.js'

export default async function cmdbRoutes(fastify) {
  const { query } = fastify.neo4j
  const pg   = fastify.pg
  const auth = { preHandler: fastify.authenticate }

  // ── GET /cmdb/assessment ───────────────────────────────────────────────────
  // Filters: minRelevance, minQuality, maxRelevance, maxQuality,
  //          sys_class_name, matched ('true'|'false'), q (free-text name).
  // Pagination: page (1-based), pageSize (default 50, max 200).
  fastify.get('/assessment', async (req, reply) => {
    const {
      page = 1,
      pageSize = 50,
      minRelevance, maxRelevance,
      minQuality,   maxQuality,
      sys_class_name,
      matched,
      q,
    } = req.query

    const limit  = Math.min(parseInt(pageSize) || 50, 200)
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit

    const where = []
    const params = { limit, offset }
    if (minRelevance != null) { where.push('ci.relevance >= $minRel'); params.minRel = Number(minRelevance) }
    if (maxRelevance != null) { where.push('ci.relevance <= $maxRel'); params.maxRel = Number(maxRelevance) }
    if (minQuality   != null) { where.push('ci.quality   >= $minQua'); params.minQua = Number(minQuality) }
    if (maxQuality   != null) { where.push('ci.quality   <= $maxQua'); params.maxQua = Number(maxQuality) }
    if (sys_class_name)       { where.push('ci.sys_class_name = $cls'); params.cls = sys_class_name }
    if (q)                    { where.push('toLower(ci.name) CONTAINS toLower($q)'); params.q = q }

    let matchedClause = ''
    if (matched === 'true')  matchedClause = `MATCH (ci)-[rep:REPRESENTS]->(:Infra) WHERE rep.expiredAt IS NULL`
    if (matched === 'false') matchedClause = `OPTIONAL MATCH (ci)-[rep:REPRESENTS]->(:Infra) WITH ci, count(rep) AS repCount WHERE repCount = 0`

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const countSql = `
      MATCH (ci:CmdbCi)
      ${whereSql}
      ${matchedClause}
      RETURN count(DISTINCT ci) AS total
    `
    const rowsSql = `
      MATCH (ci:CmdbCi)
      ${whereSql}
      ${matchedClause}
      OPTIONAL MATCH (ci)-[r:REPRESENTS]->(i:Infra)
      WHERE r.expiredAt IS NULL
      WITH ci, collect(DISTINCT { infraId: i.id, infraName: i.name,
                                  matchType: r.matchType, confidence: r.confidence }) AS matches
      RETURN ci, matches
      ORDER BY ci.relevance ASC NULLS FIRST, ci.quality ASC NULLS FIRST, ci.name ASC
      SKIP $offset LIMIT $limit
    `

    const [countRes, rowsRes] = await Promise.all([
      query(countSql, params),
      query(rowsSql,  params),
    ])
    const total = serialize(countRes[0]?.get('total') ?? 0)

    const items = rowsRes.map(r => {
      const ci = props(r.get('ci'))
      const matches = (r.get('matches') || [])
        .filter(m => m?.infraId)
        .map(m => ({ ...m, confidence: serialize(m.confidence) }))
      return {
        sys_id:     ci.sys_id,
        name:       ci.name,
        sys_class_name: ci.sys_class_name,
        relevance:  serialize(ci.relevance),
        quality:    serialize(ci.quality),
        assessedAt: ci.assessedAt,
        matched:    matches.length > 0,
        matches,
      }
    })

    return { total, page: Math.max(parseInt(page) || 1, 1), pageSize: limit, items }
  })

  // ── GET /cmdb/assessment/state ────────────────────────────────────────────
  fastify.get('/assessment/state', async () => {
    const state = await fastify.cmdbAssessment?.readState?.() || null
    return {
      ...state,
      intervalMs: parseInt(process.env.CMDB_ASSESSMENT_INTERVAL_MS || '60000', 10),
      backstopMs: parseInt(process.env.CMDB_ASSESSMENT_BACKSTOP_MS || String(30 * 60_000), 10),
    }
  })

  // ── GET /cmdb/assessment/runs ─────────────────────────────────────────────
  fastify.get('/assessment/runs', async (req) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const rows = await pg.query(
      `SELECT id, episode_id, trigger, started_at, finished_at, duration_ms,
              cis_total, infra_total, matched_count, unmatched_count,
              outcome, error_message
         FROM cmdb_assessment_runs
         ORDER BY started_at DESC
         LIMIT $1`,
      [limit],
    )
    return rows
  })

  // ── GET /cmdb/assessment/:sys_id ──────────────────────────────────────────
  fastify.get('/assessment/:sys_id', async (req, reply) => {
    const records = await query(`
      MATCH (ci:CmdbCi { sys_id: $sys_id })
      OPTIONAL MATCH (ci)-[r:REPRESENTS]->(i:Infra)
      WITH ci, collect(DISTINCT {
        edge: {
          matchType: r.matchType, confidence: r.confidence,
          evidence:  r.evidence,  validAt:   r.validAt,
          expiredAt: r.expiredAt, lastSeenAt: r.lastSeenAt,
          episodeId: r.episodeId,
        },
        infra: CASE WHEN i IS NULL THEN null ELSE {
          id: i.id, name: i.name, provider: i.provider, resource_type: i.resource_type,
        } END
      }) AS matches
      RETURN ci, matches
    `, { sys_id: req.params.sys_id })

    if (!records.length) return reply.notFound(`CI ${req.params.sys_id} not found`)
    const ci = props(records[0].get('ci'))
    const matches = (records[0].get('matches') || []).filter(m => m?.infra)
    let reasons = null
    if (ci.assessReasons) {
      try { reasons = JSON.parse(ci.assessReasons) } catch {}
    }
    return {
      ...ci,
      relevance: serialize(ci.relevance),
      quality:   serialize(ci.quality),
      reasons,
      matches:   matches.map(m => ({
        ...m.infra,
        ...m.edge,
        confidence: serialize(m.edge.confidence),
      })),
    }
  })

  // ── POST /cmdb/assessment/refresh ─────────────────────────────────────────
  // Fire-and-forget — kicks off a run in the background and returns 202.
  fastify.post('/assessment/refresh', { ...auth }, async (req, reply) => {
    if (!fastify.cmdbAssessment?.runNow) {
      return reply.serviceUnavailable('cmdb assessment scheduler not loaded')
    }
    // Don't await — return immediately, result lands in cmdb_assessment_runs.
    fastify.cmdbAssessment.runNow('manual').catch(err =>
      fastify.log.warn(`[CmdbAssess] manual refresh failed: ${err.message}`),
    )
    reply.code(202).send({ accepted: true })
  })
}
