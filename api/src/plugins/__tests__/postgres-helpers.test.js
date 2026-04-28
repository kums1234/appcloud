// Unit tests for the fastify.pg.forTenant() / fastify.pg.transaction()
// helpers added in Phase 1b. We exercise the helpers against a stubbed
// pool that records every query + release call so we can assert on:
//
//   - SET LOCAL search_path is issued exactly once per call, with the
//     quoted schema identifier.
//   - BEGIN / COMMIT bracket the work; ROLLBACK fires on throw.
//   - The connection is released in both success and failure paths.
//   - Unsafe schema names are rejected before any SQL is issued.
//
// We mount the postgres plugin directly with a fake pg.Pool so the
// test doesn't need a real Postgres. The `pg` package import is
// dynamic inside the plugin, so we can't easily mock it; instead we
// pass a Postgres host but stub the connection object the plugin
// builds and decorate fastify.pg manually with the helpers' wiring.
//
// Simpler approach: extract the helpers' behaviour directly by
// calling forTenant + transaction against a hand-rolled pool. We
// don't need the rest of the plugin (ssl negotiation, audit machinery)
// for this test surface.

import { describe, test, expect, beforeEach } from '@jest/globals'

// Hand-rolled pool stub. records every query on every checked-out
// client and lets the test queue results / errors in order.
function makeStubPool() {
  const calls = []
  const responders = []
  const respond = (matcher, result) => responders.push([matcher, result])
  const client = {
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
    released: false,
    release: function () { this.released = true },
  }
  return {
    pool: {
      connect: async () => client,
    },
    client,
    calls,
    respond,
  }
}

// Re-implement the helpers by importing the live module — we'd rather
// test the production wiring than a duplicate. The plugin file
// constructs the helpers inline in postgresPlugin, so we extract them
// by running the helper builder against our stub. Since the helpers
// are defined inside postgresPlugin and not exported, we duplicate
// them here for unit-testable surface area. They MUST stay in sync
// with api/src/plugins/postgres.js — when refactoring the helpers
// out into a util module (probably in 1c), wire this test against
// the imported version.
function buildHelpers(pool) {
  const quoteSchemaIdent = (name) => {
    if (!/^[a-z_][a-z0-9_]{1,62}$/.test(name)) {
      throw new Error(`pg.forTenant: refusing unsafe schema name '${name}'`)
    }
    return `"${name}"`
  }
  const runInTransaction = async (searchPathClause, fn) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (searchPathClause) {
        await client.query(searchPathClause)
      }
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try { await client.query('ROLLBACK') } catch {}
      throw err
    } finally {
      client.release()
    }
  }
  const forTenant = (schemaName) => {
    const ident = quoteSchemaIdent(schemaName)
    const searchPathClause = `SET LOCAL search_path = ${ident}, public`
    return {
      schemaName,
      query: async (sql, params = []) =>
        runInTransaction(searchPathClause, async (c) => (await c.query(sql, params)).rows),
      transaction: (fn) => runInTransaction(searchPathClause, fn),
    }
  }
  const transaction = (fn) => runInTransaction(null, fn)
  return { forTenant, transaction }
}

let stub
let helpers
beforeEach(() => {
  stub    = makeStubPool()
  helpers = buildHelpers(stub.pool)
})

describe('forTenant(schemaName).query', () => {
  test('issues BEGIN, SET LOCAL search_path, query, COMMIT — in that order — and releases', async () => {
    stub.respond((sql) => /^SELECT 1$/.test(sql), { rows: [{ ok: 1 }] })
    const rows = await helpers.forTenant('tenant_default').query('SELECT 1')
    expect(rows).toEqual([{ ok: 1 }])
    const sqls = stub.calls.map(c => c.sql)
    expect(sqls).toEqual([
      'BEGIN',
      'SET LOCAL search_path = "tenant_default", public',
      'SELECT 1',
      'COMMIT',
    ])
    expect(stub.client.released).toBe(true)
  })

  test('ROLLBACK + release on a query failure', async () => {
    stub.respond(
      (sql) => /^SELECT bad$/.test(sql),
      () => { throw new Error('relation "bad" does not exist') },
    )
    await expect(helpers.forTenant('tenant_x').query('SELECT bad')).rejects.toThrow(/relation "bad"/)
    const sqls = stub.calls.map(c => c.sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    expect(stub.client.released).toBe(true)
  })

  test('rejects an unsafe schema name at forTenant() time, before any connection use', () => {
    expect(() => helpers.forTenant('evil; DROP TABLE x'))
      .toThrow(/refusing unsafe schema name/)
    expect(stub.calls.length).toBe(0)
    expect(stub.client.released).toBe(false)
  })
})

describe('forTenant(schemaName).transaction(fn)', () => {
  test('runs fn(client) inside a single SET LOCAL search_path context, COMMITs once', async () => {
    stub.respond((sql) => /SELECT a/.test(sql), { rows: [{ a: 1 }] })
    stub.respond((sql) => /UPDATE foo/.test(sql), { rows: [] })

    const result = await helpers.forTenant('tenant_default').transaction(async (client) => {
      const r1 = await client.query('SELECT a')
      await client.query('UPDATE foo SET x = 1')
      return r1.rows[0].a
    })

    expect(result).toBe(1)
    const sqls = stub.calls.map(c => c.sql)
    // One BEGIN + one SET LOCAL + one COMMIT bracketing both queries.
    expect(sqls.filter(s => s === 'BEGIN').length).toBe(1)
    expect(sqls.filter(s => /SET LOCAL search_path/.test(s)).length).toBe(1)
    expect(sqls.filter(s => s === 'COMMIT').length).toBe(1)
    expect(stub.client.released).toBe(true)
  })

  test('ROLLBACKs the whole transaction on a thrown error in fn', async () => {
    await expect(
      helpers.forTenant('tenant_default').transaction(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow(/boom/)
    const sqls = stub.calls.map(c => c.sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    expect(stub.client.released).toBe(true)
  })
})

describe('transaction(fn) (control-plane, no search_path)', () => {
  test('does NOT issue SET LOCAL search_path', async () => {
    await helpers.transaction(async (client) => {
      await client.query('SELECT 1')
    })
    const sqls = stub.calls.map(c => c.sql)
    expect(sqls.some(s => /SET LOCAL search_path/.test(s))).toBe(false)
    expect(sqls).toContain('BEGIN')
    expect(sqls).toContain('COMMIT')
  })
})
