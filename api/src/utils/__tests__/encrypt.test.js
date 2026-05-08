import { describe, test, expect, beforeAll } from '@jest/globals'
import { createCipheriv, randomBytes, scryptSync } from 'crypto'
import { encrypt, decrypt, encryptConfig, decryptConfig, DecryptionError, encryptWithKey, decryptWithKey } from '../encrypt.js'

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
    // v3 format: salt:iv:tag:ciphertext, all hex
    expect(enc.split(':').length).toBe(4)
    expect(decrypt(enc)).toBe(plain)
  })

  test('two encrypts of the same plaintext produce different salts', () => {
    // Per-row salts mean each ciphertext carries its own first segment.
    // Same plaintext → same passphrase → two distinct ciphertexts (and
    // distinct first segments specifically — IV would already differ in
    // GCM mode, but the salt difference is what gives us per-row keys).
    const enc1 = encrypt('same-plaintext')
    const enc2 = encrypt('same-plaintext')
    const salt1 = enc1.split(':')[0]
    const salt2 = enc2.split(':')[0]
    expect(salt1).not.toBe(salt2)
    expect(decrypt(enc1)).toBe('same-plaintext')
    expect(decrypt(enc2)).toBe('same-plaintext')
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
    const [salt, iv, tag, ct] = enc.split(':')
    // Flip a byte in the ciphertext — auth tag verification must fail.
    const corrupted = `${salt}:${iv}:${tag}:${ct.slice(0, -2)}ff`
    expect(() => decrypt(corrupted)).toThrow(DecryptionError)
  })

  test('encryptWithKey + decryptWithKey round-trip under an explicit passphrase', () => {
    // The rotation CLI uses these helpers to hold two master keys
    // simultaneously (the OLD one for decrypting existing rows, the
    // NEW one for re-encrypting them) without flipping env vars.
    const OLD_KEY = 'old-passphrase-for-rotation-test'
    const NEW_KEY = 'new-passphrase-for-rotation-test'
    const plain = 'hunter2-rotated'
    const cipherUnderOld = encryptWithKey(plain, OLD_KEY)
    expect(decryptWithKey(cipherUnderOld, OLD_KEY)).toBe(plain)
    // Decrypting under NEW must FAIL (it's a different key).
    expect(() => decryptWithKey(cipherUnderOld, NEW_KEY))
      .toThrow(DecryptionError)
    // The rotation primitive: decrypt under OLD, re-encrypt under NEW,
    // confirm only NEW reads it.
    const cipherUnderNew = encryptWithKey(decryptWithKey(cipherUnderOld, OLD_KEY), NEW_KEY)
    expect(decryptWithKey(cipherUnderNew, NEW_KEY)).toBe(plain)
    expect(() => decryptWithKey(cipherUnderNew, OLD_KEY)).toThrow(DecryptionError)
  })

  test('encryptWithKey produces v3 ciphertext shape (4 hex parts)', () => {
    // The wire format must match the env-key encrypt() so the rotation
    // CLI's output is indistinguishable from a normal encrypt() call.
    const c = encryptWithKey('payload', 'some-passphrase')
    const parts = c.split(':')
    expect(parts).toHaveLength(4)
    for (const p of parts) expect(p).toMatch(/^[0-9a-f]+$/)
  })

  test('legacy v2 ciphertext (3-part, master-key direct) still decrypts', () => {
    // Reproduce what slice-2 encrypt() would have produced: scrypt over
    // (passphrase, master_salt) keying AES-GCM directly with no row salt.
    // We construct one by hand here and verify decrypt() routes through
    // the v2 path (parts.length === 3).
    const masterSalt = Buffer.from('appcloud-kdf-salt-v1', 'utf8')
    const masterKey  = scryptSync('test-encrypt-key-fixed', masterSalt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const iv     = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
    const ct     = Buffer.concat([cipher.update('legacy-payload', 'utf8'), cipher.final()])
    const tag    = cipher.getAuthTag()
    const v2     = `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
    expect(v2.split(':').length).toBe(3)
    expect(decrypt(v2)).toBe('legacy-payload')
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
