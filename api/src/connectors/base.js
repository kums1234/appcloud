// api/src/connectors/base.js
//
// Shared helpers for connector implementations: retry, lightweight JSON Schema
// validation (required fields only), and a typed error class carrying the
// connector id + phase name for clean log attribution.

export class ConnectorError extends Error {
  constructor(connectorId, phase, cause, detail) {
    const msg = cause instanceof Error ? cause.message : String(cause ?? 'unknown error')
    super(`[${connectorId}/${phase}] ${msg}${detail ? ` — ${detail}` : ''}`)
    this.name = 'ConnectorError'
    this.connectorId = connectorId
    this.phase = phase
    this.cause = cause instanceof Error ? cause : new Error(msg)
  }
}

/**
 * Retry an async function with exponential backoff.
 * Caller is expected to supply an idempotent operation (e.g. a GET, or a
 * MERGE-based write). Errors from fn() bubble unchanged.
 */
export async function withRetry(fn, { attempts = 3, baseMs = 500, factor = 2, onAttempt } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try { return await fn(i) }
    catch (err) {
      lastErr = err
      onAttempt?.(i, err)
      if (i < attempts - 1) {
        const delay = baseMs * Math.pow(factor, i)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw lastErr
}

/**
 * Minimal JSON-Schema `required` check. Intentionally does NOT pull ajv — the
 * framework uses Fastify's route-level schema for body validation, and this
 * helper is only a safety net for connector-specific inner config objects.
 *
 *   validateRequired({ required: ['a','b'] }, { a: 1 }) → ['Missing required field: b']
 */
export function validateRequired(schema, value) {
  const errors = []
  if (!schema || !schema.required) return errors
  for (const field of schema.required) {
    if (value?.[field] == null || value[field] === '') {
      errors.push(`Missing required field: ${field}`)
    }
  }
  return errors
}

/**
 * Iterate a pull-style connector's async-generator fetch and accumulate
 * normalize → ingest batch-by-batch. Returns a combined IngestResult.
 * Safe to reuse across IaC + APM connectors.
 */
export async function runPullScan(spec, cfg, ctx) {
  if (typeof spec.fetch !== 'function' ||
      typeof spec.normalize !== 'function' ||
      typeof spec.ingest !== 'function') {
    throw new ConnectorError(spec.id, 'run', 'connector does not implement pull interface')
  }

  const agg = {
    resourcesFound: 0,
    resourcesCreated: 0,
    resourcesUpdated: 0,
    resourcesSkipped: 0,
    edgesCreated: 0,
    warnings: [],
  }

  for await (const raw of spec.fetch(cfg, ctx)) {
    if (ctx.signal?.aborted) {
      agg.warnings.push('aborted by scheduler')
      break
    }
    let normalized
    try { normalized = spec.normalize(raw, cfg) }
    catch (err) { throw new ConnectorError(spec.id, 'normalize', err) }

    let result
    try { result = await spec.ingest(normalized, ctx) }
    catch (err) { throw new ConnectorError(spec.id, 'ingest', err) }

    agg.resourcesFound    += result?.resourcesFound    ?? 0
    agg.resourcesCreated  += result?.resourcesCreated  ?? 0
    agg.resourcesUpdated  += result?.resourcesUpdated  ?? 0
    agg.resourcesSkipped  += result?.resourcesSkipped  ?? 0
    agg.edgesCreated      += result?.edgesCreated      ?? 0
    if (Array.isArray(result?.warnings)) agg.warnings.push(...result.warnings)
  }

  return agg
}
