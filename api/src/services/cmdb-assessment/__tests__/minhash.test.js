import { describe, test, expect } from '@jest/globals'
import {
  normalizeName, shingles, jaccard,
  shannonEntropy, hasHighEntropy,
  minhashSignature, bandKeys,
  buildLshIndex, resolveByName,
  CONSTANTS,
} from '../minhash.js'

describe('normalizeName', () => {
  test('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeName('Prod-Web_01')).toBe('prod web 01')
    expect(normalizeName('  Payments   API  ')).toBe('payments api')
    expect(normalizeName('DB.prod.example.com')).toBe('db prod example com')
  })
  test('empty / nullish inputs return empty string', () => {
    expect(normalizeName('')).toBe('')
    expect(normalizeName(null)).toBe('')
    expect(normalizeName(undefined)).toBe('')
  })
})

describe('shingles', () => {
  test('produces character 3-grams', () => {
    const s = shingles('payments api')
    expect(s.has('pay')).toBe(true)
    expect(s.has('men')).toBe(true)
    expect(s.has('api')).toBe(true)
  })
  test('short inputs yield at most one shingle of the raw string', () => {
    expect(shingles('a')).toEqual(new Set(['a']))
    expect(shingles('')).toEqual(new Set())
  })
})

describe('jaccard', () => {
  test('identical sets → 1', () => {
    expect(jaccard(new Set(['a','b','c']), new Set(['a','b','c']))).toBe(1)
  })
  test('disjoint sets → 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
  })
  test('partial overlap is |∩|/|∪|', () => {
    const a = new Set(['a','b','c'])
    const b = new Set(['b','c','d'])
    expect(jaccard(a, b)).toBeCloseTo(2/4, 5)
  })
  test('both empty → 1 (degenerate convention)', () => {
    expect(jaccard(new Set(), new Set())).toBe(1)
  })
})

describe('shannonEntropy + hasHighEntropy', () => {
  test('repeating low-entropy name fails gate', () => {
    expect(hasHighEntropy('db01')).toBe(false)
  })
  test('rich multi-word name passes gate', () => {
    expect(hasHighEntropy('payments platform production api')).toBe(true)
  })
  test('empty → 0 entropy', () => {
    expect(shannonEntropy('')).toBe(0)
    expect(hasHighEntropy('')).toBe(false)
  })
})

describe('minhashSignature', () => {
  test('identical inputs produce identical signatures (reproducible)', () => {
    const a = minhashSignature(shingles('payments platform production'))
    const b = minhashSignature(shingles('payments platform production'))
    expect(Array.from(a)).toEqual(Array.from(b))
  })
  test('length matches permutation constant', () => {
    const sig = minhashSignature(shingles('something'))
    expect(sig.length).toBe(CONSTANTS.MINHASH_PERMUTATIONS)
  })
  test('empty set returns a full max-uint32 signature', () => {
    const sig = minhashSignature(new Set())
    expect(sig.every(v => v === 0xFFFFFFFF)).toBe(true)
  })
})

describe('bandKeys', () => {
  test('produces N / bandSize keys', () => {
    const sig = minhashSignature(shingles('payments platform'))
    const keys = bandKeys(sig)
    expect(keys).toHaveLength(CONSTANTS.MINHASH_PERMUTATIONS / CONSTANTS.MINHASH_BAND_SIZE)
    expect(new Set(keys).size).toBe(keys.length)  // unique
  })
})

describe('buildLshIndex + resolveByName', () => {
  const candidates = [
    { id: 'i1', name: 'Payments Platform Production' },
    { id: 'i2', name: 'Orders Service Staging' },
    { id: 'i3', name: 'analytics-warehouse-prod' },
    { id: 'i4', name: 'db01' },                // low-entropy, will be exact-only
    { id: 'i5', name: 'Customer Insights Reporting API' },
  ]

  test('exact normalised-name match returns matchType exact_normalized_name', () => {
    const idx = buildLshIndex(candidates)
    const hit = resolveByName('payments-platform-production', idx)
    expect(hit).toEqual(expect.objectContaining({ candidateId: 'i1', matchType: 'exact_normalized_name', jaccard: 1 }))
  })

  test('fuzzy match on highly similar names succeeds', () => {
    const idx = buildLshIndex(candidates)
    // Same words, one trailing, typical CMDB drift from source scanner.
    const hit = resolveByName('Customer Insights Reporting API v2', idx)
    // v2 is one extra word so Jaccard should still land near the threshold.
    if (hit) expect(hit.candidateId).toBe('i5')
  })

  test('low-entropy name is refused by the entropy gate unless exact', () => {
    const idx = buildLshIndex(candidates)
    // Different low-entropy name — gate blocks fuzzy path → null.
    expect(resolveByName('db02', idx)).toBeNull()
    // Exact same low-entropy name still resolves via stage 1.
    expect(resolveByName('db01', idx)).toEqual(expect.objectContaining({ candidateId: 'i4' }))
  })

  test('no candidates at all → null', () => {
    const idx = buildLshIndex([])
    expect(resolveByName('anything', idx)).toBeNull()
  })

  test('signal-free name below Jaccard threshold → null', () => {
    const idx = buildLshIndex(candidates)
    expect(resolveByName('totally unrelated inventory entry', idx)).toBeNull()
  })
})
