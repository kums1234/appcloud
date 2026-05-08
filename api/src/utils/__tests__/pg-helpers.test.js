// Unit tests for utils/pg-helpers.js. These exercise the live module
// (no longer a duplicated mirror as in the Phase 1b transitional test
// at plugins/__tests__/postgres-helpers.test.js, which is retired now
// that the helpers have their own home).

import { describe, test, expect, beforeEach } from '@jest/globals'
import {
  quoteSchemaIdent,
  runInTransaction,
  makeForTenant,
  makeControlTransaction,
} from '../pg-helpers.js'

function makeStubPool() {
  const calls = []
  const responders = []
  const respond = (matcher, result) => responders.push([matcher, result])
  const client = {
    released: false,
    query: async (sql, params) => {
      calls.push({ sql, params })
      for (const [matcher, result] of responders) {
        if (matcher(sql)) {
          if (typeof result === 'function') return result(sql, params)
          return result
        }
      }
      return { rows: [] }
    },
    release: function () { this.released = true },
  }
  return { pool: { connect: async () => client }, client, calls, respond }
}

let stub
beforeEach(() => { stub = makeStubPool() })

describe('quoteSchemaIdent', () => {
  test('accepts valid tenant-shaped names + wraps in double quotes', () => {
    expect(quoteSchemaIdent('tenant_default')).toBe('"tenant_default"')
    expect(quoteSchemaIdent('tenant_abc123')).toBe('"tenant_abc123"')
    expect(quoteSchemaIdent('control')).toBe('"control"')
  })

  test('rejects unsafe names — quotes, semicolons, leading digits', () => {
    expect(() => quoteSchemaIdent('1bad')).toThrow(/refusing unsafe schema name/)
    expect(() => quoteSchemaIdent('"; SELECT 1')).toThrow()
    expect(() => quoteSchemaIdent('schema; DROP TABLE x')).toThrow()
    expect(() => quoteSchemaIdent('')).toThrow()
  })
})

describe('runInTransaction', () => {
  test('BEGIN, optional searchPathClause, fn, COMMIT — releases', async () => {
    stub.respond((sql) => /^SELECT 42$/.test(sql), { rows: [{ a: 42 }] })
    const out = await runInTransaction(stub.pool, 'SET LOCAL search_path = "x", public', async (c) =>
      (await c.query('SELECT 42')).rows[0].a,
    )
    expect(out).toBe(42)
    expect(stub.calls.map(c => c.sql)).toEqual([
      'BEGIN',
      'SET LOCAL search_path = "x", public',
      'SELECT 42',
      'COMMIT',
    ])
    expect(stub.client.released).toBe(true)
  })

  test('null searchPathClause skips the SET LOCAL statement', async () => {
    await runInTransaction(stub.pool, null, async (c) => { await c.query('SELECT 1') })
    const sqls = stub.calls.map(c => c.sql)
    expect(sqls.some(s => /SET LOCAL/.test(s))).toBe(false)
    expect(sqls).toContain('BEGIN')
    expect(sqls).toContain('COMMIT')
  })

  test('ROLLBACK + release on a thrown error in fn', async () => {
    await expect(
      runInTransaction(stub.pool, null, async () => { throw new Error('boom') }),
    ).rejects.toThrow(/boom/)
    expect(stub.calls.map(c => c.sql)).toContain('ROLLBACK')
    expect(stub.calls.map(c => c.sql)).not.toContain('COMMIT')
    expect(stub.client.released).toBe(true)
  })
})

describe('makeForTenant', () => {
  test('rejects unsafe schema names eagerly, before any connection use', () => {
    expect(() => makeForTenant(stub.pool, 'evil; DROP TABLE x'))
      .toThrow(/refusing unsafe schema name/)
    expect(stub.calls.length).toBe(0)
  })

  test('.query runs SET LOCAL search_path then the SQL inside one transaction', async () => {
    stub.respond((sql) => /^SELECT 1$/.test(sql), { rows: [{ ok: 1 }] })
    const tenantPg = makeForTenant(stub.pool, 'tenant_default')
    const rows = await tenantPg.query('SELECT 1')
    expect(rows).toEqual([{ ok: 1 }])
    expect(stub.calls.map(c => c.sql)).toEqual([
      'BEGIN',
      'SET LOCAL search_path = "tenant_default", public',
      'SELECT 1',
      'COMMIT',
    ])
  })

  test('.transaction(fn) bundles multiple queries under one search_path setting', async () => {
    stub.respond((sql) => /SELECT a/.test(sql), { rows: [{ a: 1 }] })
    const tenantPg = makeForTenant(stub.pool, 'tenant_x')
    await tenantPg.transaction(async (c) => {
      await c.query('SELECT a')
      await c.query('UPDATE foo SET x = 1')
    })
    const sqls = stub.calls.map(c => c.sql)
    expect(sqls.filter(s => /SET LOCAL search_path/.test(s)).length).toBe(1)
    expect(sqls.filter(s => s === 'BEGIN').length).toBe(1)
    expect(sqls.filter(s => s === 'COMMIT').length).toBe(1)
  })

  test('.schemaName is exposed for callers that want to log / branch on it', () => {
    const tenantPg = makeForTenant(stub.pool, 'tenant_acme')
    expect(tenantPg.schemaName).toBe('tenant_acme')
  })
})

describe('makeControlTransaction', () => {
  test('returns a function that runs fn(client) without setting search_path', async () => {
    const tx = makeControlTransaction(stub.pool)
    await tx(async (c) => { await c.query('SELECT 1') })
    const sqls = stub.calls.map(c => c.sql)
    expect(sqls.some(s => /SET LOCAL/.test(s))).toBe(false)
    expect(sqls).toContain('BEGIN')
    expect(sqls).toContain('COMMIT')
  })
})
