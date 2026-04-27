import { describe, test, expect } from '@jest/globals'
import {
  ensureMonthlyPartition,
  ensureCurrentAndNextPartitions,
  listExpiredPartitions,
  redistributeDefaultPartition,
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

  test('month bounds for December produce January-of-next-year as upper bound', async () => {
    // Subtle: monthBounds() builds `to` as Date.UTC(year, month, 1).
    // JS Date is 0-indexed, so month=12 wraps to month=0 of year+1
    // (i.e. Jan-1 next year). Lock that contract — a refactor that
    // accidentally subtracted 1 from `month` would silently produce a
    // partition spanning Dec→Dec instead of Dec→Jan-next-year.
    const fake = fakeQuery()
    fake.setExists(false)
    await ensureMonthlyPartition(fake.query, null, 2026, 12)
    const createCall = fake.calls.find(c => c.sql.includes('PARTITION OF audit_log'))
    expect(createCall.sql).toContain("FROM ('2026-12-01T00:00:00.000Z')")
    expect(createCall.sql).toContain("TO ('2027-01-01T00:00:00.000Z')")
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

describe('redistributeDefaultPartition', () => {
  // The stub recognises the call patterns redistribute uses: existence
  // probe (pg_class), DISTINCT month query, ensureMonthlyPartition's
  // probe + CREATE, and the final move statement. Each query type
  // returns a configurable result so we can assert on call ordering and
  // SQL shape without spinning a real DB.
  function makeStub({ defaultExists = true, monthsInDefault = [], existingPartitions = new Set() } = {}) {
    const calls = []
    const movedPerMonth = new Map()             // 'YYYY-MM' → row count moved (test setup)
    const query = async (sql, params = []) => {
      calls.push({ sql, params })
      // pg_class existence probe (default partition + per-month partition)
      if (sql.includes('FROM pg_class') && sql.includes('WHERE relname')) {
        const name = params[0]
        if (name === 'audit_log_default') return defaultExists ? [{ '?column?': 1 }] : []
        return existingPartitions.has(name) ? [{ '?column?': 1 }] : []
      }
      // DISTINCT YEAR/MONTH from default
      if (sql.includes('SELECT DISTINCT') && sql.includes('audit_log_default')) {
        return monthsInDefault
      }
      // The redistribute INSERT … RETURNING id — return one fake row per
      // moved entry so .length matches the configured count.
      if (sql.includes('INSERT INTO audit_log') && sql.includes('RETURNING id')) {
        const m = sql.match(/'(\d{4}-\d{2})-01T00:00:00\.000Z'/)
        const key = m?.[1] ?? params?.[0]?.slice(0, 7) ?? ''
        const count = movedPerMonth.get(key) ?? 0
        return Array.from({ length: count }, (_, i) => ({ id: `id-${key}-${i}` }))
      }
      return []
    }
    return { query, calls, setMoved(year, month, n) {
      movedPerMonth.set(`${year}-${String(month).padStart(2, '0')}`, n)
    } }
  }

  test('returns zero counts and creates nothing when default partition is empty', async () => {
    const stub = makeStub({ monthsInDefault: [] })
    const r = await redistributeDefaultPartition(stub.query, null)
    expect(r).toEqual({ moved: 0, partitionsCreated: [], months: [] })
  })

  test('skips cleanly + warns when default partition is absent', async () => {
    const warnings = []
    const log = { warn: (msg) => warnings.push(msg) }
    const stub = makeStub({ defaultExists: false })
    const r = await redistributeDefaultPartition(stub.query, log)
    expect(r).toEqual({ moved: 0, partitionsCreated: [], months: [] })
    expect(warnings.some(w => /skipping redistribute/.test(w))).toBe(true)
    // No INSERT must have been issued — important: an absent default
    // partition is the post-DETACH state, not a corruption signal.
    expect(stub.calls.some(c => c.sql.includes('INSERT INTO audit_log'))).toBe(false)
  })

  test('creates the target partition before moving rows for that month', async () => {
    const stub = makeStub({
      monthsInDefault: [{ y: 2025, m: 12 }],
    })
    stub.setMoved(2025, 12, 7)
    const r = await redistributeDefaultPartition(stub.query, null)
    expect(r.moved).toBe(7)
    expect(r.partitionsCreated).toEqual(['audit_log_2025_12'])
    expect(r.months).toEqual([
      { partition: 'audit_log_2025_12', year: 2025, month: 12, moved: 7 },
    ])
    // Order matters: CREATE PARTITION before INSERT INTO audit_log.
    const createIdx = stub.calls.findIndex(c => c.sql.includes('PARTITION OF audit_log') && c.sql.includes('audit_log_2025_12'))
    const insertIdx = stub.calls.findIndex(c => c.sql.includes('INSERT INTO audit_log'))
    expect(createIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeGreaterThan(createIdx)
  })

  test('reuses an existing partition (no CREATE) and still moves rows', async () => {
    const stub = makeStub({
      monthsInDefault:    [{ y: 2026, m: 1 }],
      existingPartitions: new Set(['audit_log_2026_01']),
    })
    stub.setMoved(2026, 1, 3)
    const r = await redistributeDefaultPartition(stub.query, null)
    expect(r.partitionsCreated).toEqual([])
    expect(r.moved).toBe(3)
    // No CREATE TABLE for an existing partition.
    expect(stub.calls.some(c =>
      c.sql.includes('PARTITION OF audit_log') && c.sql.includes('audit_log_2026_01'),
    )).toBe(false)
  })

  test('aggregates per-month counts across multiple months in chronological order', async () => {
    const stub = makeStub({
      monthsInDefault: [
        { y: 2024, m: 11 },
        { y: 2024, m: 12 },
        { y: 2025, m: 3 },
      ],
    })
    stub.setMoved(2024, 11, 4)
    stub.setMoved(2024, 12, 9)
    stub.setMoved(2025, 3, 2)
    const r = await redistributeDefaultPartition(stub.query, null)
    expect(r.moved).toBe(15)
    expect(r.months.map(x => x.partition)).toEqual([
      'audit_log_2024_11',
      'audit_log_2024_12',
      'audit_log_2025_03',
    ])
    expect(r.partitionsCreated).toEqual([
      'audit_log_2024_11',
      'audit_log_2024_12',
      'audit_log_2025_03',
    ])
  })
})
