// Unit tests for utils/tenant-schema-runner.js. We use real temp files
// for the migration directory (cleaner and more honest than mocking
// fs/promises through jest's unstable_mockModule, which is fragile in
// ESM mode) and a stub pg client that records query calls.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  applyMigrations,
  provisionTenantSchema,
  listMigrationFiles,
  ensureSchemaMigrationsTable,
} from '../tenant-schema-runner.js'

// Stub client. Records every query in `calls`. Keyed responses fed via
// `respond(matcher, result)` — first matching matcher wins; falls
// through to an empty `{ rows: [] }`.
function makeStubClient() {
  const calls = []
  const responders = []
  const client = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params })
      for (const [matcher, result] of responders) {
        if (matcher(sql, params)) {
          if (typeof result === 'function') return result(sql, params)
          return result
        }
      }
      return { rows: [] }
    },
    respond: (matcher, result) => responders.push([matcher, result]),
  }
  return client
}

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex')

let tmpDir
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'appcloud-runner-'))
})
afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeMigration(filename, content) {
  await fs.writeFile(path.join(tmpDir, filename), content, 'utf8')
}

describe('listMigrationFiles', () => {
  test('returns .sql files sorted lexically', async () => {
    await writeMigration('002-second.sql', '-- second')
    await writeMigration('001-first.sql',  '-- first')
    await writeMigration('readme.md',      'not a migration')
    await writeMigration('.hidden.sql',    '-- hidden')
    const out = await listMigrationFiles(tmpDir)
    expect(out).toEqual(['001-first.sql', '002-second.sql'])
  })

  test('returns [] when the directory does not exist', async () => {
    const out = await listMigrationFiles(path.join(tmpDir, 'nonexistent'))
    expect(out).toEqual([])
  })
})

describe('ensureSchemaMigrationsTable', () => {
  test('runs idempotent CREATE SCHEMA + CREATE TABLE', async () => {
    const calls = []
    const pg = { query: async (sql, params) => { calls.push({ sql, params }); return [] } }
    await ensureSchemaMigrationsTable(pg)
    expect(calls.length).toBe(1)
    expect(calls[0].sql).toMatch(/CREATE SCHEMA IF NOT EXISTS control/)
    expect(calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS control\.schema_migrations/)
  })
})

describe('applyMigrations', () => {
  test('applies a fresh migration: SET search_path, run DDL, INSERT row', async () => {
    await writeMigration('001-base.sql', 'CREATE TABLE foo (id UUID);')
    const client = makeStubClient()
    client.respond(
      (sql) => /SELECT sha256 FROM control\.schema_migrations/.test(sql),
      { rows: [] },
    )

    const applied = await applyMigrations({
      client, schemaName: 'tenant_abc', migrationsDir: tmpDir,
    })

    expect(applied).toEqual(['001-base.sql'])
    const sqls = client.calls.map(c => c.sql.replace(/\s+/g, ' ').trim())
    expect(sqls[0]).toMatch(/SET LOCAL search_path = "tenant_abc", public/)
    expect(sqls[1]).toMatch(/SELECT sha256 FROM control\.schema_migrations/)
    expect(sqls[2]).toMatch(/CREATE TABLE foo/)
    expect(sqls[3]).toMatch(/INSERT INTO control\.schema_migrations/)
  })

  test('skips a migration whose sha matches the recorded one', async () => {
    const content = 'CREATE TABLE foo (id UUID);'
    await writeMigration('001-base.sql', content)
    const sha = sha256Hex(content)

    const client = makeStubClient()
    client.respond(
      (sql) => /SELECT sha256 FROM control\.schema_migrations/.test(sql),
      { rows: [{ sha256: sha }] },
    )

    const applied = await applyMigrations({
      client, schemaName: 'tenant_abc', migrationsDir: tmpDir,
    })
    expect(applied).toEqual([])
    const sqls = client.calls.map(c => c.sql)
    expect(sqls.some(s => /CREATE TABLE foo/.test(s))).toBe(false)
    expect(sqls.some(s => /INSERT INTO control\.schema_migrations/.test(s))).toBe(false)
  })

  test('throws when the recorded sha differs from the file sha', async () => {
    await writeMigration('001-base.sql', 'CREATE TABLE foo (id UUID);')
    const client = makeStubClient()
    client.respond(
      (sql) => /SELECT sha256 FROM control\.schema_migrations/.test(sql),
      { rows: [{ sha256: 'something-else-entirely' }] },
    )
    await expect(applyMigrations({
      client, schemaName: 'tenant_abc', migrationsDir: tmpDir,
    })).rejects.toThrow(/different sha256/)
  })

  test('refuses an unsafe schema name', async () => {
    await expect(applyMigrations({
      client: makeStubClient(), schemaName: 'evil; DROP TABLE x;', migrationsDir: tmpDir,
    })).rejects.toThrow(/refusing unsafe schema name/)
  })

  test('wraps file failures with the filename in the error', async () => {
    await writeMigration('001-bad.sql', 'CREATE TABLE bad syntax')
    const client = makeStubClient()
    client.respond(
      (sql) => /SELECT sha256 FROM control\.schema_migrations/.test(sql),
      { rows: [] },
    )
    client.respond(
      (sql) => /CREATE TABLE bad syntax/.test(sql),
      () => { throw new Error('syntax error at "syntax"') },
    )
    await expect(applyMigrations({
      client, schemaName: 'tenant_abc', migrationsDir: tmpDir,
    })).rejects.toThrow(/001-bad\.sql.*syntax error/)
  })

  test('applies multiple files in lexical order, skipping already-applied', async () => {
    await writeMigration('001-a.sql', 'CREATE TABLE a (id UUID);')
    await writeMigration('002-b.sql', 'CREATE TABLE b (id UUID);')
    const aSha = sha256Hex('CREATE TABLE a (id UUID);')

    const client = makeStubClient()
    // 001 already applied; 002 not yet.
    let lookupCalls = 0
    client.respond(
      (sql) => /SELECT sha256 FROM control\.schema_migrations/.test(sql),
      () => {
        lookupCalls += 1
        return lookupCalls === 1 ? { rows: [{ sha256: aSha }] } : { rows: [] }
      },
    )

    const applied = await applyMigrations({
      client, schemaName: 'tenant_abc', migrationsDir: tmpDir,
    })
    expect(applied).toEqual(['002-b.sql'])
    const sqls = client.calls.map(c => c.sql)
    expect(sqls.some(s => /CREATE TABLE a/.test(s))).toBe(false)
    expect(sqls.some(s => /CREATE TABLE b/.test(s))).toBe(true)
  })
})

describe('provisionTenantSchema', () => {
  test('creates the schema then runs migrations when schema does not exist', async () => {
    await writeMigration('001-base.sql', 'CREATE TABLE foo (id UUID);')
    const client = makeStubClient()
    client.respond(
      (sql) => /FROM information_schema\.schemata/.test(sql),
      { rows: [] },
    )
    client.respond(
      (sql) => /SELECT sha256 FROM control\.schema_migrations/.test(sql),
      { rows: [] },
    )

    await provisionTenantSchema({
      client, schemaName: 'tenant_xyz', migrationsDir: tmpDir,
    })

    const sqls = client.calls.map(c => c.sql)
    expect(sqls.some(s => /^CREATE SCHEMA "tenant_xyz"/.test(s))).toBe(true)
    expect(sqls.some(s => /CREATE TABLE foo/.test(s))).toBe(true)
  })

  test('skips CREATE SCHEMA when the schema already exists', async () => {
    await writeMigration('001-base.sql', 'CREATE TABLE foo (id UUID);')
    const client = makeStubClient()
    client.respond(
      (sql) => /FROM information_schema\.schemata/.test(sql),
      { rows: [{}] },
    )
    client.respond(
      (sql) => /SELECT sha256 FROM control\.schema_migrations/.test(sql),
      { rows: [] },
    )
    await provisionTenantSchema({
      client, schemaName: 'tenant_xyz', migrationsDir: tmpDir,
    })
    const sqls = client.calls.map(c => c.sql)
    expect(sqls.some(s => /^CREATE SCHEMA/.test(s))).toBe(false)
    expect(sqls.some(s => /CREATE TABLE foo/.test(s))).toBe(true)
  })

  test('refuses an unsafe schema name', async () => {
    await expect(provisionTenantSchema({
      client: makeStubClient(), schemaName: '"; SELECT 1', migrationsDir: tmpDir,
    })).rejects.toThrow(/refusing unsafe schema name/)
  })
})
