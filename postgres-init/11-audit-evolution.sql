-- ── Audit log: key-tier attribution ──────────────────────────────────────────
-- Slice 5 of the multi-key RBAC work needs the audit_log to record WHICH
-- API key (and at WHAT scope) performed each mutation, not just the
-- self-reported X-Actor header that previous slices accepted.
--
-- Both columns are nullable so existing rows continue to read, and
-- routes that fire audit calls outside an HTTP request context (system
-- jobs, schedulers) can leave them NULL.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_key_id UUID
    REFERENCES api_keys(id) ON DELETE SET NULL;

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_scope TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_key
  ON audit_log(actor_key_id) WHERE actor_key_id IS NOT NULL;
