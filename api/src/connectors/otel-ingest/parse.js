// api/src/connectors/otel-ingest/parse.js
//
// Pure helpers for turning an OTLP/HTTP JSON payload into span-row objects.
// Extracted from routes.js so they can be unit-tested without booting
// Fastify or Postgres. routes.js re-exports from here.

/**
 * Unwrap an OTLP AnyValue JSON shape into a JS primitive / array / object.
 * Strings, ints, bools, doubles, byte-strings (base64) and nested key/value
 * lists are all supported.
 */
export function unwrapAnyValue(v) {
  if (v == null) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.boolValue   !== undefined) return !!v.boolValue
  if (v.intValue    !== undefined) return Number(v.intValue)
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.arrayValue?.values)        return v.arrayValue.values.map(unwrapAnyValue)
  if (v.kvlistValue?.values)       return kvListToObject(v.kvlistValue.values)
  if (v.bytesValue !== undefined)  return v.bytesValue
  return null
}

/** Turn an OTLP `KeyValue[]` into a flat { key: value } object. */
export function kvListToObject(list) {
  if (!Array.isArray(list)) return {}
  const out = {}
  for (const kv of list) {
    if (kv && typeof kv.key === 'string') out[kv.key] = unwrapAnyValue(kv.value)
  }
  return out
}

/**
 * Convert an OTLP hex trace_id / span_id into a Buffer suitable for BYTEA.
 * Accepts odd-length hex (left-pads one nibble) so a zero-prefix omission
 * by a careless client doesn't silently drop a nibble.
 */
export function hexToBuffer(hex) {
  if (!hex || typeof hex !== 'string') return null
  const padded = hex.length % 2 === 0 ? hex : '0' + hex
  return Buffer.from(padded, 'hex')
}

/**
 * Walk an OTLP/HTTP traces payload (`{ resourceSpans: [...] }`) and flatten
 * to an array of row objects suitable for inserting into otel_spans_raw.
 *
 * Accepts both the current `scopeSpans` and legacy `instrumentationLibrarySpans`
 * wrappers. BigInt nano timestamps stay as strings so Postgres' BIGINT type
 * can ingest them directly.
 */
export function flattenResourceSpans(payload) {
  const rows = []
  const resourceSpans = payload?.resourceSpans || []
  for (const rs of resourceSpans) {
    const resourceAttrs = kvListToObject(rs.resource?.attributes)
    const serviceName      = resourceAttrs['service.name'] || null
    const serviceNamespace = resourceAttrs['service.namespace'] || null
    const deploymentEnv    = resourceAttrs['deployment.environment'] || null

    const scopes = rs.scopeSpans || rs.instrumentationLibrarySpans || []
    for (const scope of scopes) {
      for (const s of (scope.spans || [])) {
        rows.push({
          trace_id:               hexToBuffer(s.traceId),
          span_id:                hexToBuffer(s.spanId),
          parent_span_id:         s.parentSpanId ? hexToBuffer(s.parentSpanId) : null,
          service_name:           serviceName,
          service_namespace:      serviceNamespace,
          deployment_environment: deploymentEnv,
          span_name:              s.name || null,
          span_kind:              typeof s.kind === 'number' ? s.kind : null,
          start_time_ns:          s.startTimeUnixNano != null ? String(s.startTimeUnixNano) : '0',
          end_time_ns:            s.endTimeUnixNano   != null ? String(s.endTimeUnixNano)   : '0',
          status_code:            s.status?.code ?? null,
          attributes:             kvListToObject(s.attributes),
          resource_attributes:    resourceAttrs,
        })
      }
    }
  }
  return rows
}

export const INSERT_COLS = [
  'tenant_id', 'trace_id', 'span_id', 'parent_span_id',
  'service_name', 'service_namespace', 'deployment_environment',
  'span_name', 'span_kind', 'start_time_ns', 'end_time_ns',
  'status_code', 'attributes', 'resource_attributes',
]
