import { describe, test, expect } from '@jest/globals'
import { makeOnceLock } from '../once-lock.js'

describe('makeOnceLock', () => {
  test('first call runs, second concurrent call is skipped', async () => {
    const lock = makeOnceLock()
    let started = 0
    const slow = async () => {
      started++
      await new Promise(r => setTimeout(r, 30))
      return 42
    }
    const [first, second] = await Promise.all([lock.run(slow), lock.run(slow)])
    expect(started).toBe(1)
    expect(first.ok).toBe(true)
    expect(first.result).toBe(42)
    expect(second.skipped).toBe('in-flight')
  })

  test('lock is released after the inner promise resolves', async () => {
    const lock = makeOnceLock()
    let runs = 0
    const incr = async () => { runs++; return runs }
    await lock.run(incr)
    await lock.run(incr)
    expect(runs).toBe(2)                  // both ran, sequentially
  })

  test('throws from the inner function release the lock and propagate', async () => {
    const lock = makeOnceLock()
    await expect(
      lock.run(async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')
    // After the failure, the lock is free.
    const r = await lock.run(async () => 'recovered')
    expect(r.result).toBe('recovered')
  })

  test('isRunning reflects in-flight state', async () => {
    const lock = makeOnceLock()
    expect(lock.isRunning()).toBe(false)
    let resolveSlow
    const slow = new Promise(r => { resolveSlow = r })
    const promise = lock.run(async () => { await slow; return 1 })
    expect(lock.isRunning()).toBe(true)
    resolveSlow(undefined)
    await promise
    expect(lock.isRunning()).toBe(false)
  })

  test('the across-await race that motivated this lock is closed', async () => {
    // The bug we're fixing: the old `let running = false; if (running) return; running = true`
    // pattern races because the await between the check and the set lets
    // a second tick see running=false and also enter. This test confirms
    // the new lock prevents re-entry under the same race.
    const lock = makeOnceLock()
    let entered = 0
    const work = async () => {
      entered++
      // Yield so a concurrent run() has a chance to see in-flight state.
      await new Promise(r => setImmediate(r))
      return entered
    }
    // Fire 5 in parallel — without the lock, all 5 would enter.
    const results = await Promise.all([
      lock.run(work), lock.run(work), lock.run(work),
      lock.run(work), lock.run(work),
    ])
    expect(entered).toBe(1)
    const skipped = results.filter(r => r.skipped === 'in-flight')
    expect(skipped.length).toBe(4)
  })
})
