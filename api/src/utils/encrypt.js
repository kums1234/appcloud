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

// Sentinel thrown when ciphertext is shaped correctly (iv:tag:ct) but the GCM
// auth tag fails to verify. Distinguishes a real decryption failure (wrong key,
// corrupted ciphertext) from a plaintext pass-through. Callers can catch this
// to decide whether to surface, redact, or fail loud — but they must NOT
// silently treat the original ciphertext as plaintext (the previous behaviour
// quietly handed `iv:tag:ct` hex strings to cloud SDKs as if they were keys).
export class DecryptionError extends Error {
  constructor(message, cause) {
    super(message)
    this.name  = 'DecryptionError'
    this.cause = cause
  }
}

export function decrypt(encoded) {
  if (!encoded) return encoded
  // Pass-through for non-encrypted shapes — legacy plaintext rows + simple
  // strings that never went through encrypt(). The `iv:tag:ct` triple is the
  // only thing we treat as ciphertext.
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
  } catch (err) {
    throw new DecryptionError(
      `decrypt: auth tag mismatch or corrupt ciphertext (${err.message})`,
      err,
    )
  }
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

// Decrypt every known-secret field in a config blob. On a per-field decryption
// failure (wrong key, corrupt row), the field is replaced with `null` and the
// failure is recorded under a `__decryptErrors` array so the caller can surface
// the problem to the user / log / metrics rather than silently handing
// ciphertext to a downstream cloud SDK.
export function decryptConfig(config) {
  if (!config || typeof config !== 'object') return config
  const out = { ...config }
  const errors = []
  for (const field of SECRET_FIELDS) {
    if (out[field]) {
      try {
        out[field] = decrypt(out[field])
      } catch (err) {
        if (err instanceof DecryptionError) {
          errors.push({ field, message: err.message })
          out[field] = null
        } else {
          throw err
        }
      }
    }
  }
  if (errors.length) out.__decryptErrors = errors
  return out
}
