import { describe, test, expect } from '@jest/globals'
import { makeXActorWarnGate } from '../auth.js'

describe('makeXActorWarnGate', () => {
  test('first call for a (principalId, xActor) pair returns true', () => {
    const gate = makeXActorWarnGate({ windowMs: 60_000 })
    expect(gate('user-1', 'alice')).toBe(true)
  })

  test('subsequent calls within the window return false (suppressed)', () => {
    const gate = makeXActorWarnGate({ windowMs: 60_000 })
    expect(gate('user-1', 'alice')).toBe(true)
    expect(gate('user-1', 'alice')).toBe(false)
    expect(gate('user-1', 'alice')).toBe(false)
  })

  test('different principals + same xActor warn independently', () => {
    const gate = makeXActorWarnGate({ windowMs: 60_000 })
    expect(gate('user-1', 'alice')).toBe(true)
    expect(gate('user-2', 'alice')).toBe(true)        // different principal
    expect(gate('user-1', 'alice')).toBe(false)
  })

  test('same principal + different xActor warns independently', () => {
    const gate = makeXActorWarnGate({ windowMs: 60_000 })
    expect(gate('user-1', 'alice')).toBe(true)
    expect(gate('user-1', 'bob')).toBe(true)
    expect(gate('user-1', 'alice')).toBe(false)
  })

  test('after the window expires, the warning fires again', async () => {
    const gate = makeXActorWarnGate({ windowMs: 50 })
    expect(gate('user-1', 'alice')).toBe(true)
    expect(gate('user-1', 'alice')).toBe(false)
    await new Promise(r => setTimeout(r, 80))
    expect(gate('user-1', 'alice')).toBe(true)
  })

  test('packing collision via colon separator does NOT cause false suppression', () => {
    // The key encoding uses NUL as the separator so that
    //   ('a:', 'b')  and  ('a', ':b')
    // produce distinct keys. This locks that contract — both pairs
    // should warn the first time, even though their colon-joined forms
    // would be identical.
    const gate = makeXActorWarnGate({ windowMs: 60_000 })
    expect(gate('a:', 'b')).toBe(true)
    expect(gate('a', ':b')).toBe(true)
  })

  test('map size is bounded — older entries get evicted', () => {
    const gate = makeXActorWarnGate({ windowMs: 60_000, maxEntries: 3 })
    expect(gate('p', 'a')).toBe(true)                 // 1 entry
    expect(gate('p', 'b')).toBe(true)                 // 2 entries
    expect(gate('p', 'c')).toBe(true)                 // 3 entries (full)
    expect(gate('p', 'd')).toBe(true)                 // evicts 'a'
    // 'a' was evicted in the previous call, so it now warns again
    // (treated as a new pair) — proving eviction actually happened.
    expect(gate('p', 'a')).toBe(true)
    // The freshest entry ('d') is still inside the window and must
    // remain suppressed.
    expect(gate('p', 'd')).toBe(false)
  })
})
