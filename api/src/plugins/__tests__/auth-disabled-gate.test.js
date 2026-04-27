// Locks the contract that the auth plugin's open-auth fallback is
// (a) refused outright in NODE_ENV=production unless explicitly
// acknowledged, and (b) re-warned periodically when active so the
// signal doesn't scroll out of operator view after boot.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'

function snapshot() {
  return {
    NODE_ENV:                          process.env.NODE_ENV,
    APPCLOUD_API_KEY:                  process.env.APPCLOUD_API_KEY,
    APPCLOUD_ADMIN_API_KEY:            process.env.APPCLOUD_ADMIN_API_KEY,
    APPCLOUD_API_KEY_FILE:             process.env.APPCLOUD_API_KEY_FILE,
    APPCLOUD_ADMIN_API_KEY_FILE:       process.env.APPCLOUD_ADMIN_API_KEY_FILE,
    APPCLOUD_ALLOW_OPEN_AUTH:          process.env.APPCLOUD_ALLOW_OPEN_AUTH,
    APPCLOUD_AUTH_DISABLED_WARN_MS:    process.env.APPCLOUD_AUTH_DISABLED_WARN_MS,
  }
}
function restore(s) {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) delete process.env[k]
    else                 process.env[k] = v
  }
}

function makeStubFastify() {
  const closeHandlers = []
  const decorations = {}
  const warnings    = []
  const errors      = []
  return {
    decorations, warnings, errors, closeHandlers,
    log: {
      info:  () => {},
      warn:  (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg)),
      error: (msg) => errors.push(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    },
    decorate(name, value) { decorations[name] = value },
    addHook(name, fn) { if (name === 'onClose') closeHandlers.push(fn) },
    pg: {
      pool: {},                                             // truthy
      query: async () => [],                                // empty cache → authDisabled=true
    },
  }
}

describe('auth-disabled fallback', () => {
  let snap
  beforeEach(() => {
    snap = snapshot()
    delete process.env.APPCLOUD_API_KEY
    delete process.env.APPCLOUD_ADMIN_API_KEY
    delete process.env.APPCLOUD_API_KEY_FILE
    delete process.env.APPCLOUD_ADMIN_API_KEY_FILE
    delete process.env.APPCLOUD_ALLOW_OPEN_AUTH
    process.env.APPCLOUD_AUTH_DISABLED_WARN_MS = '0'        // disable the periodic timer in tests
  })
  afterEach(() => restore(snap))

  test('non-production with no keys: warns once + decorates authDisabled=true', async () => {
    process.env.NODE_ENV = 'development'
    const { authPlugin } = await import('../auth.js')
    const fastify = makeStubFastify()
    await authPlugin(fastify)
    expect(fastify.decorations.authDisabled).toBe(true)
    expect(fastify.warnings.some(w => /authentication disabled/.test(w))).toBe(true)
  })

  test('production with no keys + no APPCLOUD_ALLOW_OPEN_AUTH: REFUSES to start', async () => {
    process.env.NODE_ENV = 'production'
    const { authPlugin } = await import('../auth.js')
    const fastify = makeStubFastify()
    await expect(authPlugin(fastify))
      .rejects.toThrow(/refusing to start in NODE_ENV=production with no API keys/)
  })

  test('production with no keys + APPCLOUD_ALLOW_OPEN_AUTH=true: starts with warning', async () => {
    process.env.NODE_ENV = 'production'
    process.env.APPCLOUD_ALLOW_OPEN_AUTH = 'true'
    const { authPlugin } = await import('../auth.js')
    const fastify = makeStubFastify()
    await authPlugin(fastify)
    expect(fastify.decorations.authDisabled).toBe(true)
    expect(fastify.warnings.some(w => /authentication disabled/.test(w))).toBe(true)
  })

  test('periodic re-warn fires while auth is disabled, stops on close', async () => {
    process.env.NODE_ENV = 'development'
    process.env.APPCLOUD_AUTH_DISABLED_WARN_MS = '50'       // tight loop for the test
    const { authPlugin } = await import('../auth.js')
    const fastify = makeStubFastify()
    await authPlugin(fastify)
    // Wait enough wall-clock for at least 2 re-warn ticks.
    await new Promise(r => setTimeout(r, 130))
    const reWarns = fastify.warnings.filter(w => /STILL RUNNING WITH AUTH DISABLED/.test(w))
    expect(reWarns.length).toBeGreaterThanOrEqual(2)
    // Trigger onClose and confirm no further re-warns fire.
    for (const fn of fastify.closeHandlers) await fn()
    const seenAtClose = fastify.warnings.filter(w => /STILL RUNNING/.test(w)).length
    await new Promise(r => setTimeout(r, 100))
    const seenAfterClose = fastify.warnings.filter(w => /STILL RUNNING/.test(w)).length
    expect(seenAfterClose).toBe(seenAtClose)
  })
})
