-- ── Per-tenant schema migration tracking (Phase 1a) ──────────────────────────
-- Records which migrations have been applied to which tenant schemas. The
-- runner (api/src/utils/tenant-schema-runner.js) reads this table on every
-- apply pass: a row with a matching SHA-256 means skip; a row with a
-- different SHA-256 means refuse (someone edited a committed migration).
--
-- Idempotent so the file can run on init and the runner can re-CREATE on
-- first invocation against a deployment that hasn't run init scripts.

CREATE TABLE IF NOT EXISTS control.schema_migrations (
  -- Postgres schema the migration was applied to. Either 'tenant_<uuid-without-dashes>'
  -- (post-Phase-1b) or whatever shape Phase 1a tenants use.
  schema_name  TEXT         NOT NULL,
  -- Migration file name as it appears in api/src/migrations/tenant-schema/
  -- (e.g. '001-base-tables.sql'). Lexical ordering of these names is the
  -- apply order.
  filename     TEXT         NOT NULL,
  -- SHA-256 hex of the file content at apply time. The runner refuses
  -- to re-apply a migration whose hash has changed since application —
  -- catches the case where someone edits a committed migration in place.
  sha256       TEXT         NOT NULL,
  applied_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_name, filename)
);

-- Lookup index for the runner's "what's the latest filename applied for
-- this schema?" query path.
CREATE INDEX IF NOT EXISTS idx_schema_migrations_schema
  ON control.schema_migrations (schema_name);
