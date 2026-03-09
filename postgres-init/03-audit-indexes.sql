-- Migration 03 — additional audit_log indexes for query API performance
-- Safe to run multiple times (IF NOT EXISTS)

-- Actor lookup — powers GET /audit/actor/:name
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log(actor);

-- Action filter
CREATE INDEX IF NOT EXISTS idx_audit_log_action
  ON audit_log(action);

-- Combined resource lookup — powers GET /audit/resource/:type/:id
-- (resource_type + resource_id already covered by idx_audit_log_resource)

-- diff column — store before/after for updates (already a JSONB column in schema,
-- but the audit helper currently only writes to metadata).
-- Add a functional update: backfill diff from metadata where action = 'update'
-- for future writes the routes now use the diff param explicitly.

-- Ensure the diff column exists (it's in schema v1 but may be missing on older volumes)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_log' AND column_name = 'diff'
  ) THEN
    ALTER TABLE audit_log ADD COLUMN diff JSONB;
  END IF;
END $$;