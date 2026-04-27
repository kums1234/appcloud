// utils/encrypt.js
// AES-256-GCM encryption for secrets stored in the graph/database.
//
// ── Two-tier KDF (master + per-row) ──────────────────────────────────────────
// 1. **Master key** is derived ONCE per process from the passphrase
//    (APPCLOUD_ENCRYPTION_KEY{,_FILE}) using scrypt — memory-hard,
//    GPU-resistant, ~50ms. The master is cached so the cost is only paid at
//    first use.
// 2. **Row key** is derived per encrypt/decrypt via HKDF-SHA-256 over the
//    master key plus a fresh random salt stored in each ciphertext.
//    HKDF is microseconds; safe because the input keying material (the
//    master) is already a 256-bit pseudo-random value.
//
// Per-row salts give us two things over a single application-wide salt:
//   - distinct derived keys per row, so a leak of one decrypted row doesn't
//     give the attacker a key that decrypts the rest;
//   - smoother key-rotation story for future multi-tenant work — each
//     tenant could carry its own salt without re-encrypting other tenants.
//
// ── Ciphertext format ────────────────────────────────────────────────────────
// New (v3, this commit):  `salt:iv:tag:ct`  (4 hex parts)
// Legacy v2 (slice 2):    `iv:tag:ct`       (3 hex parts) — decrypts via
//                                            the master key directly, kept
//                                            so any rows written between
//                                            slice 2 and this commit still
//                                            read.
// Legacy v1 (pre-slice-2, SHA-256 KDF) is no longer decryptable; surfaces
// as DecryptionError → null in decryptConfig.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, hkdfSync } from 'crypto'
import fs from 'fs'

const ALGO    = 'aes-256-gcm'
const IV_LEN  = 12
const KEY_LEN = 32
const SALT_LEN = 16  // 128 bits — well above the HKDF spec minimum

// scrypt cost parameters. N=2^14 is the OWASP-acceptable lower bound; r=8 and
// p=1 are the standard scrypt parameters. maxmem is sized for ~32 MB so this
// works on small dev containers without bumping into Node's default cap.
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

// HKDF context — a fixed string distinguishing this key-use from any other
// HKDF outputs we might add later. Bumping the version invalidates existing
// row keys, just like rotating the passphrase does.
const HKDF_INFO = Buffer.from('appcloud-row-encryption-key-v1', 'utf8')

// Master-salt source. Public; its job is to prevent rainbow-table reuse
// against the master scrypt, not to be a secret. Override via
// APPCLOUD_KDF_SALT only when re-keying the whole DB.
function readMasterSalt() {
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

// ── Master-key cache ────────────────────────────────────────────────────────
// Keyed on (passphrase, masterSalt). Invalidates when either changes (e.g.
// tests that flip env vars). The cache is critical: without it, every
// encrypt/decrypt call would pay scrypt's ~50ms, blowing up cloud-account
// reads (~5s for 100 accounts).
let cachedMaster     = null
let cachedRaw        = null
let cachedMasterSalt = null

function getMasterKey() {
  const raw  = readRawKey()
  const salt = readMasterSalt()
  if (cachedMaster && cachedRaw === raw && Buffer.compare(cachedMasterSalt, salt) === 0) {
    return cachedMaster
  }
  cachedMaster     = scryptSync(raw, salt, KEY_LEN, SCRYPT_PARAMS)
  cachedRaw        = raw
  cachedMasterSalt = salt
  return cachedMaster
}

// Derive a master key from an explicit raw passphrase. Used by the
// rotation CLI to hold two master keys at once (the old one for
// decrypting existing rows, the new one for re-encrypting them) without
// having to swap env vars and bust the module-global cache mid-run.
// NOT cached — the CLI runs once and exits, so the scrypt cost is only
// paid twice (once per key).
function deriveMasterKeyFromRaw(rawKey) {
  return scryptSync(rawKey, readMasterSalt(), KEY_LEN, SCRYPT_PARAMS)
}

// HKDF: extract-and-expand. Fast (microseconds) — safe because the master
// is already a high-entropy 256-bit value; HKDF is just a domain separator.
function deriveRowKey(rowSalt) {
  const master = getMasterKey()
  return Buffer.from(hkdfSync('sha256', master, rowSalt, HKDF_INFO, KEY_LEN))
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

// Internal: encrypt using a pre-derived master key (the env-derived one
// or one supplied by the rotation CLI).
function encryptWithMaster(plaintext, master) {
  if (!plaintext) return plaintext
  const salt   = randomBytes(SALT_LEN)
  const iv     = randomBytes(IV_LEN)
  const key    = Buffer.from(hkdfSync('sha256', master, salt, HKDF_INFO, KEY_LEN))
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    salt.toString('hex'),
    iv.toString('hex'),
    tag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':')
}

export function encrypt(plaintext) {
  return encryptWithMaster(plaintext, getMasterKey())
}

// Encrypt with an explicit raw passphrase rather than the env-derived
// master. Used by the rotation CLI; production callers should use
// encrypt(). The raw passphrase is scrypt'd inline — slow (~50ms), but
// the CLI runs offline so this isn't a hot-path concern.
export function encryptWithKey(plaintext, rawKey) {
  return encryptWithMaster(plaintext, deriveMasterKeyFromRaw(rawKey))
}

// Sentinel thrown when ciphertext is shaped correctly but auth-tag verify
// fails (wrong key, corrupted ciphertext). Distinguishes a real decryption
// failure from a plaintext pass-through.
export class DecryptionError extends Error {
  constructor(message, cause) {
    super(message)
    this.name  = 'DecryptionError'
    this.cause = cause
  }
}

function decryptWithMaster(encoded, master) {
  if (!encoded) return encoded
  // Pass-through for non-encrypted shapes — legacy plaintext rows + simple
  // strings that never went through encrypt().
  if (!encoded.includes(':')) return encoded
  const parts = encoded.split(':')

  let saltHex, ivHex, tagHex, ctHex
  let key
  try {
    if (parts.length === 4) {
      // v3 — per-row salt + HKDF-derived key.
      [saltHex, ivHex, tagHex, ctHex] = parts
      const rowSalt = Buffer.from(saltHex, 'hex')
      if (rowSalt.length !== SALT_LEN) return encoded   // shape doesn't match
      key = Buffer.from(hkdfSync('sha256', master, rowSalt, HKDF_INFO, KEY_LEN))
    } else if (parts.length === 3) {
      // v2 — master-key direct (slice 2 transient format).
      [ivHex, tagHex, ctHex] = parts
      key = master
    } else {
      return encoded
    }
    const iv  = Buffer.from(ivHex,  'hex')
    const tag = Buffer.from(tagHex, 'hex')
    const ct  = Buffer.from(ctHex,  'hex')
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

export function decrypt(encoded) {
  return decryptWithMaster(encoded, getMasterKey())
}

// Decrypt using an explicit raw passphrase. Used by the rotation CLI to
// read rows encrypted under the OLD key while the running process has
// the NEW key in env. See `api/scripts/rotate-encryption-key.js`.
export function decryptWithKey(encoded, rawKey) {
  return decryptWithMaster(encoded, deriveMasterKeyFromRaw(rawKey))
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
