-- ── Cloud Accounts — replaces Neo4j CloudAccount nodes ───────────────────────
-- Supports multiple accounts per provider (multiple AWS accounts, Azure
-- subscriptions, GCP projects). Config is encrypted at the application layer
-- using AES-256-GCM before storage (see utils/encrypt.js).
--
-- ── Multi-tenancy note ───────────────────────────────────────────────────────
-- This table is also defined in api/src/migrations/tenant-schema/001-base-tables.sql,
-- which the runner applies to every newly-provisioned tenant schema. For the
-- legacy single-tenant default tenant, postgres-init/15-default-tenant-cutover.sql
-- moves the table from `public` into `tenant_default` at init time
-- (`ALTER TABLE … SET SCHEMA`). After the cutover, rows in
-- `tenant_default.cloud_accounts` are accessed via the per-request
-- `req.pg.forTenant('tenant_default')` path. Keep this CREATE TABLE in
-- sync with the template until Phase 1c retires the public-side create.

CREATE TABLE IF NOT EXISTS cloud_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT NOT NULL,              -- 'aws' | 'azure' | 'gcp'
  name        TEXT NOT NULL,             -- human-readable label
  config      JSONB NOT NULL DEFAULT '{}', -- encrypted secret fields
  enabled     BOOLEAN NOT NULL DEFAULT true,
  last_scan_at       TIMESTAMPTZ,
  last_scan_status   TEXT,               -- 'success' | 'error' | 'partial'
  last_scan_total    INTEGER DEFAULT 0,
  last_scan_error    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, name)                -- no duplicate names per provider
);

CREATE INDEX IF NOT EXISTS idx_cloud_accounts_provider ON cloud_accounts(provider);
CREATE INDEX IF NOT EXISTS idx_cloud_accounts_enabled  ON cloud_accounts(enabled);

CREATE TRIGGER cloud_accounts_updated_at
  BEFORE UPDATE ON cloud_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();