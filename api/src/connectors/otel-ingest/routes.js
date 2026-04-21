// api/src/connectors/otel-ingest/routes.js
//
// OTLP/HTTP receiver. Mounted by the connector's receiver.register() hook.
//
// Path:  POST /ingest/otlp/v1/traces
// Auth:  Authorization: Bearer <token>   (hashed and matched against otel_tenants)
// Body:  OTLP/HTTP JSON — configure the OpenTelemetry Collector's otlphttp
//        exporter with `encoding: json`. Protobuf encoding returns 415 for now.
//
// Rows are staged in otel_spans_raw. The aggregation worker (Phase 1d)
// reads them in sliding windows and derives :Component / :CONNECTED_TO /
// :DEPLOYED_ON edges in Neo4j.

import { createHash } from 'crypto'
import { flattenResourceSpans, INSERT_COLS } from './parse.js'

const MAX_BODY_BYTES    = 10 * 1024 * 1024        // 10 MB per POST
const INSERT_CHUNK_ROWS = 100                     // keep under Postgres 65535-param cap

function parseBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || ''
  const m = String(h).match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function sha256Hex(s) {
  return createHash('sha256').update(String(s)).digest('hex')
}

async function resolveTenant(pg, token) {
  if (!token) return null
  const rows = await pg.query(
    `SELECT t.id, t.integration_id, i.enabled
       FROM otel_tenants t
       JOIN integrations i ON i.id = t.integration_id
       WHERE t.token_hash = $1`,
    [sha256Hex(token)],
  )
  if (!rows.length) return null
  if (rows[0].enabled === false) return null
  return rows[0]
}

async function insertSpans(pg, tenantId, rows) {
  if (!rows.length) return 0
  let inserted = 0
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK_ROWS)
    const placeholders = []
    const params = []
    let p = 1
    for (const r of chunk) {
      const spot = []
      for (const col of INSERT_COLS) {
        spot.push(`$${p++}`)
        if (col === 'tenant_id') params.push(tenantId)
        else if (col === 'attributes' || col === 'resource_attributes') params.push(JSON.stringify(r[col] || {}))
        else params.push(r[col])
      }
      placeholders.push(`(${spot.join(',')})`)
    }
    await pg.query(
      `INSERT INTO otel_spans_raw (${INSERT_COLS.join(',')}) VALUES ${placeholders.join(',')}`,
      params,
    )
    inserted += chunk.length
  }
  return inserted
}

// ── Fastify registration ────────────────────────────────────────────────────
export function registerOtlpRoutes(fastify) {
  fastify.post('/ingest/otlp/v1/traces', {
    bodyLimit: MAX_BODY_BYTES,
  }, async (req, reply) => {
    if (!fastify.pg?.pool) return reply.serviceUnavailable('Database not available')

    const token = parseBearer(req)
    if (!token) return reply.unauthorized('missing Authorization: Bearer <token>')

    const tenant = await resolveTenant(fastify.pg, token)
    if (!tenant) return reply.unauthorized('invalid or disabled token')

    const ct = (req.headers['content-type'] || '').toLowerCase()
    if (ct.includes('application/x-protobuf') || ct.includes('application/protobuf')) {
      return reply.code(415).send({
        error: 'OTLP protobuf encoding is not yet supported',
        hint:  'configure your OTel Collector otlphttp exporter with `encoding: json`',
      })
    }
    if (!ct.includes('application/json')) {
      return reply.code(415).send({ error: `unsupported content-type: ${ct || '(none)'}` })
    }

    const payload = req.body
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.resourceSpans)) {
      return reply.badRequest('body must be an OTLP/HTTP JSON object with a resourceSpans array')
    }

    const rows = flattenResourceSpans(payload)
    let inserted = 0
    try {
      inserted = await insertSpans(fastify.pg, tenant.id, rows)
    } catch (err) {
      fastify.log.error(`[otel-ingest] insert failed for tenant ${tenant.id}: ${err.message}`)
      return reply.internalServerError(`stage insert failed: ${err.message}`)
    }

    // OTLP/HTTP success response is a tiny JSON object per spec.
    return { received: rows.length, staged: inserted }
  })
}
