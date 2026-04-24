// utils/encrypt.js
// AES-256-GCM encryption for secrets stored in the graph/database.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'
import fs from 'fs'

const ALGO   = 'aes-256-gcm'
const IV_LEN = 16
const KEY_LEN = 32

function deriveKey() {
  const filePath = process.env.APPCLOUD_ENCRYPTION_KEY_FILE
  let raw = ''
  if (filePath) {
    try { raw = fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  // Preferred: APPCLOUD_ENCRYPTION_KEY. Legacy fallbacks (ENCRYPTION_KEY,
  // JWT_SECRET) keep existing encrypted rows in local dev DBs decryptable
  // during the refocus migration.
  if (!raw) {
    raw = process.env.APPCLOUD_ENCRYPTION_KEY
      || process.env.ENCRYPTION_KEY
      || process.env.JWT_SECRET
      || 'appcloud-dev-key-change-in-prod'
  }
  return createHash('sha256').update(raw).digest()
}

export function encrypt(plaintext) {
  if (!plaintext) return plaintext
  const key = deriveKey()
  const iv  = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(encoded) {
  if (!encoded) return encoded
  if (!encoded.includes(':')) return encoded
  const parts = encoded.split(':')
  if (parts.length !== 3) return encoded
  const [ivHex, tagHex, ctHex] = parts
  try {
    const key     = deriveKey()
    const iv      = Buffer.from(ivHex,  'hex')
    const tag     = Buffer.from(tagHex, 'hex')
    const ct      = Buffer.from(ctHex,  'hex')
    const decipher = createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8')
  } catch { return encoded }
}

// Fields whose values are encrypted at rest in the `config` JSONB column of
// cloud_accounts / integrations. Extend this list when a new connector adds
// an auth-bearing field. Keep names camelCase to match the JSON-config style
// used across route handlers.
const SECRET_FIELDS = [
  // ── Cloud provider credentials (legacy, still used by cloud_accounts) ──
  'secretAccessKey', 'secretKey', 'clientSecret', 'private_key',
  // ── Generic API auth (APM vendors, OpenTofu/Terraform managers, …) ──
  'apiKey', 'apiToken', 'token', 'bearerToken', 'accessToken',
  'personalAccessToken',
  // ── Object-store backends (Terraform/OpenTofu remote state) ──
  'storageAccountKey', 'accountKey', 'sasToken',
  // ── Service accounts ──
  'serviceAccountJson',
  // ── Consul ──
  'consulToken',
  // ── HTTP / Postgres backends and future use ──
  'password',
  // ── OTel ingest (per-integration bearer) ──
  'otelTenantToken',
]

export function encryptConfig(config) {
  if (!config || typeof config !== 'object') return config
  const out = { ...config }
  for (const field of SECRET_FIELDS) {
    if (out[field]) out[field] = encrypt(out[field])
  }
  return out
}

export function decryptConfig(config) {
  if (!config || typeof config !== 'object') return config
  const out = { ...config }
  for (const field of SECRET_FIELDS) {
    if (out[field]) {
      try { out[field] = decrypt(out[field]) } catch {}
    }
  }
  return out
}
