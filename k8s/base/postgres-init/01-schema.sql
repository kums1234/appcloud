-- AppCloud PostgreSQL schema
-- Handles everything that doesn't belong in the graph:
-- users/auth, audit logs, integration config, sync history, reporting events

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Integration configurations ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,           -- 'terraform','aws','azure','gcp','kubernetes','servicenow','teams','slack'
  name          TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  config        JSONB NOT NULL DEFAULT '{}',  -- encrypted at app level before storing
  last_sync_at  TIMESTAMPTZ,
  last_sync_status TEXT,                 -- 'success','error','running'
  last_sync_error  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sync job history ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  UUID REFERENCES integrations(id) ON DELETE CASCADE,
  integration_type TEXT NOT NULL,
  status          TEXT NOT NULL,         -- 'running','success','error','partial'
  triggered_by    TEXT,                  -- 'scheduled','manual','webhook'
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  resources_found   INTEGER DEFAULT 0,
  resources_created INTEGER DEFAULT 0,
  resources_updated INTEGER DEFAULT 0,
  resources_deleted INTEGER DEFAULT 0,
  error_message   TEXT,
  summary         JSONB                  -- detailed breakdown by resource type
);

-- ── Audit log — every write action in the system ─────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       TEXT,                      -- user name or 'system'/'integration'
  action      TEXT NOT NULL,             -- 'create','update','delete','approve','reject','sync'
  resource_type TEXT NOT NULL,           -- 'Application','Component','Infra','Change','Integration'
  resource_id   TEXT NOT NULL,
  resource_name TEXT,
  diff          JSONB,                   -- before/after for updates
  metadata      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Terraform import jobs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS terraform_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        TEXT NOT NULL,
  file_size_bytes INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending','parsing','importing','done','error'
  terraform_version TEXT,
  workspace       TEXT,
  resources_found   INTEGER DEFAULT 0,
  resources_imported INTEGER DEFAULT 0,
  resources_skipped  INTEGER DEFAULT 0,
  error_message   TEXT,
  raw_summary     JSONB,                 -- full parse result for debugging
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_log_resource   ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created    ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_integration ON sync_jobs(integration_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_started    ON sync_jobs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tf_imports_status    ON terraform_imports(status);
CREATE INDEX IF NOT EXISTS idx_tf_imports_created   ON terraform_imports(created_at DESC);

-- ── Updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Users — credentials and profile (moved from Neo4j) ───────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user' | 'viewer'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
