import { describe, test, expect } from '@jest/globals'
import { withLeaderLock, SCHEDULER_LOCK_KEYS } from '../leader-lock.js'

// In-memory fake `pool` that mimics the slice of node-postgres we use.
// One concurrent advisory-lock holder per key globally — matches what
// real Postgres does across sessions.
function makeFakePool() {
  const heldKeys = new Set()
  const clients  = []
  function makeClient() {
    const localKeys = new Set()
    const client = {
      released: false,
      query: async (sql, params) => {
        if (/pg_try_advisory_lock/.test(sql)) {
          const key = String(params[0])
          if (heldKeys.has(key)) return { rows: [{ locked: false }] }
          heldKeys.add(key)
          localKeys.add(key)
          return { rows: [{ locked: true }] }
        }
        if (/pg_advisory_unlock/.test(sql)) {
          const key = String(params[0])
          if (localKeys.has(key)) {
            heldKeys.delete(key)
            localKeys.delete(key)
            return { rows: [{ pg_advisory_unlock: true }] }
          }
          return { rows: [{ pg_advisory_unlock: false }] }
        }
        return { rows: [] }
      },
      release: () => {
        client.released = true
        // On real connection-close, Postgres releases the locks. Mirror that.
        for (const k of localKeys) heldKeys.delete(k)
        localKeys.clear()
      },
    }
    return client
  }
  return {
    connect: async () => {
      const c = makeClient()
      clients.push(c)
      return c
    },
    clients,
    heldKeys,
  }
}

describe('withLeaderLock', () => {
  test('returns no-pool when pool is null/undefined', async () => {
    expect(await withLeaderLock(null, 1n, async () => 'never')).toEqual({ skipped: 'no-pool' })
    expect(await withLeaderLock(undefined, 1n, async () => 'never')).toEqual({ skipped: 'no-pool' })
  })

  test('first caller acquires lock + runs callback; result returned', async () => {
    const pool = makeFakePool()
    let ran = false
    const r = await withLeaderLock(pool, SCHEDULER_LOCK_KEYS.discoveryScan, async () => {
      ran = true
      return 42
    })
    expect(ran).toBe(true)
    expect(r).toEqual({ ok: true, result: 42 })
    expect(pool.heldKeys.size).toBe(0)            // lock released
    expect(pool.clients[0].released).toBe(true)   // client released
  })

  test('second caller while first holds the lock is skipped', async () => {
    const pool = makeFakePool()
    let resolveFirst
    const blocker = new Promise(r => { resolveFirst = r })
    const first = withLeaderLock(pool, SCHEDULER_LOCK_KEYS.discoveryScan, async () => {
      await blocker
      return 1
    })
    // Yield so the first one acquires.
    await new Promise(r => setImmediate(r))
    const second = await withLeaderLock(pool, SCHEDULER_LOCK_KEYS.discoveryScan, async () => 2)
    expect(second).toEqual({ skipped: 'leader-elsewhere' })
    resolveFirst()
    await first
  })

  test('different keys do not block each other', async () => {
    const pool = makeFakePool()
    let resolveA
    const blockerA = new Promise(r => { resolveA = r })
    const a = withLeaderLock(pool, SCHEDULER_LOCK_KEYS.discoveryScan, async () => {
      await blockerA
      return 'a'
    })
    await new Promise(r => setImmediate(r))
    const b = await withLeaderLock(pool, SCHEDULER_LOCK_KEYS.cmdbAssessmentRun, async () => 'b')
    expect(b).toEqual({ ok: true, result: 'b' })
    resolveA()
    await a
  })

  test('callback throw releases lock + propagates the error', async () => {
    const pool = makeFakePool()
    await expect(
      withLeaderLock(pool, SCHEDULER_LOCK_KEYS.discoveryScan, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(pool.heldKeys.size).toBe(0)
    expect(pool.clients[0].released).toBe(true)
  })

  test('connection-failure during fn still releases the pool client', async () => {
    // Mimic a callback that throws AFTER acquire — the finally must
    // still call client.release(), otherwise the pool leaks.
    const pool = makeFakePool()
    await expect(
      withLeaderLock(pool, SCHEDULER_LOCK_KEYS.discoveryScan, async () => {
        throw Object.assign(new Error('disconnect'), { code: 'ECONNRESET' })
      }),
    ).rejects.toThrow('disconnect')
    expect(pool.clients[0].released).toBe(true)
  })

  test('SCHEDULER_LOCK_KEYS is frozen so callers cannot collide via mutation', () => {
    expect(Object.isFrozen(SCHEDULER_LOCK_KEYS)).toBe(true)
  })
})
