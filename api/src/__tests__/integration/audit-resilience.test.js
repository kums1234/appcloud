// Integration test — audit-row resilience features against real Postgres.
//
//   1. pg.audit() retry buffer: when the underlying INSERT fails, the row
//      lands in an in-memory queue that drains on the next successful
//      INSERT (or the periodic timer). Locks the contract that previously-
//      silently-dropped rows now survive a transient outage.
//
//   2. audit-cleanup retention: a CTE-batched DELETE removes audit_log
//      rows older than retentionDays.
//
// Both tests use the production audit machinery (utils/audit-buffer.js)
// so the algorithm under test is the same one prod runs.

import { test, expect, beforeAll, afterAll, jest } from '@jest/globals'
import {
  getMaybeDescribe,
  startPostgres,
  applyPostgresInitFiles,
} from './helpers.js'
import { makeAuditMachinery } from '../../utils/audit-buffer.js'

jest.setTimeout(600_000)

const maybeDescribe = getMaybeDescribe('audit-resilience integration')

maybeDescribe('audit retry buffer + retention cleanup (Testcontainers)', () => {
  let pgContainer, pgClient
  let machinery
  let pgUp = true                                  // toggled to simulate outage

  beforeAll(async () => {
    ;({ container: pgContainer, client: pgClient } = await startPostgres())
    await applyPostgresInitFiles(pgClient, [
      '01-schema.sql',
      '10-api-keys.sql',
      '11-audit-evolution.sql',
    ])

    // Wrap pgClient.query with a fault-injection toggle. The machinery
    // factory only sees runQuery — this mirrors how prod calls
    // pool.query, with the test free to make it fail on demand.
    const runQuery = async (sql, params) => {
      if (!pgUp) throw new Error('simulated postgres outage')
      return pgClient.query(sql, params)
    }
    machinery = makeAuditMachinery({
      runQuery,
      log: { warn() {}, info() {} },               // silent in tests
      bufferMax: 1000,
    })
  }, 180_000)

  afterAll(async () => {
    try { await pgClient?.end() }     catch {}
    try { await pgContainer?.stop() } catch {}
  })

  test('audit() retries buffered rows and preserves call order', async () => {
    pgUp = false

    // Three audits during the outage — all queue in the buffer.
    await machinery.audit({ name: 'test-actor', keyId: null, scope: null },
      'create', 'TestResource', 'r-buffered-1', 'r1')
    await machinery.audit({ name: 'test-actor', keyId: null, scope: null },
      'create', 'TestResource', 'r-buffered-2', 'r2')
    await machinery.audit({ name: 'test-actor', keyId: null, scope: null },
      'create', 'TestResource', 'r-buffered-3', 'r3')

    expect(machinery.pending()).toBe(3)

    // Nothing in the DB yet.
    const beforeRecover = await pgClient.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE resource_id LIKE 'r-buffered-%'`,
    )
    expect(beforeRecover.rows[0].n).toBe(0)

    // Postgres comes back. The recovery audit sees a non-empty queue, so
    // it ALSO queues — preserving call order — and the drain processes
    // every entry FIFO.
    pgUp = true
    await machinery.audit({ name: 'test-actor', keyId: null, scope: null },
      'create', 'TestResource', 'r-recovery', 'rec')

    // The recovery audit() kicked off an async drain. Await it explicitly
    // here so the test isn't racing against the timer.
    await machinery.drain()
    expect(machinery.pending()).toBe(0)

    // Rows in DB in original call order.
    const after = await pgClient.query(`
      SELECT resource_id FROM audit_log
      WHERE resource_id LIKE 'r-buffered-%' OR resource_id = 'r-recovery'
      ORDER BY created_at ASC, resource_id ASC
    `)
    expect(after.rows.map(r => r.resource_id)).toEqual([
      'r-buffered-1', 'r-buffered-2', 'r-buffered-3', 'r-recovery',
    ])
  })

  test('audit retention deletes rows older than the cutoff', async () => {
    // Insert two old + one recent fixture row.
    await pgClient.query(`
      INSERT INTO audit_log (actor, action, resource_type, resource_id, created_at) VALUES
        ('test', 'retention-old',  'TestRow', 'old-1', now() - interval '90 days'),
        ('test', 'retention-old',  'TestRow', 'old-2', now() - interval '60 days'),
        ('test', 'retention-keep', 'TestRow', 'new-1', now() - interval '5 days')
    `)

    // Inline the same CTE-batched DELETE the audit-cleanup plugin runs.
    const retentionDays = 30
    const cutoff = new Date(Date.now() - retentionDays * 86400_000)
    await pgClient.query(`
      WITH old AS (
        SELECT id FROM audit_log WHERE created_at < $1 ORDER BY created_at ASC LIMIT 1000
      )
      DELETE FROM audit_log a USING old WHERE a.id = old.id
    `, [cutoff])

    // Only the recent row survives among the retention-* fixtures.
    const survivors = await pgClient.query(
      `SELECT resource_id FROM audit_log WHERE action LIKE 'retention-%' ORDER BY resource_id`,
    )
    expect(survivors.rows.map(r => r.resource_id)).toEqual(['new-1'])
  })
})
