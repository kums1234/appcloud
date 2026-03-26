-- ── Discovery Schedule ────────────────────────────────────────────────────────
-- Stores the auto-scan schedule configuration.
-- One row per scope: 'global' applies to all accounts.
-- Per-account overrides use the cloud_accounts.id as the scope.

CREATE TABLE IF NOT EXISTS discovery_schedule (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL DEFAULT 'global',  -- 'global' or a cloud_accounts.id
  enabled       BOOLEAN NOT NULL DEFAULT true,
  interval_mins INTEGER NOT NULL DEFAULT 15,      -- minimum 5, maximum 1440 (24h)
  last_run_at   TIMESTAMPTZ,
  last_run_status TEXT,                           -- 'success' | 'error' | 'running'
  last_run_total  INTEGER DEFAULT 0,
  next_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope)
);

-- Insert default global schedule (15 minutes, disabled until user enables it)
INSERT INTO discovery_schedule (scope, enabled, interval_mins)
VALUES ('global', false, 15)
ON CONFLICT (scope) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_discovery_schedule_scope ON discovery_schedule(scope);

CREATE TRIGGER discovery_schedule_updated_at
  BEFORE UPDATE ON discovery_schedule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Auto-create columns (added after initial release) ────────────────────────
ALTER TABLE discovery_schedule
  ADD COLUMN IF NOT EXISTS auto_create          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_create_min_score INTEGER NOT NULL DEFAULT 70;

-- Update comment
COMMENT ON COLUMN discovery_schedule.auto_create IS
  'When true, automatically run suggest+apply-all after each scheduled scan';
COMMENT ON COLUMN discovery_schedule.auto_create_min_score IS
  'Minimum confidence score (0-100) for auto-create actions. Default 70 (high confidence only)';