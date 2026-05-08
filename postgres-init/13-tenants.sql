-- ── Multi-tenant control plane (Phase 0) ─────────────────────────────────────
-- Establishes the `control` schema and the `tenants` table that the auth /
-- tenant resolver reads on every request. Adds `tenant_id` to `api_keys`
-- and binds every existing key (including the env-var bootstrap rows) to a
-- seeded `default` tenant so single-tenant deployments keep working.
--
-- Phase 0 deliberately leaves the *data* tables (cloud_accounts, integrations,
-- audit_log, sync_jobs, …) in the `public` schema. Phase 1 introduces per-
-- tenant schemas (`tenant_<id>`) and moves those tables in via
-- `ALTER TABLE … SET SCHEMA`.
--
-- All statements are idempotent so this file can run on a fresh DB (init-time)
-- and an upgraded DB (operator re-applies it after pulling the migration).
--
-- See docs/multi-tenant-design.md for the full design.

-- ── 1. control schema ────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS control;

-- ── 2. control.tenants ───────────────────────────────────────────────────────
-- A tenant owns a slug (URL-safe identifier), a Neo4j database name (used in
-- Phase 2 to pin Cypher sessions), and a status. The Postgres schema name is
-- derived from the id at tenant creation time and stored here so it's stable
-- if we ever need to rename a slug (slugs are immutable post-creation today,
-- but that's an application-level invariant).
CREATE TABLE IF NOT EXISTS control.tenants (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- URL-safe identifier, kebab-case. Immutable post-creation. The
  -- application enforces ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ and rejects
  -- a small reserved set ('default', 'admin', 'system', 'api', '_*').
  slug            TEXT         NOT NULL UNIQUE,
  display_name    TEXT         NOT NULL,
  status          TEXT         NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'pending_delete')),
  -- Postgres schema holding this tenant's data tables. Created at tenant-
  -- onboarding time in Phase 1; for the seeded `default` tenant this is
  -- 'public' so existing data continues to resolve via the unchanged
  -- search_path until Phase 1 lands.
  schema_name     TEXT         NOT NULL UNIQUE,
  -- Neo4j database name. Phase 0 just stores it; Phase 2 wires the per-
  -- request session selector and the bootstrap CREATE DATABASE.
  -- Format: 'tenant_' + 32-hex (UUID without dashes) for new tenants;
  -- the seeded default tenant uses 'tenant_default' for operability.
  neo4j_database  TEXT         NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by      TEXT,                           -- principal name of admin who created
  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb
);

-- Lookup index for non-active tenants (suspended, pending_delete) — the
-- per-request resolver hits this when status changes mid-flight.
CREATE INDEX IF NOT EXISTS idx_tenants_status
  ON control.tenants (status) WHERE status != 'active';

-- ── 3. seed default tenant ───────────────────────────────────────────────────
-- ON CONFLICT on slug is a no-op so re-running this file (or running it
-- against a DB that already has the default tenant) is safe.
INSERT INTO control.tenants (slug, display_name, status, schema_name, neo4j_database, created_by, metadata)
VALUES (
  'default',
  'Default tenant',
  'active',
  'public',          -- Phase 0: data tables still live in public; Phase 1 moves them to tenant_<id>
  'tenant_default',  -- Phase 2 will CREATE DATABASE tenant_default and migrate the system DB into it
  'bootstrap',
  jsonb_build_object('seeded_at', now(), 'phase', 0)
)
ON CONFLICT (slug) DO NOTHING;

-- ── 4. api_keys.tenant_id ────────────────────────────────────────────────────
-- Every API key binds to exactly one tenant. Existing keys (and the env-var
-- bootstrap rows) backfill to the default tenant so existing deployments
-- continue to authenticate without external configuration.
--
-- Sequence: ADD COLUMN nullable → backfill → SET NOT NULL → add FK. Done as
-- separate idempotent steps so a partial run (e.g. the operator interrupted
-- on first attempt) can resume cleanly.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE api_keys
   SET tenant_id = (SELECT id FROM control.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

-- DO block lets us keep this idempotent — `ALTER COLUMN … SET NOT NULL`
-- isn't itself idempotent (re-running on an already-NOT NULL column is a
-- no-op in practice but the ADD CONSTRAINT for the FK errors on duplicate
-- constraint name).
DO $$
BEGIN
  -- Tighten to NOT NULL once the backfill has populated every row.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'api_keys'
       AND column_name  = 'tenant_id'
       AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE api_keys ALTER COLUMN tenant_id SET NOT NULL;
  END IF;

  -- Add the FK if it isn't already there. ON DELETE RESTRICT — deleting a
  -- tenant must explicitly revoke its keys first (the /admin/tenants
  -- DELETE handler does this in a single transaction).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_tenant_fk'
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES control.tenants(id)
        ON DELETE RESTRICT;
  END IF;
END $$;

-- Listing keys per tenant is an admin-route hot path under multi-tenant.
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
  ON api_keys (tenant_id);
