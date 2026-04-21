-- ── Integrations evolution ──────────────────────────────────────────────────
-- The base `integrations` table already exists (see 01-schema.sql). This
-- migration adds fields required by the connector framework introduced in
-- Phase 0:
--   · UNIQUE(type, name)       so ON CONFLICT upserts work
--   · poll_interval_seconds    null => push-style (no schedule); integer =>
--                              periodic fetch every N seconds
--   · supporting indexes for the scheduler's hot path
--
-- Note: postgres-init scripts only run on a *fresh* data volume. The
-- connector framework plugin also applies these DDLs at runtime (onReady)
-- via CREATE/ALTER ... IF NOT EXISTS so existing installs pick them up
-- without requiring a volume wipe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integrations_type_name_key'
  ) THEN
    ALTER TABLE integrations
      ADD CONSTRAINT integrations_type_name_key UNIQUE (type, name);
  END IF;
END$$;

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS poll_interval_seconds INTEGER;

CREATE INDEX IF NOT EXISTS idx_integrations_enabled_type
  ON integrations(enabled, type);

CREATE INDEX IF NOT EXISTS idx_integrations_next_run
  ON integrations(enabled, last_sync_at)
  WHERE poll_interval_seconds IS NOT NULL;
