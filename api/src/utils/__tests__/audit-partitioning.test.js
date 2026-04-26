import { describe, test, expect } from '@jest/globals'
import {
  ensureMonthlyPartition,
  ensureCurrentAndNextPartitions,
  listExpiredPartitions,
} from '../audit-partitioning.js'

// Pure-JS unit tests on the bits that don't need a real DB. The
// DB-dependent paths (state detection, migration, drop) are exercised
// by the integration test against Testcontainers Postgres.

describe('partition naming + bounds', () => {
  // We can introspect ensureMonthlyPartition's behaviour by giving it a
  // fake `query` that records the SQL it's asked to execute.
  function fakeQuery() {
    const calls = []
    let exists = false
    const query = async (sql, params) => {
      calls.push({ sql, params })
      // The "does this partition exist?" probe — return empty/non-empty
      // based on the flag the test sets.
      if (sql.includes('FROM pg_class WHERE relname')) {
        return exists ? [{ '?column?': 1 }] : []
      }
      return []
    }
    return { query, calls, setExists(v) { exists = v } }
  }

  test('ensureMonthlyPartition formats name as audit_log_YYYY_MM', async () => {
    const fake = fakeQuery()
    fake.setExists(false)
    const r = await ensureMonthlyPartition(fake.query, null, 2026, 4)
    expect(r.name).toBe('audit_log_2026_04')
    expect(r.created).toBe(true)
    const createCall = fake.calls.find(c => c.sql.includes('PARTITION OF audit_log'))
    expect(createCall).toBeTruthy()
  })

  test('ensureMonthlyPartition returns created:false when partition already exists', async () => {
    const fake = fakeQuery()
    fake.setExists(true)
    const r = await ensureMonthlyPartition(fake.query, null, 2026, 4)
    expect(r.created).toBe(false)
    // The CREATE TABLE statement must NOT have been issued.
    const createCall = fake.calls.find(c => c.sql.includes('PARTITION OF audit_log'))
    expect(createCall).toBeUndefined()
  })

  test('month bounds are UTC midnight and span exactly the named month', async () => {
    const fake = fakeQuery()
    fake.setExists(false)
    await ensureMonthlyPartition(fake.query, null, 2026, 4)
    const createCall = fake.calls.find(c => c.sql.includes('PARTITION OF audit_log'))
    // DDL doesn't accept parameter placeholders, so the bounds are
    // SQL-literal-interpolated. Assert via substring match.
    expect(createCall.sql).toContain("FROM ('2026-04-01T00:00:00.000Z')")
    expect(createCall.sql).toContain("TO ('2026-05-01T00:00:00.000Z')")
  })

  test('refuses partition names that don\'t match the strict pattern', async () => {
    // Fabricate a year/month combo that yields a malformed name. The
    // helper is meant to be the only entry point for partition creation,
    // so a future caller passing weird input gets caught here.
    const fake = fakeQuery()
    fake.setExists(false)
    await expect(ensureMonthlyPartition(fake.query, null, 99999, 4))
      .rejects.toThrow(/refusing to use unsafe partition name/)
  })

  test('December rolls over to next-year January for the "next month"', async () => {
    const fake = fakeQuery()
    fake.setExists(false)
    const result = await ensureCurrentAndNextPartitions(fake.query, null, new Date('2026-12-15T00:00:00Z'))
    expect(result.current.name).toBe('audit_log_2026_12')
    expect(result.next.name).toBe('audit_log_2027_01')
  })

  test('listExpiredPartitions parses Postgres FOR-VALUES bound expressions', async () => {
    // Stub a query result mimicking what pg_inherits + pg_class returns.
    const stubbedRows = [
      { name: 'audit_log_2025_01', bound: "FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-02-01 00:00:00+00')" },
      { name: 'audit_log_2025_02', bound: "FOR VALUES FROM ('2025-02-01 00:00:00+00') TO ('2025-03-01 00:00:00+00')" },
      { name: 'audit_log_2026_05', bound: "FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00')" },
    ]
    const query = async () => stubbedRows
    // Cutoff: anything ending before 2026-04-01 should be expired.
    const expired = await listExpiredPartitions(query, new Date('2026-04-01T00:00:00Z'))
    const names = expired.map(p => p.name).sort()
    expect(names).toEqual(['audit_log_2025_01', 'audit_log_2025_02'])
  })

  test('listExpiredPartitions skips rows whose bound text is unparseable', async () => {
    const query = async () => [
      { name: 'audit_log_2025_01', bound: 'WEIRD FORMAT' },
      { name: 'audit_log_2025_02', bound: "FOR VALUES FROM ('2025-02-01 00:00:00+00') TO ('2025-03-01 00:00:00+00')" },
    ]
    const expired = await listExpiredPartitions(query, new Date('2026-04-01T00:00:00Z'))
    expect(expired.map(p => p.name)).toEqual(['audit_log_2025_02'])
  })
})
