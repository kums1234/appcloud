-- ── Per-tenant base tables (Phase 1a) ────────────────────────────────────────
-- Applied by api/src/utils/tenant-schema-runner.js inside a transaction
-- with `SET LOCAL search_path = <tenant_schema>, public` so unqualified
-- CREATE TABLE statements land in the tenant's schema.
--
-- Phase 1a deliberately ships a *minimal* subset — `cloud_accounts` plus
-- `integrations` — to prove the runner pipeline. Phase 1b will expand
-- this template to cover the full per-tenant table set listed in
-- docs/multi-tenant-design.md §6 (sync_jobs, audit_log, terraform_imports,
-- cmdb_assessment_*, discovery_schedule, ai_jobs, otel_*).
--
-- Design discipline: every CREATE TABLE here uses IF NOT EXISTS so the
-- runner stays idempotent if its sha256-pinning is bypassed (e.g. the
-- operator manually CREATE'd the schema). The same DDL also lives in
-- postgres-init/01-schema.sql + postgres-init/04-cloud-accounts.sql for
-- the legacy single-tenant default-tenant deployment that hasn't yet
-- moved to the per-tenant schema model — keep the two in sync until
-- Phase 1b retires the postgres-init copies.

-- pgcrypto is at the cluster level; assumed to exist (postgres-init/01-schema.sql
-- creates it). No CREATE EXTENSION here — extensions can't live in a
-- per-tenant schema, only in `public` (or a designated extension schema).

CREATE TABLE IF NOT EXISTS integrations (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  type              TEXT         NOT NULL,
  name              TEXT         NOT NULL,
  enabled           BOOLEAN      NOT NULL DEFAULT false,
  config            JSONB        NOT NULL DEFAULT '{}',
  last_sync_at      TIMESTAMPTZ,
  last_sync_status  TEXT,
  last_sync_error   TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_accounts (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          TEXT         NOT NULL,
  name              TEXT         NOT NULL,
  config            JSONB        NOT NULL DEFAULT '{}',
  enabled           BOOLEAN      NOT NULL DEFAULT true,
  last_scan_at      TIMESTAMPTZ,
  last_scan_status  TEXT,
  last_scan_total   INTEGER      DEFAULT 0,
  last_scan_error   TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (provider, name)
);

CREATE INDEX IF NOT EXISTS idx_cloud_accounts_provider ON cloud_accounts (provider);
CREATE INDEX IF NOT EXISTS idx_cloud_accounts_enabled  ON cloud_accounts (enabled);
