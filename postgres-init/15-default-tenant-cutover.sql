-- ── Default-tenant cutover (Phase 1b) ────────────────────────────────────────
-- Moves the per-tenant data tables from `public` into `tenant_default`,
-- updates the default tenant row's `schema_name` to match, and records
-- the move in `control.schema_migrations` so the runner doesn't try to
-- re-create those tables on next boot.
--
-- Idempotent: each step checks whether it has already happened so the
-- file is safe to run on a fresh DB (where the cutover happens at init
-- time), on an existing pre-cutover DB (run by the operator after
-- pulling the migration), and on a post-cutover DB (no-op).
--
-- Phase 1b deliberately moves only `cloud_accounts`. Moving
-- `integrations` would also require moving `sync_jobs` (FK target) plus
-- refactoring integrations.management.js — that's a larger change held
-- over to Phase 1c. The template already provisions `integrations` for
-- *new* tenants; the default tenant's `integrations` rows stay in
-- `public` and resolve via the `search_path = tenant_default, public`
-- fallback until 1c moves them.

-- ── 1. Ensure target schema exists ───────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS tenant_default;

-- ── 2. Move tables ───────────────────────────────────────────────────────────
-- ALTER TABLE … SET SCHEMA is a metadata-only change in Postgres — no
-- row rewriting, sub-second on tables of any size. The DO blocks gate
-- on "exists in public AND not exists in target" so re-running is safe.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'cloud_accounts'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'tenant_default' AND table_name = 'cloud_accounts'
  ) THEN
    ALTER TABLE public.cloud_accounts SET SCHEMA tenant_default;
  END IF;
END $$;

-- ── 3. Update the default tenant row ────────────────────────────────────────
-- After the move, the default tenant resolves through the per-request
-- search_path mechanism (req.pg.forTenant('tenant_default')) just like
-- any other tenant. The 503 guard in tenant-context now fires only for
-- schemas other than tenant_default until Phase 1c expands the template
-- and lifts the guard altogether.
UPDATE control.tenants
   SET schema_name = 'tenant_default'
 WHERE slug = 'default'
   AND schema_name = 'public';

-- ── 4. Record the cutover in schema_migrations ──────────────────────────────
-- The per-tenant runner uses control.schema_migrations to decide which
-- files to apply. Since the tables are now in tenant_default *without*
-- having gone through 001-base-tables.sql (they're moved in place, not
-- created from the template), record the equivalent entries so the
-- runner knows the schema is at-or-after that migration.
--
-- The sha256 placeholder ('cutover') makes the row obviously
-- distinguishable from a normal apply — a future re-application of
-- 001-base-tables.sql with its real sha would mismatch and throw,
-- which is desired: a cutover schema must never have the template
-- re-applied on top.
INSERT INTO control.schema_migrations (schema_name, filename, sha256)
VALUES ('tenant_default', '001-base-tables.sql', 'cutover')
ON CONFLICT (schema_name, filename) DO NOTHING;
