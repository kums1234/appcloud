-- ── Per-tenant sync_jobs (Phase 1c) ──────────────────────────────────────────
-- Adds the connector sync-history table to the per-tenant schema. The
-- FK to integrations(id) resolves intra-schema because both tables live
-- under the tenant's `tenant_<id>` namespace at apply time
-- (search_path = tenant_<id>, public is set by the runner before
-- this file executes).
--
-- 001-base-tables.sql defines `integrations`; this file adds the
-- dependent table separately so the lexical apply order forces
-- integrations to land first. New tenants get both via the runner;
-- the legacy default tenant gets them via
-- postgres-init/16-integrations-cutover.sql, which moves the existing
-- public.integrations + public.sync_jobs into tenant_default and
-- records this file with the 'cutover' sentinel sha.
--
-- Keep in sync with postgres-init/01-schema.sql until Phase 1d retires
-- the public-side create.

CREATE TABLE IF NOT EXISTS sync_jobs (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id     UUID         REFERENCES integrations(id) ON DELETE CASCADE,
  integration_type   TEXT         NOT NULL,
  status             TEXT         NOT NULL,
  triggered_by       TEXT,
  started_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  duration_ms        INTEGER,
  resources_found    INTEGER      DEFAULT 0,
  resources_created  INTEGER      DEFAULT 0,
  resources_updated  INTEGER      DEFAULT 0,
  resources_deleted  INTEGER      DEFAULT 0,
  error_message      TEXT,
  summary            JSONB
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_integration ON sync_jobs (integration_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_started     ON sync_jobs (started_at DESC);
