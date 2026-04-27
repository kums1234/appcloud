import { describe, test, expect } from '@jest/globals'
import {
  generateKey,
  hashKey,
  prefixOf,
  safeHashEqual,
  normaliseScopes,
  hasScope,
  SCOPES,
} from '../api-keys.js'

describe('generateKey', () => {
  test('produces a key with the ak_ prefix and ≥ 32 bytes of entropy', () => {
    const k = generateKey()
    expect(k.startsWith('ak_')).toBe(true)
    // base64url of 32 bytes = 43 chars; +3 for prefix = 46 total
    expect(k.length).toBeGreaterThanOrEqual(46)
    expect(k.length).toBeLessThanOrEqual(46)
  })

  test('successive calls return distinct keys', () => {
    const seen = new Set()
    for (let i = 0; i < 1000; i++) seen.add(generateKey())
    expect(seen.size).toBe(1000)
  })
})

describe('hashKey', () => {
  test('is deterministic for the same input', () => {
    expect(hashKey('hello')).toBe(hashKey('hello'))
  })

  test('produces a 64-char hex string', () => {
    const h = hashKey('anything')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  test('throws on empty / non-string input', () => {
    expect(() => hashKey('')).toThrow()
    expect(() => hashKey(null)).toThrow()
    expect(() => hashKey(undefined)).toThrow()
  })
})

describe('prefixOf', () => {
  test('returns the first 12 chars', () => {
    const k = 'ak_abcdefghijklmnop'
    expect(prefixOf(k)).toBe('ak_abcdefghi')
    expect(prefixOf(k).length).toBe(12)
  })
})

describe('safeHashEqual', () => {
  test('matches identical hex strings', () => {
    const h = hashKey('test')
    expect(safeHashEqual(h, h)).toBe(true)
  })

  test('rejects different hashes', () => {
    expect(safeHashEqual(hashKey('a'), hashKey('b'))).toBe(false)
  })

  test('rejects on length mismatch without throwing', () => {
    expect(safeHashEqual('abc', 'abcdef')).toBe(false)
  })

  test('rejects non-strings', () => {
    expect(safeHashEqual(null, 'a')).toBe(false)
    expect(safeHashEqual('a', undefined)).toBe(false)
  })
})

describe('normaliseScopes', () => {
  test('lower-cases, deduplicates, and orders by descending privilege', () => {
    expect(normaliseScopes(['Read', 'WRITE', 'read'])).toEqual(['write', 'read'])
    expect(normaliseScopes(['admin', 'read'])).toEqual(['admin', 'read'])
  })

  test('rejects unknown scopes', () => {
    expect(() => normaliseScopes(['superuser'])).toThrow(/unknown scope/i)
    expect(() => normaliseScopes(['admin', 'evil'])).toThrow(/unknown scope/i)
  })

  test('rejects empty / non-array input', () => {
    expect(() => normaliseScopes([])).toThrow()
    expect(() => normaliseScopes(null)).toThrow()
    expect(() => normaliseScopes('admin')).toThrow()
  })
})

describe('hasScope (hierarchy)', () => {
  test('super-admin grants everything including admin', () => {
    const granted = ['super-admin']
    expect(hasScope(granted, SCOPES.SUPER_ADMIN)).toBe(true)
    expect(hasScope(granted, SCOPES.ADMIN)).toBe(true)
    expect(hasScope(granted, SCOPES.WRITE)).toBe(true)
    expect(hasScope(granted, SCOPES.READ)).toBe(true)
  })

  test('admin does not grant super-admin', () => {
    expect(hasScope(['admin'], SCOPES.SUPER_ADMIN)).toBe(false)
  })

  test('admin grants everything', () => {
    const granted = ['admin']
    expect(hasScope(granted, SCOPES.ADMIN)).toBe(true)
    expect(hasScope(granted, SCOPES.WRITE)).toBe(true)
    expect(hasScope(granted, SCOPES.READ)).toBe(true)
  })

  test('write grants read but not admin', () => {
    const granted = ['write']
    expect(hasScope(granted, SCOPES.ADMIN)).toBe(false)
    expect(hasScope(granted, SCOPES.WRITE)).toBe(true)
    expect(hasScope(granted, SCOPES.READ)).toBe(true)
  })

  test('read grants only read', () => {
    const granted = ['read']
    expect(hasScope(granted, SCOPES.ADMIN)).toBe(false)
    expect(hasScope(granted, SCOPES.WRITE)).toBe(false)
    expect(hasScope(granted, SCOPES.READ)).toBe(true)
  })

  test('multi-scope grants all that any single scope grants', () => {
    expect(hasScope(['read', 'write'], SCOPES.WRITE)).toBe(true)
    expect(hasScope(['read', 'write'], SCOPES.ADMIN)).toBe(false)
  })

  test('throws on unknown required scope', () => {
    expect(() => hasScope(['admin'], 'nonsense')).toThrow()
  })
})
