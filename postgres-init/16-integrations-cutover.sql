-- ── Integrations + sync_jobs cutover (Phase 1c) ──────────────────────────────
-- Continues postgres-init/15-default-tenant-cutover.sql by moving the next
-- pair of tenant-scoped tables — `integrations` and `sync_jobs` — out of
-- `public` and into `tenant_default`. The FK
-- `sync_jobs.integration_id → integrations(id)` is preserved by Postgres
-- across the move (FKs are tracked by OID, not by schema-qualified name).
--
-- After this cutover:
--   - tenant_default.integrations + tenant_default.sync_jobs hold the
--     existing single-tenant deployment's data
--   - new tenants get their own copies via the per-tenant runner
--     applying 001-base-tables.sql + 002-sync-jobs.sql to tenant_<id>
--   - postgres-init/01-schema.sql still creates these tables in `public`
--     on a fresh DB; the cutover moves them out at init time. Phase 1d
--     retires the public-side creates.
--
-- Idempotent: the DO blocks gate on "exists in public AND not exists in
-- target", so re-running is safe.

CREATE SCHEMA IF NOT EXISTS tenant_default;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'integrations'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'tenant_default' AND table_name = 'integrations'
  ) THEN
    ALTER TABLE public.integrations SET SCHEMA tenant_default;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'sync_jobs'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'tenant_default' AND table_name = 'sync_jobs'
  ) THEN
    ALTER TABLE public.sync_jobs SET SCHEMA tenant_default;
  END IF;
END $$;

-- Record the cutover for the runner. 'cutover' is treated as
-- already-applied / never-recompare; future template files (003-…)
-- still apply normally because the runner only special-cases the
-- cutover sentinel for this specific (schema, filename) row.
INSERT INTO control.schema_migrations (schema_name, filename, sha256)
VALUES ('tenant_default', '002-sync-jobs.sql', 'cutover')
ON CONFLICT (schema_name, filename) DO NOTHING;
