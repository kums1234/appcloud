// utils/api-keys.js
//
// Helpers for the api_keys table (postgres-init/10-api-keys.sql).
//
//   generateKey()            → fresh plaintext key  ('ak_<43-char base64url>')
//   hashKey(plaintext)       → hex SHA-256          (column: api_keys.key_hash)
//   prefixOf(plaintext)      → first 12 chars       (column: api_keys.key_prefix)
//   normaliseScopes(scopes)  → de-duplicated, lowercased, validated
//   hasScope(granted, need)  → true if `granted` set covers `need` per the
//                              admin > write > read hierarchy
//
// Why SHA-256 (not scrypt/argon2) for the hash: the plaintext is
// crypto.randomBytes(32) — 256 bits of entropy. There's nothing to grind
// because there's no rainbow table for 256-bit random values. A fast hash
// is what we want here; the column is read on every request.

import { createHash, randomBytes, timingSafeEqual } from 'crypto'

// Recognisable prefix so a key leaked into a log line / commit is obvious.
const KEY_PREFIX = 'ak_'
// 32 bytes of randomness encoded as base64url is 43 chars (no padding). Add
// the 'ak_' prefix and the total is 46 chars.
const RANDOM_BYTES = 32

export const SCOPES = Object.freeze({
  // super-admin is the cross-tenant scope: tenant CRUD, key issuance for
  // any tenant, cross-tenant ops queries. Keys with this scope are NOT
  // bound to a single tenant in the request flow — the tenantContext
  // preHandler resolves them differently (see plugins/tenant-context.js).
  SUPER_ADMIN: 'super-admin',
  ADMIN:       'admin',
  WRITE:       'write',
  READ:        'read',
})

const SCOPE_RANK = { 'super-admin': 4, admin: 3, write: 2, read: 1 }
const VALID_SCOPES = new Set(Object.values(SCOPES))

export function generateKey() {
  // base64url avoids the `+` / `/` / `=` chars that misbehave in URLs / shells.
  const random = randomBytes(RANDOM_BYTES).toString('base64url')
  return `${KEY_PREFIX}${random}`
}

export function hashKey(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('hashKey: plaintext must be a non-empty string')
  }
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

export function prefixOf(plaintext) {
  return String(plaintext || '').slice(0, 12)
}

// Constant-time compare for two hex hashes. We still do an indexed lookup
// upstream by hash, but a deliberate constant-time recheck means a timing
// observer can't distinguish "hash collision row was found" from "real key
// matched" — both code paths run the same number of byte compares.
export function safeHashEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false
  if (aHex.length !== bHex.length) return false
  return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'))
}

// Validate, de-duplicate, lowercase, and reject unknown scopes. Returns a
// fresh array sorted by descending rank so callers can rely on scopes[0]
// being the highest privilege held by the key.
export function normaliseScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('normaliseScopes: scopes must be a non-empty array')
  }
  const out = new Set()
  for (const raw of scopes) {
    const s = String(raw || '').toLowerCase()
    if (!VALID_SCOPES.has(s)) {
      throw new Error(`normaliseScopes: unknown scope '${raw}' (valid: ${[...VALID_SCOPES].join(', ')})`)
    }
    out.add(s)
  }
  return [...out].sort((a, b) => SCOPE_RANK[b] - SCOPE_RANK[a])
}

// True when the granted set covers the required scope. admin covers all,
// write covers read. Granted is a list (post-normaliseScopes); required is
// a single scope string.
export function hasScope(granted, required) {
  if (!Array.isArray(granted) || granted.length === 0) return false
  if (!VALID_SCOPES.has(required)) {
    throw new Error(`hasScope: unknown required scope '${required}'`)
  }
  const max = Math.max(...granted.map(s => SCOPE_RANK[s] || 0))
  return max >= (SCOPE_RANK[required] || Infinity)
}
