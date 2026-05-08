import { describe, test, expect } from '@jest/globals'
import { scoreRelevance, scoreQuality, daysBetween, SCORING } from '../scoring.js'

describe('scoreRelevance', () => {
  test('exact cloud_id match + recent OTel → high score', () => {
    const r = scoreRelevance({
      match: { matchType: 'exact_cloud_id', confidence: 95 },
      hasOtelActivity: true,
      otelActivityDays: 2,
    })
    expect(r.score).toBe(100)   // 95 + 15 clamped
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/exact_cloud_id/)]))
  })

  test('fuzzy_name match alone → moderate score', () => {
    const r = scoreRelevance({
      match: { matchType: 'fuzzy_name', confidence: 70 },
      hasOtelActivity: false,
    })
    expect(r.score).toBe(70)
  })

  test('no match, no telemetry → 0 with a reason', () => {
    const r = scoreRelevance({ match: null, hasOtelActivity: false })
    expect(r.score).toBe(0)
    expect(r.reasons).toEqual(['no match in any source'])
  })

  test('otel age bucketing: 7–30 days → +5', () => {
    const r = scoreRelevance({
      match: null,
      hasOtelActivity: true,
      otelActivityDays: 15,
    })
    expect(r.score).toBe(5)
  })

  test('clamps above 100', () => {
    const r = scoreRelevance({
      match: { matchType: 'exact_cloud_id', confidence: 95 },
      hasOtelActivity: true,
      otelActivityDays: 1,
    })
    expect(r.score).toBeLessThanOrEqual(100)
  })
})

describe('scoreQuality', () => {
  const goodCi = {
    owned_by:           'team-payments',
    environment:        'production',
    operational_status: 'operational',
    support_group:      'payments-oncall',
  }

  test('complete fresh record → 100', () => {
    const r = scoreQuality(goodCi, { updatedAgeDays: 2 })
    expect(r.score).toBe(100)
  })

  test('one missing field → -15', () => {
    const ci = { ...goodCi, support_group: null }
    const r = scoreQuality(ci, { updatedAgeDays: 2 })
    expect(r.score).toBe(85)
    expect(r.reasons.join(' ')).toMatch(/support_group/)
  })

  test('all fields missing → -60 (capped)', () => {
    const r = scoreQuality({}, { updatedAgeDays: 2 })
    expect(r.score).toBe(40)
  })

  test('staleness bucket: 180 days (>90d) → -15', () => {
    const r = scoreQuality(goodCi, { updatedAgeDays: 180 })
    expect(r.score).toBe(100 - SCORING.FRESHNESS_90D_PEN)
  })

  test('staleness bucket: 500 days (>365d) → -30', () => {
    const r = scoreQuality(goodCi, { updatedAgeDays: 500 })
    expect(r.score).toBe(100 - SCORING.FRESHNESS_365D_PEN)
  })

  test('retired + matched to live infra is the contradiction penalty', () => {
    const ci = { ...goodCi, operational_status: 'retired' }
    const r = scoreQuality(ci, { updatedAgeDays: 2, matchedToLiveInfra: true })
    // Note: operational_status is PRESENT (value 'retired'), so no missing-field
    // penalty; contradiction is the only deduction.
    expect(r.score).toBe(100 - SCORING.CONTRADICTION_PEN)
    expect(r.reasons.join(' ')).toMatch(/retired.*live/i)
  })

  test('retired but NOT matched to live infra — no contradiction', () => {
    const ci = { ...goodCi, operational_status: 'retired' }
    const r = scoreQuality(ci, { updatedAgeDays: 2, matchedToLiveInfra: false })
    expect(r.score).toBe(100)
  })

  test('sys_updated_on missing → small deduction only', () => {
    const r = scoreQuality(goodCi, { updatedAgeDays: null })
    expect(r.score).toBe(95)
  })

  test('clamps at 0', () => {
    const r = scoreQuality({}, { updatedAgeDays: 500, matchedToLiveInfra: false })
    // missing fields -60 + freshness -30 = -90, leaves 10
    expect(r.score).toBe(10)
  })
})

describe('daysBetween', () => {
  test('returns day difference', () => {
    expect(daysBetween('2026-01-01T00:00:00Z', '2026-01-11T00:00:00Z')).toBe(10)
  })
  test('null inputs return null', () => {
    expect(daysBetween(null, '2026-01-01T00:00:00Z')).toBeNull()
    expect(daysBetween('2026-01-01T00:00:00Z', null)).toBeNull()
  })
  test('invalid date strings return null', () => {
    expect(daysBetween('not-a-date', '2026-01-01T00:00:00Z')).toBeNull()
  })
})
