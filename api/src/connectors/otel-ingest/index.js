// api/src/connectors/otel-ingest/index.js
//
// Push-style connector. Accepts OTLP/HTTP JSON at POST /ingest/otlp/v1/traces
// and stages spans in Postgres. The aggregation worker (Phase 1d) later
// derives :Component / :CONNECTED_TO / :DEPLOYED_ON edges in Neo4j.
//
// Config shape (all fields optional — beforeUpsert fills defaults):
//   {
//     otelTenantToken: 'otlp_…',       // auto-generated on first create
//     ingestPath:      '/ingest/otlp', // informational; the route path is fixed
//     generatedAt:     '2026-04-21T…', // bookkeeping
//   }
//
// The generated token is encrypted at rest (see utils/encrypt.js
// SECRET_FIELDS) and surfaced on the POST/PATCH response so the user can
// copy it into their OTel Collector configuration. sha256(token) is stored
// in otel_tenants for the auth lookup.

import { randomBytes, createHash } from 'crypto'
import { registerOtlpRoutes } from './routes.js'

// Applied at boot via receiver.register() so existing installs pick up the
// staging schema without a volume wipe. Fresh installs get it from
// postgres-init/08-otel-staging.sql.
const RUNTIME_DDL = `
  CREATE TABLE IF NOT EXISTS otel_tenants (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id  UUID        NOT NULL UNIQUE REFERENCES integrations(id) ON DELETE CASCADE,
    token_hash      TEXT        NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_otel_tenants_token_hash ON otel_tenants(token_hash);

  CREATE TABLE IF NOT EXISTS otel_spans_raw (
    id                     BIGSERIAL   PRIMARY KEY,
    tenant_id              UUID        NOT NULL REFERENCES otel_tenants(id) ON DELETE CASCADE,
    trace_id               BYTEA       NOT NULL,
    span_id                BYTEA       NOT NULL,
    parent_span_id         BYTEA,
    service_name           TEXT,
    service_namespace      TEXT,
    deployment_environment TEXT,
    span_name              TEXT,
    span_kind              SMALLINT,
    start_time_ns          BIGINT      NOT NULL,
    end_time_ns            BIGINT      NOT NULL,
    status_code            SMALLINT,
    attributes             JSONB,
    resource_attributes    JSONB,
    received_at            TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_otel_spans_received ON otel_spans_raw(received_at, tenant_id);
  CREATE INDEX IF NOT EXISTS idx_otel_spans_trace    ON otel_spans_raw(tenant_id, trace_id);
  CREATE INDEX IF NOT EXISTS idx_otel_spans_service  ON otel_spans_raw(tenant_id, service_name, received_at);
`

function sha256Hex(s) { return createHash('sha256').update(String(s)).digest('hex') }

function generateToken() {
  // "otlp_" prefix + 32 bytes of URL-safe base64 = 43 chars body (256 bits)
  return `otlp_${randomBytes(32).toString('base64url')}`
}

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

/**
 * Auto-generate the tenant token on first create. If a PATCH sends an empty
 * string explicitly we also regenerate — that's the token-rotation path.
 */
async function beforeUpsert(cfg) {
  const out = { ...(cfg || {}) }
  if (!out.otelTenantToken || out.otelTenantToken === '__rotate__') {
    out.otelTenantToken = generateToken()
    out.generatedAt     = new Date().toISOString()
  }
  if (!out.ingestPath) out.ingestPath = '/ingest/otlp'
  return out
}

/**
 * Keep otel_tenants.token_hash in lock-step with the integration's config.
 * Idempotent — called after every POST/PATCH.
 */
async function afterUpsert(row, ctx) {
  const token = row?.config?.otelTenantToken
  if (!token) return
  const hash = sha256Hex(token)
  await ctx.pg.query(
    `INSERT INTO otel_tenants (integration_id, token_hash)
     VALUES ($1, $2)
     ON CONFLICT (integration_id) DO UPDATE SET token_hash = EXCLUDED.token_hash`,
    [row.id, hash],
  )
  ctx.log?.info?.(`[otel-ingest] tenant token synced for integration ${row.id}`)
}

async function healthCheck(cfg, ctx) {
  if (!cfg?.otelTenantToken) return { ok: false, detail: 'no tenant token in config' }
  if (!ctx.pg?.pool)          return { ok: false, detail: 'database unavailable' }
  const rows = await ctx.pg.query(
    `SELECT id FROM otel_tenants WHERE token_hash = $1 LIMIT 1`,
    [sha256Hex(cfg.otelTenantToken)],
  )
  return rows.length
    ? { ok: true,  detail: 'tenant row present — POST to /ingest/otlp/v1/traces with this bearer token' }
    : { ok: false, detail: 'no tenant row — re-save the integration to regenerate' }
}

// ── Connector spec ──────────────────────────────────────────────────────────

const authSchema = {
  type: 'object',
  properties: {
    otelTenantToken: { type: 'string' },   // auto-generated on first create
    ingestPath:      { type: 'string' },
    generatedAt:     { type: 'string' },
  },
}

/** @type {import('../types.js').ConnectorSpec} */
const spec = {
  id:          'otel-ingest',
  category:    'telemetry-ingest',
  displayName: 'OpenTelemetry Collector (OTLP/HTTP)',
  description: 'Receives OTLP/HTTP JSON traces from a customer-run OpenTelemetry Collector. Tenant-scoped bearer-token auth, spans staged to Postgres, aggregation worker derives :Component / :CONNECTED_TO edges in Neo4j. Configure the Collector otlphttp exporter with `encoding: json` and this integration\'s token as Authorization: Bearer.',
  authSchema,
  beforeUpsert,
  afterUpsert,
  healthCheck,
  receiver: {
    register: async (fastify) => {
      if (fastify.pg?.pool) {
        try {
          await fastify.pg.query(RUNTIME_DDL)
          fastify.log.info('[otel-ingest] staging schema ready')
        } catch (err) {
          fastify.log.warn(`[otel-ingest] staging schema warning: ${err.message}`)
        }
      }
      registerOtlpRoutes(fastify)
      fastify.log.info('[otel-ingest] POST /ingest/otlp/v1/traces live')
    },
  },
}

export default spec
