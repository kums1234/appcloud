-- ── Per-tenant terraform_imports (Phase 1d) ──────────────────────────────────
-- Terraform / OpenTofu state file import job history. New tenants get a
-- fresh table; the legacy default tenant has its existing rows moved
-- into tenant_default by postgres-init/18-tables-cutover.sql.
--
-- Keep in sync with postgres-init/01-schema.sql until Phase 1e retires
-- the public-side create.

CREATE TABLE IF NOT EXISTS terraform_imports (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  filename            TEXT         NOT NULL,
  file_size_bytes     INTEGER,
  status              TEXT         NOT NULL DEFAULT 'pending',
  terraform_version   TEXT,
  workspace           TEXT,
  resources_found     INTEGER      DEFAULT 0,
  resources_imported  INTEGER      DEFAULT 0,
  resources_skipped   INTEGER      DEFAULT 0,
  error_message       TEXT,
  raw_summary         JSONB,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_terraform_imports_created_at
  ON terraform_imports (created_at DESC);
