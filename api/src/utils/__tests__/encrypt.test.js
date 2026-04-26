import { describe, test, expect, beforeAll } from '@jest/globals'
import { encrypt, decrypt, encryptConfig, decryptConfig, DecryptionError } from '../encrypt.js'

beforeAll(() => {
  // Tests must be deterministic regardless of host env; override the key.
  process.env.APPCLOUD_ENCRYPTION_KEY = 'test-encrypt-key-fixed'
  delete process.env.APPCLOUD_ENCRYPTION_KEY_FILE
  delete process.env.ENCRYPTION_KEY
  delete process.env.JWT_SECRET
})

describe('encrypt/decrypt', () => {
  test('round-trip preserves plaintext', () => {
    const plain = 'hunter2-🔑-超级'
    const enc = encrypt(plain)
    expect(enc).not.toContain(plain)
    // Format: iv:tag:ciphertext, all hex
    expect(enc.split(':').length).toBe(3)
    expect(decrypt(enc)).toBe(plain)
  })

  test('empty / null inputs pass through', () => {
    expect(encrypt('')).toBe('')
    expect(encrypt(null)).toBe(null)
    expect(decrypt('')).toBe('')
    expect(decrypt(null)).toBe(null)
  })

  test('decrypt of a non-encrypted string returns input', () => {
    // Caller may pass an already-decrypted value through decrypt() on read —
    // verify it's a no-op rather than throwing.
    expect(decrypt('plain-looking-value')).toBe('plain-looking-value')
  })

  test('decrypt throws DecryptionError on auth-tag mismatch (wrong key)', () => {
    // Encrypt with the fixed test key, then swap to a different key and try to
    // decrypt. The previous behaviour silently returned the ciphertext as if
    // it were plaintext — this test locks in the new throw-on-failure contract.
    const enc = encrypt('round-trip-target')
    const previousKey = process.env.APPCLOUD_ENCRYPTION_KEY
    try {
      process.env.APPCLOUD_ENCRYPTION_KEY = 'a-different-key'
      expect(() => decrypt(enc)).toThrow(DecryptionError)
    } finally {
      process.env.APPCLOUD_ENCRYPTION_KEY = previousKey
    }
  })

  test('decrypt throws DecryptionError on corrupted ciphertext', () => {
    const enc = encrypt('round-trip-target')
    const [iv, tag, ct] = enc.split(':')
    // Flip a byte in the ciphertext — auth tag verification must fail.
    const corrupted = `${iv}:${tag}:${ct.slice(0, -2)}ff`
    expect(() => decrypt(corrupted)).toThrow(DecryptionError)
  })
})

describe('encryptConfig / decryptConfig', () => {
  test('encrypts only known secret fields, passes others through', () => {
    const input = {
      region: 'us-east-1',
      awsAccessKeyId: 'AKIA…',         // not a secret field
      secretAccessKey: 'sekret-value',  // IS a secret field
      apiToken: 'atoken',               // IS a secret field (added in commit 1)
    }
    const enc = encryptConfig(input)
    expect(enc.region).toBe('us-east-1')
    expect(enc.awsAccessKeyId).toBe('AKIA…')
    expect(enc.secretAccessKey).not.toBe('sekret-value')
    expect(enc.apiToken).not.toBe('atoken')

    const dec = decryptConfig(enc)
    expect(dec.secretAccessKey).toBe('sekret-value')
    expect(dec.apiToken).toBe('atoken')
  })

  test('otel ingest + consul + gcs secret fields are covered', () => {
    const input = {
      otelTenantToken:    'otlp_abc',
      consulToken:        'ctoken',
      serviceAccountJson: '{"foo":"bar"}',
      storageAccountKey:  'sakey',
    }
    const enc = encryptConfig(input)
    for (const k of Object.keys(input)) expect(enc[k]).not.toBe(input[k])
    expect(decryptConfig(enc)).toEqual(input)
  })

  test('undefined / non-object input is a no-op', () => {
    expect(encryptConfig(null)).toBe(null)
    expect(encryptConfig(undefined)).toBe(undefined)
    expect(decryptConfig(null)).toBe(null)
  })

  test('decryptConfig replaces undecryptable fields with null and surfaces errors', () => {
    // Encrypt with the test key, then swap the env to simulate a key rotation
    // that didn't re-encrypt the row.
    const enc = encryptConfig({
      apiToken:        'plain-token',
      secretAccessKey: 'plain-secret',
      region:          'us-east-1',
    })
    const previousKey = process.env.APPCLOUD_ENCRYPTION_KEY
    try {
      process.env.APPCLOUD_ENCRYPTION_KEY = 'rotated-and-not-backfilled'
      const dec = decryptConfig(enc)
      expect(dec.region).toBe('us-east-1')        // non-secret pass-through
      expect(dec.apiToken).toBe(null)             // undecryptable → null, not ciphertext
      expect(dec.secretAccessKey).toBe(null)
      expect(dec.__decryptErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'apiToken' }),
        expect.objectContaining({ field: 'secretAccessKey' }),
      ]))
    } finally {
      process.env.APPCLOUD_ENCRYPTION_KEY = previousKey
    }
  })
})
