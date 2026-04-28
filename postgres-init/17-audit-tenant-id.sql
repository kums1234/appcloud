-- ── audit_log tenant_id (Phase 1d) ───────────────────────────────────────────
-- Adds the tenant binding to the partitioned audit_log table. The column
-- propagates to every existing partition automatically (Postgres
-- ALTER TABLE on the parent partitioned table fans out to children).
--
-- Design choice: audit_log stays in `public` rather than moving to
-- `control` or per-tenant. Reasons:
--
--   1. The partition layout (monthly partitions) makes a SET SCHEMA
--      move significantly harder than for the unpartitioned tables.
--   2. Cross-tenant audit reads — super-admin investigation,
--      compliance exports — want a single table to filter, not a
--      fan-out across N per-tenant tables.
--   3. The default search_path = public on the application pool means
--      audit-cleanup and other utilities that do NOT have a tenant
--      context still find audit_log.
--
-- Tenant-scoped reads explicitly add `WHERE tenant_id = $X`. The audit()
-- write path always supplies tenant_id (req.audit closes over it; the
-- audit-buffer machinery rejects rows with NULL tenant_id post-cutover).
--
-- All steps idempotent so the file can run on a fresh DB and on an
-- upgraded one with rows already present.

DO $$
BEGIN
  -- Add the column if it isn't already there.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'audit_log'
       AND column_name  = 'tenant_id'
  ) THEN
    ALTER TABLE audit_log ADD COLUMN tenant_id UUID;
  END IF;

  -- Backfill any nulls to the default tenant. Operators upgrading an
  -- existing single-tenant deployment have all their rows attributed
  -- to the default tenant — no rows lost, no rows mis-attributed.
  UPDATE audit_log
     SET tenant_id = (SELECT id FROM control.tenants WHERE slug = 'default')
   WHERE tenant_id IS NULL;

  -- Tighten + add FK if not already done. ON DELETE RESTRICT keeps
  -- audit history immune to tenant deletion (if a tenant gets
  -- pending_delete'd, audit rows must outlive the row's hard-delete).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'audit_log'
       AND column_name  = 'tenant_id'
       AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE audit_log ALTER COLUMN tenant_id SET NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_tenant_fk'
  ) THEN
    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES control.tenants(id)
        ON DELETE RESTRICT;
  END IF;
END $$;

-- Tenant filter is the dominant access pattern for tenant-scoped reads
-- (per-tenant audit views in admin UI, compliance exports). Combined
-- with the existing created_at index on audit_log, this lets the planner
-- use a tenant_id + created_at composite when both are filtered.
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created_at
  ON audit_log (tenant_id, created_at DESC);
