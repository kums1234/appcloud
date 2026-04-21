// api/src/plugins/otel-aggregator.js
//
// Periodic worker that drains `otel_spans_raw` into the Neo4j graph.
//
// Design ported from otel_genai_graph_exporter's mapper/sink — the
// three-sweep pattern:
//   1. Parse sweep      — group rows by (service_name, namespace, env)
//                         → :Component node candidates.
//   2. Relationship     — resolve parent_span_id within the batch. A span
//      sweep              whose parent belongs to a different service
//                         contributes to a cross-service edge, with its
//                         duration + status folded into aggregates.
//   3. Emit sweep       — UNWIND-batched MERGE of :Component nodes and
//                         :CONNECTED_TO edges (plus typed aliases per via),
//                         then delete the consumed rows.
//
// At-least-once semantics: we SELECT row ids, write Neo4j, then DELETE only
// those ids. A Neo4j write failure leaves rows for the next tick. Edge
// properties are OVERWRITTEN per window (not accumulated), so an accidental
// re-aggregation is a no-op in Cypher terms.
//
// Lookback note: if a parent span arrived in a previous tick (already
// purged), the child's edge contribution is lost. In practice traces finish
// within the default 1-minute tick window, so this is rare. Tune
// OTEL_AGG_INTERVAL_MS shorter or add a retention window in a follow-up if
// observed in production.

import { VIA_TO_REL_TYPE, TELEMETRY_COMPONENT_LABELS } from '../routes/discovery.schema.js'

const DEFAULT_INTERVAL_MS = parseInt(process.env.OTEL_AGG_INTERVAL_MS || '60000', 10)
const DEFAULT_BATCH_SIZE  = parseInt(process.env.OTEL_AGG_BATCH_SIZE  || '5000', 10)
const SAFETY_MAX_AGE_HRS  = parseInt(process.env.OTEL_AGG_MAX_AGE_HRS || '24', 10)

// ── Pure helpers (exported for unit tests) ─────────────────────────────────

export function componentKey(row) {
  return `${row.service_namespace || ''}|${row.service_name || ''}|${row.deployment_environment || ''}`
}

// Pick a via value + typed relationship alias based on span attributes.
// The spec defines otel-http / otel-rpc / otel-db / otel-messaging in
// VIA_TO_REL_TYPE; we fall back to otel-http for anything unclassified.
export function inferVia(attrs, resAttrs) {
  const a = attrs || {}
  const r = resAttrs || {}
  if (a['db.system'])               return 'otel-db'
  if (a['messaging.system'])        return 'otel-messaging'
  if (a['rpc.system'] || a['rpc.service']) return 'otel-rpc'
  if (a['http.method'] || a['http.scheme'] || a['http.route']) return 'otel-http'
  if (r['telemetry.sdk.language'])  return 'otel-http'   // weak default
  return 'otel-http'
}

export function inferProtocol(attrs) {
  return attrs?.['http.scheme']
      || attrs?.['rpc.system']
      || attrs?.['db.system']
      || attrs?.['messaging.system']
      || null
}

export function inferRoute(attrs) {
  return attrs?.['http.route']
      || attrs?.['http.target']
      || attrs?.['rpc.method']
      || attrs?.['db.statement']
      || null
}

export function percentile(sortedMs, p) {
  if (!sortedMs.length) return 0
  const idx = Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * p))
  return sortedMs[idx]
}

/**
 * Pure aggregation over an in-memory batch of raw span rows. Returns the
 * component + edge candidates and the window bounds. Extracted from runTick
 * so unit tests can exercise the three sweeps without a live Neo4j.
 */
export function aggregateBatch(rows) {
  const components = new Map()
  for (const r of rows) {
    if (!r.service_name) continue
    const key = componentKey(r)
    if (!components.has(key)) {
      components.set(key, {
        key,
        name:        r.service_name,
        namespace:   r.service_namespace || '',
        environment: r.deployment_environment || '',
        sampleResourceAttrsJson: JSON.stringify(r.resource_attributes || {}),
      })
    }
  }

  const byHex = new Map()
  for (const r of rows) {
    if (r.span_id) byHex.set(Buffer.isBuffer(r.span_id) ? r.span_id.toString('hex') : String(r.span_id), r)
  }

  const edges = new Map()
  let windowStartNs = Infinity
  let windowEndNs   = -Infinity
  for (const r of rows) {
    const startNs = Number(r.start_time_ns)
    const endNs   = Number(r.end_time_ns)
    if (startNs < windowStartNs) windowStartNs = startNs
    if (endNs   > windowEndNs)   windowEndNs   = endNs

    if (!r.parent_span_id) continue
    const parentKey = Buffer.isBuffer(r.parent_span_id)
      ? r.parent_span_id.toString('hex')
      : String(r.parent_span_id)
    const parent = byHex.get(parentKey)
    if (!parent) continue
    if (!parent.service_name || !r.service_name) continue
    const srcKey = componentKey(parent)
    const dstKey = componentKey(r)
    if (srcKey === dstKey) continue

    const via     = inferVia(r.attributes, r.resource_attributes)
    const edgeKey = `${srcKey}→${dstKey}|${via}`
    if (!edges.has(edgeKey)) {
      edges.set(edgeKey, {
        srcKey, dstKey, via,
        protocol:    inferProtocol(r.attributes),
        route:       inferRoute(r.attributes),
        total:       0,
        errors:      0,
        durationsMs: [],
      })
    }
    const e = edges.get(edgeKey)
    e.total++
    if (r.status_code === 2) e.errors++
    e.durationsMs.push(Math.max(0, (endNs - startNs) / 1_000_000))
  }

  const windowStartIso = windowStartNs === Infinity
    ? new Date().toISOString()
    : new Date(windowStartNs / 1_000_000).toISOString()
  const windowEndIso   = windowEndNs   === -Infinity
    ? windowStartIso
    : new Date(windowEndNs   / 1_000_000).toISOString()
  const windowSeconds  = Math.max(1, (Date.parse(windowEndIso) - Date.parse(windowStartIso)) / 1000)

  const edgeArray = []
  for (const e of edges.values()) {
    e.durationsMs.sort((a, b) => a - b)
    const [srcNs, srcName, srcEnv] = e.srcKey.split('|')
    const [dstNs, dstName, dstEnv] = e.dstKey.split('|')
    edgeArray.push({
      srcName, srcNs, srcEnv,
      dstName, dstNs, dstEnv,
      via:         e.via,
      protocol:    e.protocol,
      route:       e.route,
      rps:         +(e.total / windowSeconds).toFixed(4),
      errorRate:   +(e.total > 0 ? e.errors / e.total : 0).toFixed(4),
      p50Ms:       +percentile(e.durationsMs, 0.5).toFixed(3),
      p95Ms:       +percentile(e.durationsMs, 0.95).toFixed(3),
      windowStart: windowStartIso,
      windowEnd:   windowEndIso,
    })
  }

  return {
    components: Array.from(components.values()),
    edges:      edgeArray,
    windowStart: windowStartIso,
    windowEnd:   windowEndIso,
  }
}

// ── Core tick ───────────────────────────────────────────────────────────────
async function runTick(fastify) {
  if (!fastify.pg?.pool || !fastify.neo4j?.write) return null

  // Safety purge of very old rows — unconditional so a backlog of spans we
  // could never aggregate (e.g. Neo4j has been down for hours) doesn't fill
  // the table forever.
  try {
    const purged = await fastify.pg.query(
      `DELETE FROM otel_spans_raw
        WHERE received_at < now() - ($1 || ' hours')::interval
        RETURNING id`,
      [String(SAFETY_MAX_AGE_HRS)],
    )
    if (purged.length) {
      fastify.log.warn(`[otel-aggregator] safety-purged ${purged.length} row(s) older than ${SAFETY_MAX_AGE_HRS}h`)
    }
  } catch (err) {
    fastify.log.warn(`[otel-aggregator] safety-purge error: ${err.message}`)
  }

  // Claim a batch, ordered oldest-first so we process in arrival order.
  const rows = await fastify.pg.query(
    `SELECT id, trace_id, span_id, parent_span_id,
            service_name, service_namespace, deployment_environment,
            span_name, span_kind, start_time_ns, end_time_ns, status_code,
            attributes, resource_attributes, received_at
       FROM otel_spans_raw
       ORDER BY received_at
       LIMIT $1`,
    [DEFAULT_BATCH_SIZE],
  )
  if (!rows.length) return { processed: 0, components: 0, edges: 0 }

  const t0 = Date.now()

  // Sweeps 1 + 2 are pure in-memory logic — see aggregateBatch() above.
  const { components: componentArray, edges: edgeArray } = aggregateBatch(rows)
  const teleLabels = TELEMETRY_COMPONENT_LABELS.join(':')

  try {
    await fastify.neo4j.write(`
      UNWIND $components AS c
      MERGE (comp:Component { name: c.name, origin_source: 'otel', origin_namespace: c.namespace })
        ON CREATE SET comp.id = randomUUID(),
                      comp.created_at = datetime()
        ON MATCH  SET comp.updated_at = datetime()
      SET comp:${teleLabels},
          comp.environment           = c.environment,
          comp.source                = 'otel',
          comp.last_seen_at          = datetime(),
          comp.sample_resource_attrs = c.sampleResourceAttrsJson
    `, { components: componentArray })

    if (edgeArray.length) {
      // Legacy :CONNECTED_TO edge (kept for back-compat with existing queries)
      await fastify.neo4j.write(`
        UNWIND $edges AS e
        MATCH (src:Component { name: e.srcName, origin_source: 'otel', origin_namespace: e.srcNs })
        MATCH (dst:Component { name: e.dstName, origin_source: 'otel', origin_namespace: e.dstNs })
        MERGE (src)-[r:CONNECTED_TO { source: 'otel', via: e.via }]->(dst)
        SET   r.protocol     = e.protocol,
              r.route        = e.route,
              r.rps          = e.rps,
              r.error_rate   = e.errorRate,
              r.p50_ms       = e.p50Ms,
              r.p95_ms       = e.p95Ms,
              r.window_start = e.windowStart,
              r.window_end   = e.windowEnd,
              r.updated_at   = datetime()
      `, { edges: edgeArray })

      // Typed-alias edges (dual-write). One Cypher call per via-type so we
      // can use a static relationship name (MERGE doesn't accept a dynamic
      // rel name parameter).
      const byVia = new Map()
      for (const e of edgeArray) {
        if (!byVia.has(e.via)) byVia.set(e.via, [])
        byVia.get(e.via).push(e)
      }
      for (const [via, viaEdges] of byVia.entries()) {
        const typedRel = VIA_TO_REL_TYPE[via]
        if (!typedRel) continue
        await fastify.neo4j.write(`
          UNWIND $edges AS e
          MATCH (src:Component { name: e.srcName, origin_source: 'otel', origin_namespace: e.srcNs })
          MATCH (dst:Component { name: e.dstName, origin_source: 'otel', origin_namespace: e.dstNs })
          MERGE (src)-[r:${typedRel} { source: 'otel' }]->(dst)
          SET   r.protocol     = e.protocol,
                r.route        = e.route,
                r.rps          = e.rps,
                r.error_rate   = e.errorRate,
                r.p50_ms       = e.p50Ms,
                r.p95_ms       = e.p95Ms,
                r.window_start = e.windowStart,
                r.window_end   = e.windowEnd,
                r.updated_at   = datetime()
        `, { edges: viaEdges })
      }
    }
  } catch (err) {
    fastify.log.error(`[otel-aggregator] Neo4j write failed: ${err.message} — rows retained for next tick`)
    return { processed: 0, error: err.message }
  }

  // Delete the consumed rows only after Neo4j succeeds.
  try {
    const ids = rows.map(r => r.id)
    await fastify.pg.query(
      `DELETE FROM otel_spans_raw WHERE id = ANY($1::bigint[])`,
      [ids],
    )
  } catch (err) {
    fastify.log.warn(`[otel-aggregator] delete failed: ${err.message} — next tick may double-process (idempotent MERGE)`)
  }

  const elapsedMs = Date.now() - t0
  return {
    processed:  rows.length,
    components: componentArray.length,
    edges:      edgeArray.length,
    elapsedMs,
  }
}

// ── Plugin wrapper ──────────────────────────────────────────────────────────
export async function otelAggregatorPlugin(fastify) {
  let timer  = null
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const r = await runTick(fastify)
      if (r && r.processed > 0) {
        fastify.log.info(
          `[otel-aggregator] tick: ${r.processed} spans → ${r.components} components, ${r.edges} edges (${r.elapsedMs}ms)`,
        )
      }
    } catch (err) {
      fastify.log.error(`[otel-aggregator] tick error: ${err.message}`)
    } finally {
      running = false
    }
  }

  fastify.decorate('otelAggregator', { runNow: tick })

  fastify.addHook('onReady', async () => {
    if (!fastify.pg?.pool) {
      fastify.log.warn('[otel-aggregator] Postgres unavailable — worker disabled')
      return
    }
    fastify.log.info(`[otel-aggregator] enabled, tick every ${DEFAULT_INTERVAL_MS}ms (batch ${DEFAULT_BATCH_SIZE})`)
    timer = setInterval(tick, DEFAULT_INTERVAL_MS)
  })

  fastify.addHook('onClose', async () => {
    if (timer) { clearInterval(timer); timer = null }
  })
}
