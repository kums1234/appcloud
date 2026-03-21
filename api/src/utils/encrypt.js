// utils/encrypt.js
// AES-256-GCM encryption for secrets stored in the graph/database.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'
import fs from 'fs'

const ALGO   = 'aes-256-gcm'
const IV_LEN = 16
const KEY_LEN = 32

function deriveKey() {
  const filePath = process.env.JWT_SECRET_FILE
  let raw = ''
  if (filePath) {
    try { raw = fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  if (!raw) raw = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || 'appcloud-dev-key-change-in-prod'
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

const SECRET_FIELDS = ['secretAccessKey', 'secretKey', 'clientSecret', 'private_key']

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
