#!/usr/bin/env node
//
// rotate-encryption-key.js
//
// Re-encrypts every secret field in cloud_accounts + integrations from
// the OLD master key to the NEW master key. Run offline (against an
// idle DB or a maintenance-windowed one) — the running API processes
// must NOT be using the OLD key during the rotation, otherwise their
// cache of the old key would race with new writes.
//
// Inputs (env):
//   APPCLOUD_ENCRYPTION_KEY_OLD   the passphrase rows are currently encrypted under
//   APPCLOUD_ENCRYPTION_KEY       the passphrase to migrate rows to (NEW)
//   POSTGRES_HOST / POSTGRES_PORT / POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD
//                                 standard pg env, same as the API plugin
//   APPCLOUD_KDF_SALT             optional, must match what the API uses (defaults to
//                                 the built-in 'appcloud-kdf-salt-v1')
//
// Output:
//   per-row stdout summary + final {scanned, rotated, skipped, failed}.
//   Non-zero exit on any failed row.
//
// Idempotency:
//   - Already-rotated rows decrypt under NEW_KEY and re-encrypt to a
//     new ciphertext (same key, fresh salt). That's wasteful but safe;
//     re-running the CLI after a successful rotation is a no-op as far
//     as decryptability is concerned.
//   - Plaintext fields (legacy rows or fields the operator inserted by
//     hand) pass through unchanged.
//
// Operator runbook lives in `secrets_setup.md`. The short version:
//   1. Generate NEW key:    openssl rand -hex 32 > /tmp/new-key
//   2. Stop API replicas (or scale to 0)
//   3. Run this CLI:        APPCLOUD_ENCRYPTION_KEY_OLD=$old APPCLOUD_ENCRYPTION_KEY=$new node scripts/rotate-encryption-key.js
//   4. Update K8s Secret to NEW
//   5. Scale API back up; verify GET /integrations decrypts cleanly
//   6. Securely destroy OLD key

import 'dotenv/config'
import pg from 'pg'
import { encryptWithKey, decryptWithKey } from '../src/utils/encrypt.js'

const SECRET_FIELDS = [
  'secretAccessKey', 'secretKey', 'clientSecret', 'private_key',
  'apiKey', 'apiToken', 'token', 'bearerToken', 'accessToken',
  'personalAccessToken',
  'storageAccountKey', 'accountKey', 'sasToken',
  'serviceAccountJson',
  'consulToken',
  'password',
  'otelTenantToken',
]

function readEnv(name) {
  const v = (process.env[name] || '').trim()
  if (!v) {
    console.error(`[rotate] ${name} is required`)
    process.exit(2)
  }
  return v
}

const OLD_KEY = readEnv('APPCLOUD_ENCRYPTION_KEY_OLD')
const NEW_KEY = readEnv('APPCLOUD_ENCRYPTION_KEY')
if (OLD_KEY === NEW_KEY) {
  console.error('[rotate] OLD and NEW keys are identical — nothing to do. Aborting.')
  process.exit(2)
}

const pool = new pg.Pool({
  host:     process.env.POSTGRES_HOST     || 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB       || 'appcloud',
  user:     process.env.POSTGRES_USER     || 'postgres',
  password: process.env.POSTGRES_PASSWORD || '',
  max:      4,
})

// Tables to walk. Each entry: { table, idColumn, configColumn }. The
// CLI loads `id, config` per row, decrypts under OLD, re-encrypts under
// NEW, and writes back under a single-row transaction.
const TARGETS = [
  { table: 'cloud_accounts', idColumn: 'id', configColumn: 'config' },
  { table: 'integrations',   idColumn: 'id', configColumn: 'config' },
]

// Walk one row's config: re-encrypt every SECRET_FIELD that decrypts
// non-null under OLD. Returns { newConfig, fieldsRotated, errors }.
function rotateConfig(config) {
  if (!config || typeof config !== 'object') {
    return { newConfig: config, fieldsRotated: 0, errors: [] }
  }
  const out = { ...config }
  let fieldsRotated = 0
  const errors = []
  for (const field of SECRET_FIELDS) {
    const v = out[field]
    if (!v || typeof v !== 'string' || !v.includes(':')) continue   // plaintext / absent
    let plain
    try {
      plain = decryptWithKey(v, OLD_KEY)
    } catch (err) {
      errors.push({ field, stage: 'decrypt', message: err.message })
      continue
    }
    if (plain === null || plain === undefined) {
      errors.push({ field, stage: 'decrypt', message: 'returned null' })
      continue
    }
    try {
      out[field] = encryptWithKey(plain, NEW_KEY)
      fieldsRotated++
    } catch (err) {
      errors.push({ field, stage: 'encrypt', message: err.message })
    }
  }
  return { newConfig: out, fieldsRotated, errors }
}

async function rotateTable({ table, idColumn, configColumn }) {
  const summary = { scanned: 0, rotated: 0, skipped: 0, failed: 0 }
  const client = await pool.connect()
  try {
    // existence check — don't fail the whole CLI if a table is absent in
    // some deployments (e.g. fresh installs that skipped certain
    // connector tables).
    const exists = await client.query(
      `SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = current_schema()::regnamespace`,
      [table],
    )
    if (exists.rowCount === 0) {
      console.log(`[rotate] skip ${table} — table not present`)
      return summary
    }
    const rows = await client.query(`SELECT ${idColumn} AS id, ${configColumn} AS config FROM ${table}`)
    summary.scanned = rows.rowCount
    for (const r of rows.rows) {
      const { newConfig, fieldsRotated, errors } = rotateConfig(r.config)
      if (errors.length > 0) {
        console.error(`[rotate] ${table}.${r.id} — ${errors.length} field error(s):`,
          errors.map(e => `${e.field}/${e.stage}: ${e.message}`).join('; '))
        summary.failed++
        continue
      }
      if (fieldsRotated === 0) {
        summary.skipped++
        continue
      }
      // Write-back as its own transaction so a failure here doesn't
      // leave the row half-rotated (some fields under NEW, some still
      // under OLD).
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE ${table} SET ${configColumn} = $1 WHERE ${idColumn} = $2`,
          [JSON.stringify(newConfig), r.id],
        )
        await client.query('COMMIT')
        summary.rotated++
        console.log(`[rotate] ${table}.${r.id} — ${fieldsRotated} field(s) rotated`)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        console.error(`[rotate] ${table}.${r.id} — write-back failed: ${err.message}`)
        summary.failed++
      }
    }
  } finally {
    client.release()
  }
  return summary
}

async function main() {
  const totals = { scanned: 0, rotated: 0, skipped: 0, failed: 0 }
  for (const target of TARGETS) {
    console.log(`[rotate] starting ${target.table}…`)
    const s = await rotateTable(target)
    console.log(`[rotate] ${target.table} done: ${JSON.stringify(s)}`)
    totals.scanned += s.scanned
    totals.rotated += s.rotated
    totals.skipped += s.skipped
    totals.failed  += s.failed
  }
  console.log(`[rotate] TOTALS: ${JSON.stringify(totals)}`)
  await pool.end()
  process.exit(totals.failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('[rotate] fatal:', err)
  process.exit(1)
})
