// utils/audit-partitioning.js
//
// Convert audit_log from a regular table to a Postgres-native RANGE
// partitioned table on `created_at`, then keep month-sized partitions
// rolling forward.
//
// Why partition: at scale, "delete all rows older than N days" turns into
// a row-by-row DELETE that holds a long-running transaction over a hot,
// indexed table. With monthly partitions, retention is `DROP TABLE
// audit_log_YYYY_MM` — ~constant time, no row scan, no autovacuum churn.
// The plugins/audit-cleanup.js retention plugin auto-detects partitioning
// and switches to drop-mode when present; falls back to CTE DELETE when
// the table is still in its pre-partitioned shape.
//
// Safe migration:
//   regular   →  rename existing → create partitioned shell w/ default
//                partition → INSERT old rows into the default → drop legacy
//   partitioned → no-op
//   absent    →  create partitioned shell directly
//
// Partition key constraint: Postgres requires the PK include the
// partition column. So `id UUID PRIMARY KEY` becomes `(id, created_at)`.
// Lookups by id alone still work via the index — we just lose the
// partition-prune optimization for those (rare) queries; the audit
// query routes all filter on created_at OR resource_type+resource_id,
// both of which prune correctly.

const PARTITION_PREFIX = 'audit_log_'

const PARTITIONED_TABLE_SQL = `
  CREATE TABLE audit_log (
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
  ) PARTITION BY RANGE (created_at)
`

// Indexes to (re)create on the partitioned parent. Postgres propagates
// these to every partition automatically (one local index per partition).
const PARTITION_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_audit_log_resource   ON audit_log(resource_type, resource_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_created    ON audit_log(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_actor_key  ON audit_log(actor_key_id) WHERE actor_key_id IS NOT NULL`,
]

// Returns 'partitioned' | 'regular' | 'absent'. Source is pg_class.relkind:
// 'p' = partitioned table, 'r' = ordinary, undefined = doesn't exist.
export async function detectAuditLogState(query) {
  const rows = await query(`
    SELECT relkind::text AS kind
    FROM pg_class
    WHERE relname = 'audit_log'
      AND relnamespace = current_schema()::regnamespace
  `)
  if (rows.length === 0)        return 'absent'
  if (rows[0].kind === 'p')     return 'partitioned'
  if (rows[0].kind === 'r')     return 'regular'
  return 'unknown'                                     // foreign tables, views, etc.
}

// Idempotent migration. Safe to call on every startup.
//
// IMPORTANT — partition creation order: when migrating a regular table
// with existing rows, we MUST create the per-month partitions for
// "live" months (current + next) BEFORE the default partition. Postgres
// rejects creating a new monthly partition once the default has rows
// that would fall into that month's range — those rows can't be silently
// moved. Order: partitioned shell → current/next monthly → default →
// INSERT legacy rows → drop legacy.
export async function ensureAuditPartitioning(query, log) {
  const state = await detectAuditLogState(query)
  if (state === 'partitioned') {
    log?.info?.('[audit-partitioning] audit_log already partitioned')
    return { state, migrated: false }
  }
  if (state === 'absent') {
    await query(PARTITIONED_TABLE_SQL)
    await ensureCurrentAndNextPartitions(query, log)
    await query(`CREATE TABLE IF NOT EXISTS audit_log_default PARTITION OF audit_log DEFAULT`)
    for (const sql of PARTITION_INDEXES) await query(sql)
    log?.info?.('[audit-partitioning] audit_log created as partitioned')
    return { state: 'absent', migrated: true }
  }
  if (state === 'regular') {
    log?.info?.('[audit-partitioning] migrating audit_log to partitioned')
    // Rename + recreate + copy + drop. Done as separate statements rather
    // than one DO-block so each step's error surfaces with a precise
    // line number when something goes wrong on a real DB.
    await query(`ALTER TABLE audit_log RENAME TO audit_log_legacy`)
    await query(PARTITIONED_TABLE_SQL)
    // Create the current + next month partitions FIRST so legacy rows
    // landing in those months route to them. Older rows fall through to
    // the default. This avoids the "default partition would be violated"
    // error that Postgres throws if monthly partitions are added later
    // and the default already holds rows for those months.
    await ensureCurrentAndNextPartitions(query, log)
    await query(`CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT`)
    // Explicit column list — legacy table's column order
    // (id, actor, action, resource_type, resource_id, resource_name, diff,
    //  metadata, created_at, actor_key_id, actor_scope) differs from the
    // partitioned shape, so SELECT * would mis-align types.
    await query(`
      INSERT INTO audit_log
        (id, actor, actor_key_id, actor_scope, action,
         resource_type, resource_id, resource_name,
         diff, metadata, created_at)
      SELECT
         id, actor, actor_key_id, actor_scope, action,
         resource_type, resource_id, resource_name,
         diff, metadata, created_at
      FROM audit_log_legacy
    `)
    await query(`DROP TABLE audit_log_legacy`)
    for (const sql of PARTITION_INDEXES) await query(sql)
    log?.info?.('[audit-partitioning] audit_log migrated to partitioned')
    return { state: 'regular', migrated: true }
  }
  log?.warn?.(`[audit-partitioning] audit_log in unexpected state '${state}' — skipping`)
  return { state, migrated: false }
}

// Format helpers — keep partition naming + bounds in one place so the
// detection / drop / list functions all agree.
function partitionName(year, month) {
  return `${PARTITION_PREFIX}${year}_${String(month).padStart(2, '0')}`
}

function monthBounds(year, month) {
  // ISO-formatted UTC instants. month is 1-indexed; JS Date is 0-indexed.
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)).toISOString()
  const to   = new Date(Date.UTC(year, month,     1, 0, 0, 0, 0)).toISOString()
  return { from, to }
}

// Create a partition for one specific year-month if it doesn't already
// exist. Idempotent — safe to call repeatedly.
//
// Postgres DDL doesn't accept `$1` placeholders, so the bounds are
// interpolated as SQL literals. Both `name` and `{from, to}` come from
// internal code (year + month integers → fixed-format ISO strings), so
// there's no injection vector — but we still validate `name` against a
// strict pattern as a defence-in-depth backstop.
const PARTITION_NAME_RE = /^audit_log_\d{4}_\d{2}$/

export async function ensureMonthlyPartition(query, log, year, month) {
  const name = partitionName(year, month)
  if (!PARTITION_NAME_RE.test(name)) {
    throw new Error(`audit-partitioning: refusing to use unsafe partition name '${name}'`)
  }
  const { from, to } = monthBounds(year, month)
  // CREATE TABLE IF NOT EXISTS doesn't work for partition-of syntax
  // (Postgres rejects it), so check existence first.
  const existing = await query(
    `SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = current_schema()::regnamespace`,
    [name],
  )
  if (existing.length > 0) return { name, created: false }
  await query(
    `CREATE TABLE ${name} PARTITION OF audit_log
     FOR VALUES FROM ('${from}') TO ('${to}')`,
  )
  log?.info?.({ partition: name, from, to }, '[audit-partitioning] partition created')
  return { name, created: true }
}

// Convenience: ensure partitions exist for the current and next month, so
// rows landing right on a month boundary always have a place to go without
// falling through to the default partition.
export async function ensureCurrentAndNextPartitions(query, log, now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1                       // 1-indexed
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }
  const a = await ensureMonthlyPartition(query, log, y, m)
  const b = await ensureMonthlyPartition(query, log, next.y, next.m)
  return { current: a, next: b }
}

// Returns named partitions (audit_log_YYYY_MM) whose UPPER bound is older
// than `cutoff`. Excludes the default partition (always retained).
export async function listExpiredPartitions(query, cutoff) {
  const rows = await query(`
    SELECT
      child.relname AS name,
      pg_get_expr(child.relpartbound, child.oid) AS bound
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
    WHERE parent.relname = 'audit_log'
      AND child.relname  LIKE '${PARTITION_PREFIX}%'
      AND child.relname  != '${PARTITION_PREFIX}default'
  `)
  const expired = []
  for (const r of rows) {
    // Bound shape: FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00')
    const m = /TO \('([^']+)'\)/.exec(r.bound || '')
    if (!m) continue
    const upper = new Date(m[1])
    if (Number.isNaN(upper.getTime())) continue
    if (upper <= cutoff) expired.push({ name: r.name, upper })
  }
  return expired
}

export async function dropPartition(query, log, name) {
  // DETACH first so the parent's row count stops counting it, then drop.
  // The two statements run in the same connection; if DETACH succeeds and
  // DROP fails, the partition becomes a standalone table — operator can
  // clean up by hand. Acceptable risk for a periodic retention job.
  await query(`ALTER TABLE audit_log DETACH PARTITION ${name}`)
  await query(`DROP TABLE ${name}`)
  log?.info?.({ partition: name }, '[audit-partitioning] partition dropped')
}
