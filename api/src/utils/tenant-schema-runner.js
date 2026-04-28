// utils/tenant-schema-runner.js
//
// Per-schema migration runner for Postgres. Applied to a tenant's schema
// (`tenant_<id>`) at provisioning time and re-applied at startup so any
// new migration files added since last boot land before requests arrive.
//
// Migration files live in api/src/migrations/tenant-schema/, named with
// a numeric prefix that defines apply order (001-, 002-, …). Within a
// single applyMigrations call, every file runs on the **caller's**
// client. The caller decides transactional shape:
//
//   - POST /admin/tenants wraps row-insert + provision in one BEGIN/COMMIT
//     so a migration failure rolls back the tenant row too. Atomic.
//   - A startup re-migration sweep would iterate per-tenant, BEGIN/COMMIT
//     per tenant, so a single tenant's migration failure doesn't block
//     other tenants.
//
// ── Drift detection ──────────────────────────────────────────────────────────
// Before applying, we check `control.schema_migrations` for an existing
// row by (schema_name, filename):
//
//   - row missing               → apply the migration
//   - row present, sha matches  → skip silently
//   - row present, sha differs  → THROW (operator edited a committed file)
//
// The throw is deliberate — silently re-applying mutated DDL would lead
// to schemas drifting between deployments. If a migration is genuinely
// wrong, write a NEW file that fixes it; never edit an applied one.

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Ensures `control.schema_migrations` exists. Idempotent — safe to call
// on every server boot. Mirrors postgres-init/14-tenant-schema-migrations.sql
// for deployments that haven't applied the init scripts yet.
//
// Takes a `pg` (wrapped, .query returns rows) for one-off invocation
// from a plugin's startup sequence.
export async function ensureSchemaMigrationsTable(pg) {
  await pg.query(`
    CREATE SCHEMA IF NOT EXISTS control;
    CREATE TABLE IF NOT EXISTS control.schema_migrations (
      schema_name  TEXT         NOT NULL,
      filename     TEXT         NOT NULL,
      sha256       TEXT         NOT NULL,
      applied_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (schema_name, filename)
    );
    CREATE INDEX IF NOT EXISTS idx_schema_migrations_schema
      ON control.schema_migrations (schema_name);
  `)
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// Sentinel sha256 written by postgres-init/15-default-tenant-cutover.sql
// to record that a migration's tables landed in a tenant schema by way of
// `ALTER TABLE … SET SCHEMA` rather than by running the migration file
// itself. The runner treats it as "already applied, never recompare" —
// re-applying the file's DDL on top of moved tables would either no-op
// (CREATE TABLE IF NOT EXISTS) or worse, fail because the indexes /
// constraints already exist with the same names.
const CUTOVER_SHA = 'cutover'

// Returns the list of `.sql` files in `dir`, sorted lexically — i.e. the
// numeric prefix dictates apply order. Hidden files and non-`.sql` files
// are filtered out.
export async function listMigrationFiles(dir) {
  let entries
  try { entries = await fs.readdir(dir) }
  catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort()
}

// Schema names go straight into a dynamic-SQL string (you cannot
// parameterize a search_path target). Reject anything outside the
// conservative tenant-schema shape so a caller can't smuggle SQL.
function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]{1,62}$/.test(name)) {
    throw new Error(`tenant-schema-runner: refusing unsafe schema name '${name}'`)
  }
  return `"${name}"`
}

// Applies every unapplied migration in `migrationsDir` to `schemaName`
// using `client` (a checked-out pg client). Returns the list of
// filenames actually applied.
//
// Already-applied migrations are silently skipped; sha mismatches throw.
//
// Caller owns the transaction. We do NOT issue BEGIN/COMMIT here. To
// run inside an outer transaction (POST /admin/tenants), pass the same
// client that issued BEGIN.
export async function applyMigrations({ client, schemaName, migrationsDir, log = null }) {
  const schemaIdent = quoteIdent(schemaName)
  const files = await listMigrationFiles(migrationsDir)
  const applied = []

  // Set search_path once for the whole batch. SET LOCAL is transaction-
  // scoped, so it reverts on COMMIT/ROLLBACK without further cleanup.
  // Deliberately includes `public` so references to extensions
  // (pgcrypto, etc.) keep resolving.
  await client.query(`SET LOCAL search_path = ${schemaIdent}, public`)

  for (const filename of files) {
    const filePath = path.join(migrationsDir, filename)
    const buf = await fs.readFile(filePath, 'utf8')
    const sha = sha256Hex(buf)

    const existing = await client.query(
      `SELECT sha256 FROM control.schema_migrations
        WHERE schema_name = $1 AND filename = $2`,
      [schemaName, filename],
    )
    if (existing.rows.length > 0) {
      const recordedSha = existing.rows[0].sha256
      if (recordedSha === sha || recordedSha === CUTOVER_SHA) {
        log?.debug?.({ schemaName, filename, recordedSha }, '[tenant-schema-runner] migration already applied, skipping')
        continue
      }
      throw new Error(
        `tenant-schema-runner: migration ${filename} was previously applied to ${schemaName} ` +
        `with a different sha256 — refusing to re-apply. The file appears to have been edited ` +
        `after commit. Write a new migration that fixes the issue rather than editing this one.`,
      )
    }

    try {
      await client.query(buf)
      await client.query(
        `INSERT INTO control.schema_migrations (schema_name, filename, sha256)
         VALUES ($1, $2, $3)`,
        [schemaName, filename, sha],
      )
      applied.push(filename)
      log?.info?.({ schemaName, filename }, '[tenant-schema-runner] applied migration')
    } catch (err) {
      // Re-throw with context so the caller's ROLLBACK fires with a
      // clear cause. Caller is responsible for the rollback itself.
      throw new Error(
        `tenant-schema-runner: failed applying ${filename} to ${schemaName}: ${err.message}`,
        { cause: err },
      )
    }
  }

  return applied
}

// Provisions a fresh tenant schema: CREATE SCHEMA + applyMigrations.
// Used by POST /admin/tenants. Caller owns the transaction.
//
// If the schema already exists, applies the (possibly-incremental) set
// of migrations against it without dropping. This makes the call safe
// to retry after a partial failure without producing a different tenant
// shape than a fresh provision would.
export async function provisionTenantSchema({ client, schemaName, migrationsDir, log = null }) {
  const schemaIdent = quoteIdent(schemaName)
  const existing = await client.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
    [schemaName],
  )
  if (existing.rows.length > 0) {
    log?.warn?.({ schemaName }, '[tenant-schema-runner] schema already exists, applying migrations only')
  } else {
    await client.query(`CREATE SCHEMA ${schemaIdent}`)
    log?.info?.({ schemaName }, '[tenant-schema-runner] created schema')
  }
  return await applyMigrations({ client, schemaName, migrationsDir, log })
}
