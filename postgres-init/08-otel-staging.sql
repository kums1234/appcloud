-- ── OpenTelemetry ingest staging ────────────────────────────────────────────
-- Consumed by the `otel-ingest` connector (push-style). Each configured
-- integration of type='otel-ingest' owns one row in otel_tenants, whose
-- bearer token authenticates incoming OTLP/HTTP traffic.
--
-- otel_spans_raw is a short-lived staging area: the aggregation worker
-- (Phase 1d) reads sliding windows of rows and derives :Component /
-- :CONNECTED_TO / :DEPLOYED_ON edges in Neo4j. A periodic purge keeps
-- storage bounded.
--
-- postgres-init scripts only run on a fresh data volume; the otel-ingest
-- connector applies the same DDL at boot with IF NOT EXISTS guards so
-- existing installs pick it up without a volume wipe.

CREATE TABLE IF NOT EXISTS otel_tenants (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  UUID        NOT NULL UNIQUE REFERENCES integrations(id) ON DELETE CASCADE,
  token_hash      TEXT        NOT NULL UNIQUE,       -- SHA-256 hex of the bearer token
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otel_tenants_token_hash
  ON otel_tenants(token_hash);

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

CREATE INDEX IF NOT EXISTS idx_otel_spans_received
  ON otel_spans_raw(received_at, tenant_id);

CREATE INDEX IF NOT EXISTS idx_otel_spans_trace
  ON otel_spans_raw(tenant_id, trace_id);

CREATE INDEX IF NOT EXISTS idx_otel_spans_service
  ON otel_spans_raw(tenant_id, service_name, received_at);
