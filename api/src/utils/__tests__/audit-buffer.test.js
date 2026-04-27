import { describe, test, expect } from '@jest/globals'
import { makeAuditMachinery, buildAuditRow } from '../audit-buffer.js'

// A tiny pool-like helper that records inserts and can be made to fail.
// Each entry in `calls` carries an `ok: boolean` flag so tests can
// distinguish attempts from successful inserts without re-deriving it.
function fakeRunQuery() {
  const calls = []
  let fail = false
  const runQuery = async (sql, params) => {
    if (fail) {
      calls.push({ sql, params, ok: false })
      throw new Error('simulated outage')
    }
    calls.push({ sql, params, ok: true })
    return { rows: [], rowCount: 1 }
  }
  // Returns the resource_id (params[5]) of every SUCCESSFUL audit insert,
  // in the order they happened.
  function successfulResourceIds() {
    return calls.filter(c => c.ok && c.sql.includes('INSERT INTO audit_log'))
                .map(c => c.params[5])
  }
  return { runQuery, calls, setFail(v) { fail = v }, successfulResourceIds }
}

describe('buildAuditRow', () => {
  test('string actor lands in actor name; key_id and scope NULL', () => {
    const row = buildAuditRow('system', 'a', 't', 'r', 'rn', { x: 1 })
    expect(row[0]).toBe('system')
    expect(row[1]).toBeNull()
    expect(row[2]).toBeNull()
  })

  test('object actor populates all three columns', () => {
    const row = buildAuditRow(
      { name: 'admin-key', keyId: 'uuid-1', scope: 'admin' },
      'create', 'App', 'r-1', 'app-1',
    )
    expect(row[0]).toBe('admin-key')
    expect(row[1]).toBe('uuid-1')
    expect(row[2]).toBe('admin')
  })

  test('null/undefined actor falls back to "system"', () => {
    expect(buildAuditRow(null,      'a', 't', 'r', 'n')[0]).toBe('system')
    expect(buildAuditRow(undefined, 'a', 't', 'r', 'n')[0]).toBe('system')
  })

  test('metadata defaults to empty object as JSON', () => {
    expect(buildAuditRow('system', 'a', 't', 'r', 'n')[7]).toBe('{}')
  })
})

describe('makeAuditMachinery', () => {
  test('hot path: successful audit hits runQuery once, no buffer use', async () => {
    const fake = fakeRunQuery()
    const m = makeAuditMachinery({ runQuery: fake.runQuery })
    await m.audit('system', 'a', 't', 'r', 'n')
    expect(fake.calls).toHaveLength(1)
    expect(m.pending()).toBe(0)
  })

  test('failing audit lands in the buffer; later drain flushes it', async () => {
    const fake = fakeRunQuery()
    const m = makeAuditMachinery({ runQuery: fake.runQuery })
    fake.setFail(true)
    await m.audit('system', 'a', 't', 'r-1', 'n')
    await m.audit('system', 'a', 't', 'r-2', 'n')
    expect(m.pending()).toBe(2)
    fake.setFail(false)
    const result = await m.drain()
    expect(result.drained).toBe(2)
    expect(m.pending()).toBe(0)
  })

  test('audit during outage + during recovery: order preserved (FIFO drain)', async () => {
    const fake = fakeRunQuery()
    const m = makeAuditMachinery({ runQuery: fake.runQuery })
    fake.setFail(true)
    await m.audit('system', 'a', 't', 'r-buf-1', 'n')
    await m.audit('system', 'a', 't', 'r-buf-2', 'n')
    fake.setFail(false)
    // Recovery audit — should NOT race ahead of the buffer; with the
    // queue non-empty it enqueues itself and lets the drain go FIFO.
    await m.audit('system', 'a', 't', 'r-recovery', 'n')
    await m.drain()
    // The three successful INSERTs are in original call order. Failed
    // attempts (during outage / mid-drain) are filtered out by `ok`.
    expect(fake.successfulResourceIds()).toEqual(['r-buf-1', 'r-buf-2', 'r-recovery'])
  })

  test('buffer overflow drops oldest row + bumps stats.dropped', async () => {
    const fake = fakeRunQuery()
    const m = makeAuditMachinery({ runQuery: fake.runQuery, bufferMax: 3 })
    fake.setFail(true)
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await m.audit('system', 'create', 't', id, id)
    }
    expect(m.pending()).toBe(3)               // capped at bufferMax
    expect(m.stats().dropped).toBe(2)         // 'a' and 'b' evicted
    fake.setFail(false)
    await m.drain()
    // The three most-recent (c, d, e) survive in the DB, in FIFO order.
    expect(fake.successfulResourceIds()).toEqual(['c', 'd', 'e'])
  })

  test('poison row evicts after MAX_ROW_ATTEMPTS so subsequent rows can drain', async () => {
    // Mimic a "head row always fails, others succeed" scenario — e.g. a
    // single bad row with an FK violation while the rest of the queue
    // is fine. Without poison-eviction this would block the queue
    // forever; with it, the bad row gets logged + evicted after 3
    // attempts and the queue drains.
    const calls = []
    let attemptsOnA = 0
    const runQuery = async (sql, params) => {
      calls.push({ params })
      const isRowA = params[5] === 'a'
      if (isRowA) {
        attemptsOnA++
        throw new Error('FK violation on row a')
      }
      // Others succeed.
      return { rows: [], rowCount: 1 }
    }
    const warnings = []
    const log = { warn: (obj, msg) => warnings.push({ obj, msg }) }
    const m = makeAuditMachinery({ runQuery, log })

    // Queue rows: a (poison), b, c.
    await m.audit('system', 'a', 't', 'a', 'a')   // initial INSERT fails → buffered
    await m.audit('system', 'a', 't', 'b', 'b')   // queues behind a
    await m.audit('system', 'a', 't', 'c', 'c')

    // The first call to audit('a') tries-and-fails the live INSERT (1 attempt).
    // Each subsequent audit() kicks a drain that retries 'a' and bails.
    // Three attempts total → poison threshold hit on the third drain.
    // After that, the next drain should clear b and c.
    await m.drain()                              // 4th attempt on `a` — but already evicted at 3
    expect(m.stats().poisoned).toBe(1)
    expect(m.pending()).toBe(0)                   // b and c drained
    // The successful inserts are b and c, in order.
    const succeeded = calls.filter(c =>
      ['b', 'c'].includes(c.params[5]),
    )
    expect(succeeded.length).toBeGreaterThanOrEqual(2)
    // The poison-eviction log is structured + actionable.
    const poisonLog = warnings.find(w => /poison-evicted/.test(w.msg))
    expect(poisonLog).toBeDefined()
    expect(poisonLog.obj.actor).toBe('system')
    expect(poisonLog.obj.resource).toBe('t/a')
  })

  test('concurrent drains do not double-insert (draining flag holds the line)', async () => {
    const fake = fakeRunQuery()
    const m = makeAuditMachinery({ runQuery: fake.runQuery })
    fake.setFail(true)
    await m.audit('system', 'a', 't', 'r-1', 'n')
    fake.setFail(false)
    // Race two drains. The second one should see draining=true and bail.
    const [r1, r2] = await Promise.all([m.drain(), m.drain()])
    const totalDrained = r1.drained + r2.drained
    expect(totalDrained).toBe(1)              // only one of them did the insert
    expect(m.pending()).toBe(0)
    // And exactly one INSERT call landed for r-1.
    const r1Inserts = fake.calls.filter(c =>
      c.sql.trim().startsWith('INSERT INTO audit_log') && c.params[5] === 'r-1',
    )
    // 1 from the failing audit attempt + 1 from the successful drain = 2
    // total runQuery calls; but only ONE of them succeeded.
    expect(r1Inserts.length).toBe(2)
  })
})
