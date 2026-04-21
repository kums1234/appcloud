import { describe, test, expect, beforeAll } from '@jest/globals'
import { encrypt, decrypt, encryptConfig, decryptConfig } from '../encrypt.js'

beforeAll(() => {
  // Tests must be deterministic regardless of host env; override the key.
  process.env.JWT_SECRET = 'test-encrypt-key-fixed'
  delete process.env.JWT_SECRET_FILE
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
})
