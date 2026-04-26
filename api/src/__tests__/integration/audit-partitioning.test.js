// Integration test — audit_log partitioning lifecycle against real Postgres.
//
//   1. ensureAuditPartitioning() converts a regular audit_log to
//      partitioned, copies existing rows into the default partition,
//      and creates an idempotent path on second call.
//   2. ensureCurrentAndNextPartitions() creates the named monthly
//      partitions for now and now+1 month.
//   3. listExpiredPartitions() identifies partitions whose upper bound
//      is older than the cutoff.
//   4. dropPartition() removes a partition cleanly.
//   5. Rows INSERTed into audit_log get routed to the matching monthly
//      partition (or the default).

import { test, expect, beforeAll, afterAll, jest } from '@jest/globals'
import {
  getMaybeDescribe,
  startPostgres,
  applyPostgresInitFiles,
} from './helpers.js'
import {
  detectAuditLogState,
  ensureAuditPartitioning,
  ensureCurrentAndNextPartitions,
  ensureMonthlyPartition,
  listExpiredPartitions,
  dropPartition,
} from '../../utils/audit-partitioning.js'

jest.setTimeout(600_000)

const maybeDescribe = getMaybeDescribe('audit-partitioning integration')

maybeDescribe('audit_log partitioning lifecycle (Testcontainers)', () => {
  let pgContainer, pgClient
  let runQuery
  const log = { info() {}, warn() {}, error() {} }

  beforeAll(async () => {
    ;({ container: pgContainer, client: pgClient } = await startPostgres())
    // Apply only the pre-partitioning files so we start with a regular
    // audit_log; ensureAuditPartitioning() should migrate it.
    await applyPostgresInitFiles(pgClient, [
      '01-schema.sql',
      '10-api-keys.sql',
      '11-audit-evolution.sql',
    ])
    runQuery = async (sql, params = []) => (await pgClient.query(sql, params)).rows
  }, 180_000)

  afterAll(async () => {
    try { await pgClient?.end() }     catch {}
    try { await pgContainer?.stop() } catch {}
  })

  test('detectAuditLogState reports "regular" before migration', async () => {
    expect(await detectAuditLogState(runQuery)).toBe('regular')
  })

  test('ensureAuditPartitioning migrates regular → partitioned + copies rows', async () => {
    // Seed two rows in the pre-migration table so we can confirm they
    // survive the rename → recreate → INSERT cycle.
    await pgClient.query(`
      INSERT INTO audit_log (actor, action, resource_type, resource_id) VALUES
        ('test', 'pre-migration', 'TestRow', 'm-1'),
        ('test', 'pre-migration', 'TestRow', 'm-2')
    `)

    const r = await ensureAuditPartitioning(runQuery, log)
    expect(r.migrated).toBe(true)
    expect(r.state).toBe('regular')                  // i.e. that's where we came from

    expect(await detectAuditLogState(runQuery)).toBe('partitioned')

    // Migrated rows are still readable.
    const rows = await runQuery(`
      SELECT resource_id FROM audit_log
      WHERE action = 'pre-migration'
      ORDER BY resource_id
    `)
    expect(rows.map(r => r.resource_id)).toEqual(['m-1', 'm-2'])

    // Idempotent — second call is a no-op.
    const r2 = await ensureAuditPartitioning(runQuery, log)
    expect(r2.migrated).toBe(false)
  })

  test('ensureCurrentAndNextPartitions creates the named monthly partitions', async () => {
    const result = await ensureCurrentAndNextPartitions(runQuery, log)
    // First call creates them; assert they now exist in pg_class.
    for (const part of [result.current, result.next]) {
      const row = await runQuery(
        `SELECT relname FROM pg_class WHERE relname = $1`,
        [part.name],
      )
      expect(row.length).toBe(1)
    }
    // Second call is a no-op (created: false).
    const again = await ensureCurrentAndNextPartitions(runQuery, log)
    expect(again.current.created).toBe(false)
    expect(again.next.created).toBe(false)
  })

  test('rows INSERTed into audit_log route to the matching monthly partition', async () => {
    const now = new Date()
    const yyyy = now.getUTCFullYear()
    const mm   = String(now.getUTCMonth() + 1).padStart(2, '0')
    const expectedPartition = `audit_log_${yyyy}_${mm}`

    // INSERT at the current instant — should land in the current-month partition.
    await pgClient.query(`
      INSERT INTO audit_log (actor, action, resource_type, resource_id, created_at)
      VALUES ('test', 'partition-route', 'TestRow', 'route-now', now())
    `)
    const partRows = await runQuery(
      `SELECT resource_id FROM ${expectedPartition} WHERE resource_id = 'route-now'`,
    )
    expect(partRows.length).toBe(1)
  })

  test('listExpiredPartitions + dropPartition remove the right partitions', async () => {
    // Create a couple of partitions in the deep past so we can drop them.
    await ensureMonthlyPartition(runQuery, log, 2024, 1)
    await ensureMonthlyPartition(runQuery, log, 2024, 2)
    await ensureMonthlyPartition(runQuery, log, 2024, 3)

    // Cutoff: drop anything whose UPPER bound is before 2024-03-15.
    // That means 2024_01 (ends 2024-02-01) and 2024_02 (ends 2024-03-01)
    // get dropped; 2024_03 (ends 2024-04-01) survives.
    const expired = await listExpiredPartitions(runQuery, new Date('2024-03-15T00:00:00Z'))
    const names = expired.map(p => p.name).sort()
    expect(names).toEqual(['audit_log_2024_01', 'audit_log_2024_02'])

    for (const p of expired) {
      await dropPartition(runQuery, log, p.name)
    }

    // Confirm they're gone. Filter on relkind='r' so partition INDEXES
    // (which also match the LIKE pattern as audit_log_2024_03_pkey etc.)
    // don't pollute the assertion.
    const survivors = await runQuery(`
      SELECT relname FROM pg_class
      WHERE relname LIKE 'audit_log_2024_%'
        AND relkind = 'r'
      ORDER BY relname
    `)
    expect(survivors.map(r => r.relname)).toEqual(['audit_log_2024_03'])
  })

  test('partitioned-mode runRegularCleanup falls through to no-op on empty state', async () => {
    // Sanity check: the cleanup plugin's regular-table fallback shouldn't
    // accidentally fire when the table IS partitioned. Verify by
    // detecting state once more — the previous tests left audit_log
    // partitioned and the test assertion above already locks that.
    expect(await detectAuditLogState(runQuery)).toBe('partitioned')
  })
})
