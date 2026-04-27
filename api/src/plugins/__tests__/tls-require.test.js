// Locks the APPCLOUD_REQUIRE_TLS hard-fail contract for both DB plugins.
// The matching warning-only behaviour for prod-shaped hostnames stays
// covered by the soft check at the call site (manual smoke test) — what
// we lock here is the strict mode, since a regression that silently
// swallows the hard-fail would let a TLS-required deployment start with
// plaintext connections and never surface.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'

function snapshotEnv() {
  return {
    POSTGRES_HOST:           process.env.POSTGRES_HOST,
    POSTGRES_PORT:           process.env.POSTGRES_PORT,
    POSTGRES_DB:             process.env.POSTGRES_DB,
    POSTGRES_USER:           process.env.POSTGRES_USER,
    POSTGRES_PASSWORD:       process.env.POSTGRES_PASSWORD,
    APPCLOUD_POSTGRES_SSL:   process.env.APPCLOUD_POSTGRES_SSL,
    APPCLOUD_REQUIRE_TLS:    process.env.APPCLOUD_REQUIRE_TLS,
    APPCLOUD_NEO4J_URI:      process.env.APPCLOUD_NEO4J_URI,
    NEO4J_URI:               process.env.NEO4J_URI,
    NEO4J_USER:              process.env.NEO4J_USER,
    NEO4J_PASSWORD:          process.env.NEO4J_PASSWORD,
  }
}

function restoreEnv(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k]
    else                 process.env[k] = v
  }
}

// Minimal fastify shim. The plugins use fastify.log + fastify.decorate
// + fastify.addHook; that's it on the failure path before the throw.
function makeFastifyStub() {
  const decorations = {}
  return {
    decorations,
    log:    { info: () => {}, warn: () => {}, error: () => {} },
    decorate(name, value) { decorations[name] = value },
    addHook() {},
  }
}

describe('APPCLOUD_REQUIRE_TLS — hard-fail mode', () => {
  let envSnap
  beforeEach(() => { envSnap = snapshotEnv() })
  afterEach(()  => { restoreEnv(envSnap) })

  describe('postgres plugin', () => {
    test('throws when REQUIRE_TLS=true and APPCLOUD_POSTGRES_SSL is unset', async () => {
      // Even an in-cluster-shaped hostname (`postgres`) is not exempt —
      // strict mode means strict, regardless of host shape.
      process.env.POSTGRES_HOST        = 'postgres'
      process.env.APPCLOUD_REQUIRE_TLS = 'true'
      delete process.env.APPCLOUD_POSTGRES_SSL

      const { postgresPlugin } = await import('../postgres.js')
      await expect(postgresPlugin(makeFastifyStub()))
        .rejects.toThrow(/APPCLOUD_REQUIRE_TLS=true but APPCLOUD_POSTGRES_SSL is not enabled/)
    })

    test('does NOT throw when REQUIRE_TLS=true and APPCLOUD_POSTGRES_SSL=true', async () => {
      // We can't actually connect from a unit test, but the throw fires
      // before the connect attempt — so the post-connect "PostgreSQL
      // unavailable" warn path is what we expect to land in. No throw.
      process.env.POSTGRES_HOST        = '127.0.0.1'
      process.env.POSTGRES_PORT        = '1'        // unreachable, fast fail
      process.env.APPCLOUD_REQUIRE_TLS = 'true'
      process.env.APPCLOUD_POSTGRES_SSL = 'true'

      const { postgresPlugin } = await import('../postgres.js')
      const fastify = makeFastifyStub()
      // The plugin catches connect errors itself and degrades to the
      // stub decorator; reaching that path proves the TLS gate didn't
      // throw. Should not raise.
      await expect(postgresPlugin(fastify)).resolves.toBeUndefined()
      expect(fastify.decorations.pg).toBeDefined()
    })

    test('REQUIRE_TLS not set → soft warning path, no throw', async () => {
      process.env.POSTGRES_HOST        = 'remote-pg.example.com'
      process.env.POSTGRES_PORT        = '1'
      delete process.env.APPCLOUD_REQUIRE_TLS
      delete process.env.APPCLOUD_POSTGRES_SSL

      const { postgresPlugin } = await import('../postgres.js')
      const warnings = []
      const fastify = makeFastifyStub()
      fastify.log.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg))
      await expect(postgresPlugin(fastify)).resolves.toBeUndefined()
      expect(warnings.some(w => /without TLS/.test(w))).toBe(true)
    })
  })

  describe('neo4j plugin', () => {
    test('throws when REQUIRE_TLS=true and URI is plaintext bolt://', async () => {
      process.env.APPCLOUD_NEO4J_URI   = 'bolt://neo4j:7687'
      process.env.APPCLOUD_REQUIRE_TLS = 'true'
      process.env.NEO4J_USER           = 'neo4j'
      process.env.NEO4J_PASSWORD       = 'secret'

      const { neo4jPlugin } = await import('../neo4j.js')
      await expect(neo4jPlugin(makeFastifyStub()))
        .rejects.toThrow(/APPCLOUD_REQUIRE_TLS=true but URI .* is plaintext/)
    })

    test('throws when REQUIRE_TLS=true and URI is plaintext neo4j://', async () => {
      // The driver also accepts the `neo4j://` (routing) scheme with no
      // encryption; treat it as plaintext for the strict check.
      process.env.APPCLOUD_NEO4J_URI   = 'neo4j://neo4j:7687'
      process.env.APPCLOUD_REQUIRE_TLS = 'true'

      const { neo4jPlugin } = await import('../neo4j.js')
      await expect(neo4jPlugin(makeFastifyStub()))
        .rejects.toThrow(/plaintext/)
    })

    test('does NOT throw when REQUIRE_TLS=true and URI uses bolt+s://', async () => {
      // We point at an unreachable host so the driver fails connectivity
      // verification — but that's a different error than the TLS-required
      // throw. The TLS check passes; the connect fails. We assert on the
      // error message NOT being our TLS-required error.
      process.env.APPCLOUD_NEO4J_URI   = 'bolt+s://localhost:1'
      process.env.APPCLOUD_REQUIRE_TLS = 'true'
      process.env.NEO4J_USER           = 'neo4j'
      process.env.NEO4J_PASSWORD       = 'secret'

      const { neo4jPlugin } = await import('../neo4j.js')
      try {
        await neo4jPlugin(makeFastifyStub())
        // Reaching here means the driver verified — possible if a local
        // bolt+s server is up. Either way no TLS-required throw.
      } catch (err) {
        expect(err.message).not.toMatch(/APPCLOUD_REQUIRE_TLS=true but URI/)
      }
    })

    test('REQUIRE_TLS not set → soft warning for remote-shaped URI, no throw from gate', async () => {
      // Hostname must not contain `neo4j` as a word — that's treated
      // as the in-cluster service name and skipped by the soft-warn.
      process.env.APPCLOUD_NEO4J_URI = 'bolt://graph.example.com:7687'
      delete process.env.APPCLOUD_REQUIRE_TLS

      const { neo4jPlugin } = await import('../neo4j.js')
      const warnings = []
      const fastify = makeFastifyStub()
      fastify.log.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg))
      try {
        await neo4jPlugin(fastify)
      } catch (err) {
        // Connection will fail (host doesn't exist) — that's fine. We're
        // only checking the soft-warn fired and no TLS-required throw.
        expect(err.message).not.toMatch(/APPCLOUD_REQUIRE_TLS=true but URI/)
      }
      expect(warnings.some(w => /unencrypted/.test(w))).toBe(true)
    })
  })
})
