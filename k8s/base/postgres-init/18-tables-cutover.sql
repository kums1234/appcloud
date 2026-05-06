-- ── Phase 1d table cutover ───────────────────────────────────────────────────
-- Moves the next batch of tenant-scoped tables out of `public` and into
-- `tenant_default`:
--
--   - terraform_imports (no FKs)
--   - ai_jobs           (no FKs)
--   - discovery_schedule (no FKs; existing 'global' row carries forward)
--
-- These three are FK-free so they move independently. cmdb_assessment_*
-- and otel_* are deferred to Phase 1e — they have multi-table coupling
-- and partition layouts that need their own design pass. audit_log
-- deliberately stays in `public` (see postgres-init/17-audit-tenant-id.sql
-- for the rationale).
--
-- Idempotent: each step gates on "exists in public AND not in tenant_default".

CREATE SCHEMA IF NOT EXISTS tenant_default;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'terraform_imports'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'tenant_default' AND table_name = 'terraform_imports'
  ) THEN
    ALTER TABLE public.terraform_imports SET SCHEMA tenant_default;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'ai_jobs'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'tenant_default' AND table_name = 'ai_jobs'
  ) THEN
    ALTER TABLE public.ai_jobs SET SCHEMA tenant_default;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'discovery_schedule'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'tenant_default' AND table_name = 'discovery_schedule'
  ) THEN
    ALTER TABLE public.discovery_schedule SET SCHEMA tenant_default;
  END IF;
END $$;

-- Record the moves for the runner. The 'cutover' sentinel makes the
-- runner skip these template files for tenant_default — the tables
-- got there via SET SCHEMA, not by running the file's CREATE TABLE.
INSERT INTO control.schema_migrations (schema_name, filename, sha256)
VALUES
  ('tenant_default', '003-terraform-imports.sql', 'cutover'),
  ('tenant_default', '004-ai-jobs.sql',           'cutover'),
  ('tenant_default', '005-discovery-schedule.sql','cutover')
ON CONFLICT (schema_name, filename) DO NOTHING;
