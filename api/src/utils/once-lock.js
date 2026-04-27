// utils/once-lock.js
//
// Promise-based "is something already running" gate. Replaces the
// `let running = false` pattern in our schedulers, which is unsafe
// across an `await` (the gap between `if (running) return; running = true`
// and the work that follows lets a second tick enter the same critical
// section).
//
// Usage:
//
//   const lock = makeOnceLock()
//   const result = await lock.run(async () => doWork())
//
// If a second `run()` fires while the first is mid-flight, it does NOT
// queue — it returns `{ skipped: 'in-flight' }` immediately. This is
// the right semantic for periodic work (scheduler ticks, drain loops):
// if the previous tick is still running, this tick is skipped, not
// stacked.
//
// `lock.isRunning()` lets observability code report current state.

export function makeOnceLock() {
  let inFlight = null

  return {
    isRunning() { return inFlight !== null },
    async run(fn) {
      if (inFlight) return { skipped: 'in-flight' }
      inFlight = (async () => {
        try {
          return { ok: true, result: await fn() }
        } catch (err) {
          return { ok: false, error: err }
        } finally {
          inFlight = null
        }
      })()
      const wrapped = await inFlight
      if (!wrapped.ok) throw wrapped.error
      return { ok: true, result: wrapped.result }
    },
  }
}
