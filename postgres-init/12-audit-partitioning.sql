-- ── audit_log: convert to RANGE partitioning on created_at ──────────────────
-- The application-side migration in api/src/utils/audit-partitioning.js does
-- the same thing idempotently at startup, so this file is the canonical
-- shape for fresh deployments — and a no-op on any DB where the API has
-- already converted the table.
--
-- Why partition: at scale, "delete rows older than N days" becomes a
-- row-by-row DELETE on a hot table. With monthly partitions, retention
-- becomes `DROP TABLE audit_log_YYYY_MM` — ~constant time, no row scan,
-- no autovacuum churn.
--
-- The partition key (created_at) MUST be part of every UNIQUE / PK
-- constraint, so the PK becomes (id, created_at). Lookups by id alone
-- still work via the index — they just don't get partition pruning,
-- which is fine since none of our query routes filter on id alone.

DO $$
DECLARE
  audit_log_kind char;
BEGIN
  SELECT relkind INTO audit_log_kind
  FROM pg_class
  WHERE relname = 'audit_log'
    AND relnamespace = current_schema()::regnamespace;

  IF NOT FOUND OR audit_log_kind IS NULL THEN
    -- Fresh DB — create as partitioned + a default partition. The
    -- application also creates the current and next month partitions
    -- on startup; we only seed the default here so first INSERTs find
    -- a home before the application boots.
    EXECUTE 'CREATE TABLE audit_log (
      id            UUID         NOT NULL DEFAULT gen_random_uuid(),
      actor         TEXT,
      actor_key_id  UUID         REFERENCES api_keys(id) ON DELETE SET NULL,
      actor_scope   TEXT,
      action        TEXT         NOT NULL,
      resource_type TEXT         NOT NULL,
      resource_id   TEXT         NOT NULL,
      resource_name TEXT,
      diff          JSONB,
      metadata      JSONB,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)';
    EXECUTE 'CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT';
    EXECUTE 'CREATE INDEX idx_audit_log_resource   ON audit_log(resource_type, resource_id)';
    EXECUTE 'CREATE INDEX idx_audit_log_created    ON audit_log(created_at DESC)';
    EXECUTE 'CREATE INDEX idx_audit_log_actor_key  ON audit_log(actor_key_id) WHERE actor_key_id IS NOT NULL';

  ELSIF audit_log_kind = 'p' THEN
    -- Already partitioned — no-op.
    RAISE NOTICE 'audit_log is already partitioned';

  ELSIF audit_log_kind = 'r' THEN
    -- Regular table — migrate. Rename, recreate as partitioned, copy
    -- existing rows into the default partition, drop legacy.
    EXECUTE 'ALTER TABLE audit_log RENAME TO audit_log_legacy';
    EXECUTE 'CREATE TABLE audit_log (
      id            UUID         NOT NULL DEFAULT gen_random_uuid(),
      actor         TEXT,
      actor_key_id  UUID         REFERENCES api_keys(id) ON DELETE SET NULL,
      actor_scope   TEXT,
      action        TEXT         NOT NULL,
      resource_type TEXT         NOT NULL,
      resource_id   TEXT         NOT NULL,
      resource_name TEXT,
      diff          JSONB,
      metadata      JSONB,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)';
    EXECUTE 'CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT';
    EXECUTE 'INSERT INTO audit_log SELECT * FROM audit_log_legacy';
    EXECUTE 'DROP TABLE audit_log_legacy';
    EXECUTE 'CREATE INDEX idx_audit_log_resource   ON audit_log(resource_type, resource_id)';
    EXECUTE 'CREATE INDEX idx_audit_log_created    ON audit_log(created_at DESC)';
    EXECUTE 'CREATE INDEX idx_audit_log_actor_key  ON audit_log(actor_key_id) WHERE actor_key_id IS NOT NULL';
  END IF;
END$$;
