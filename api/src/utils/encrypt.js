// utils/encrypt.js
// AES-256-GCM encryption for secrets stored in the graph/database.
//
// Key derivation: scrypt (memory-hard) over the passphrase from
// APPCLOUD_ENCRYPTION_KEY_FILE / APPCLOUD_ENCRYPTION_KEY plus a fixed salt
// (APPCLOUD_KDF_SALT, with a documented fallback). The previous build used
// bare SHA-256, which is GPU-grindable at ~10B/sec — a weak passphrase could
// be brute-forced in seconds. scrypt with N=2^14, r=8, p=1 makes the same
// attack ~10⁵× slower and dominates with memory bandwidth, neutering most
// commodity GPU rigs.
//
// IV length: 12 bytes (96 bits — the GCM-spec recommendation). Earlier rows
// were encrypted with 16-byte IVs; decrypt() works with both because the IV
// length is read from the stored payload.
//
// Migration impact: existing rows encrypted under the old SHA-256 KDF will
// no longer decrypt and will surface as DecryptionError → null in
// decryptConfig (with __decryptErrors set so the caller can warn the user).
// Pre-customer this is acceptable; re-seed cloud accounts after rotating.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import fs from 'fs'

const ALGO   = 'aes-256-gcm'
const IV_LEN = 12
const KEY_LEN = 32

// scrypt cost parameters. N=2^14 is the OWASP-acceptable lower bound; r=8 and
// p=1 are the standard scrypt parameters. maxmem is sized for ~32 MB so this
// works on small dev containers without bumping into Node's default cap.
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

// Salt is application-public. Its job is to prevent rainbow-table reuse, not
// to be a secret. Override via APPCLOUD_KDF_SALT only when re-keying — a
// changed salt invalidates every existing ciphertext, just like changing the
// passphrase does.
function readSalt() {
  return Buffer.from(process.env.APPCLOUD_KDF_SALT || 'appcloud-kdf-salt-v1', 'utf8')
}

function readRawKey() {
  const filePath = process.env.APPCLOUD_ENCRYPTION_KEY_FILE
  if (filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8').trim()
      if (raw) return raw
    } catch {}
  }
  const fromEnv = (process.env.APPCLOUD_ENCRYPTION_KEY || '').trim()
  if (fromEnv) return fromEnv
  // The previous build silently fell back to ENCRYPTION_KEY / JWT_SECRET /
  // 'appcloud-dev-key-change-in-prod'. Each of those quietly extended the
  // attack surface (re-using a JWT signing secret as a crypto key, or
  // baking a known weak default into prod). Fail loud instead.
  throw new Error(
    'APPCLOUD_ENCRYPTION_KEY (or APPCLOUD_ENCRYPTION_KEY_FILE) is not set. ' +
    'Generate one with `openssl rand -hex 32` and put it in .env.local for dev ' +
    'or as a docker / k8s secret in prod.',
  )
}

// Cache the derived key so we don't pay the ~50 ms scrypt cost on every
// encrypt/decrypt call. Invalidates if the passphrase changes between calls
// (e.g. tests that flip the env var).
let cachedKey = null
let cachedRaw = null
let cachedSalt = null

function deriveKey() {
  const raw  = readRawKey()
  const salt = readSalt()
  if (cachedKey && cachedRaw === raw && Buffer.compare(cachedSalt, salt) === 0) {
    return cachedKey
  }
  cachedKey  = scryptSync(raw, salt, KEY_LEN, SCRYPT_PARAMS)
  cachedRaw  = raw
  cachedSalt = salt
  return cachedKey
}

// One-time startup notice — surface that the legacy fallback envs are
// ignored, so anyone who relied on them sees the breakage immediately.
let warnedLegacy = false
export function warnIfLegacyKeyEnvSet(log) {
  if (warnedLegacy) return
  warnedLegacy = true
  for (const legacy of ['ENCRYPTION_KEY', 'JWT_SECRET']) {
    if (process.env[legacy]) {
      log?.warn?.(
        `[encrypt] ${legacy} is set but ignored — encryption now requires APPCLOUD_ENCRYPTION_KEY ` +
        `(or APPCLOUD_ENCRYPTION_KEY_FILE). Set the new var and re-seed any rows that fail to decrypt.`,
      )
    }
  }
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
