// Integration test — cross-store at-least-once contract for the OTel
// aggregator path against real Postgres + real Neo4j.
//
// The OTel pipeline straddles two stores: spans land in Postgres
// (otel_spans_raw, the staging table), the aggregator drains them
// into Neo4j (Component nodes + observed-edge MERGEs), and then
// DELETEs the staged rows. The contract: if the Neo4j write fails,
// the staged rows survive for the next tick. Idempotent MERGE means
// re-aggregating the same spans creates no duplicates.
//
// Why an integration test rather than a unit test on the dispatch
// logic: the at-least-once property depends on the actual Cypher
// MERGE semantics. A unit test stub can't tell us the second tick
// produces no duplicate edges; only a real Neo4j can.

import { test, expect, beforeAll, afterAll, jest } from '@jest/globals'
import {
  getMaybeDescribe,
  startPostgres,
  startNeo4j,
  applyPostgresInitFiles,
  wrapNeo4jDriver,
} from './helpers.js'
import { runTick } from '../../plugins/otel-aggregator.js'

jest.setTimeout(600_000)

const maybeDescribe = getMaybeDescribe('otel cross-store at-least-once')

maybeDescribe('OTel aggregator at-least-once + idempotency (Testcontainers)', () => {
  let pgContainer, pgClient
  let neo4jContainer, neo4jDriver
  // The fake fastify the test uses to drive runTick. We swap in a
  // failing neo4j stub for the "outage" phase, then restore.
  let fastify
  let neo4jWritesShouldFail = false

  let tenantId            // FK target on otel_spans_raw

  beforeAll(async () => {
    ;({ container: pgContainer, client: pgClient } = await startPostgres())
    await applyPostgresInitFiles(pgClient, [
      '01-schema.sql',
      '08-otel-staging.sql',
    ])
    // otel_spans_raw has a NOT NULL FK to otel_tenants(id), which in
    // turn has a NOT NULL FK to integrations(id). Build the chain in
    // both tables so test inserts validate.
    const integ = await pgClient.query(`
      INSERT INTO integrations (type, name, enabled)
      VALUES ('otel', 'cross-store-test', true)
      RETURNING id
    `)
    const tenant = await pgClient.query(`
      INSERT INTO otel_tenants (integration_id, token_hash)
      VALUES ($1, 'sha256-test-fixture')
      RETURNING id
    `, [integ.rows[0].id])
    tenantId = tenant.rows[0].id

    ;({ container: neo4jContainer, driver: neo4jDriver } = await startNeo4j())

    const realNeo4j = wrapNeo4jDriver(neo4jDriver)
    fastify = {
      log: { info() {}, warn() {}, error() {} },
      pg: {
        pool:  pgClient,
        query: async (sql, params = []) => (await pgClient.query(sql, params)).rows,
      },
      neo4j: {
        ...realNeo4j,
        // Wrap write() so the test can flip it into "failing" mode
        // mid-suite. Simulates a Neo4j outage from the API's POV.
        // ONLY writes from runTick() are intercepted — the test's own
        // verification reads use the real driver via `realNeo4j`
        // (saved on the fastify object so test bodies can read while
        // writes are blocked).
        write: async (cypher, params) => {
          if (neo4jWritesShouldFail) throw new Error('simulated neo4j outage')
          return realNeo4j.write(cypher, params)
        },
      },
    }
    // Test-side accessor for verification reads while the write-stub
    // is in failing mode. Not visible to runTick.
    fastify.realNeo4j = realNeo4j
  }, 240_000)

  afterAll(async () => {
    try { await neo4jDriver?.close() }      catch {}
    try { await neo4jContainer?.stop() }    catch {}
    try { await pgClient?.end() }           catch {}
    try { await pgContainer?.stop() }       catch {}
  })

  // Helper: stage a deterministic batch of spans in otel_spans_raw.
  // Two spans across two services, one parent/child pair so the
  // aggregator emits exactly one Component-pair edge.
  //
  // Schema notes:
  //   - trace_id / span_id / parent_span_id are BYTEA (binary)
  //   - span_kind / status_code are SMALLINT (OTel proto int codes)
  //     SPAN_KIND_SERVER = 2, SPAN_KIND_CLIENT = 3
  //     STATUS_CODE_OK   = 1
  //   - tenant_id is a required FK to otel_tenants
  async function stageSpans() {
    const traceId    = Buffer.from('11111111111111111111111111111111', 'hex')
    const parentSpan = Buffer.from('0000000000000001', 'hex')
    const childSpan  = Buffer.from('0000000000000002', 'hex')
    const startNs    = '1700000000000000000'
    const endNs      = '1700000000050000000'
    await pgClient.query(`
      INSERT INTO otel_spans_raw
        (tenant_id, trace_id, span_id, parent_span_id, service_name, service_namespace,
         deployment_environment, span_name, span_kind, start_time_ns, end_time_ns,
         status_code, attributes, resource_attributes, received_at)
      VALUES
        ($1, $2, $3, NULL, 'parent-service', 'app-ns',
         'production', 'GET /api', 2, $5, $6,
         1, '{}'::jsonb, '{}'::jsonb, now()),
        ($1, $2, $4, $3, 'child-service', 'app-ns',
         'production', 'GET /downstream', 3, $5, $6,
         1, '{"http.method":"GET"}'::jsonb, '{}'::jsonb, now())
    `, [tenantId, traceId, parentSpan, childSpan, startNs, endNs])
  }

  test('Neo4j write failure leaves rows in otel_spans_raw for the next tick', async () => {
    // Clean slate.
    await pgClient.query(`DELETE FROM otel_spans_raw`)
    await neo4jDriver.session().run(`MATCH (n) DETACH DELETE n`).catch(() => {})

    await stageSpans()
    const before = await pgClient.query(`SELECT COUNT(*)::int AS n FROM otel_spans_raw`)
    expect(before.rows[0].n).toBe(2)

    // First tick — Neo4j is broken. The aggregator should bail without
    // deleting the staged rows.
    neo4jWritesShouldFail = true
    const r1 = await runTick(fastify)
    expect(r1?.error).toMatch(/simulated neo4j outage/)

    const afterFail = await pgClient.query(`SELECT COUNT(*)::int AS n FROM otel_spans_raw`)
    expect(afterFail.rows[0].n).toBe(2)              // STILL THERE — at-least-once contract holds.

    // No partial Neo4j state either — the failed MERGE should leave
    // zero Components. Read via realNeo4j so the failing-write stub
    // doesn't intercept the verification.
    const noComps = (await fastify.realNeo4j.write(`MATCH (c:Component) RETURN count(c) AS n`))[0].get('n').toNumber()
    expect(noComps).toBe(0)
  })

  test('Restoring Neo4j drains the rows and creates exactly one component pair / one edge', async () => {
    neo4jWritesShouldFail = false
    const r2 = await runTick(fastify)
    expect(r2?.processed).toBe(2)
    expect(r2?.components).toBe(2)
    expect(r2?.edges).toBe(1)

    const afterDrain = await pgClient.query(`SELECT COUNT(*)::int AS n FROM otel_spans_raw`)
    expect(afterDrain.rows[0].n).toBe(0)             // consumed

    const compCount = (await fastify.neo4j.write(`MATCH (c:Component) RETURN count(c) AS n`))[0].get('n').toNumber()
    expect(compCount).toBe(2)

    const edgeCount = (await fastify.neo4j.write(
      `MATCH (:Component)-[r:CONNECTS_TO {source: 'otel'}]->(:Component) RETURN count(r) AS n`,
    ))[0].get('n').toNumber()
    expect(edgeCount).toBe(1)
  })

  test('Idempotent MERGE: re-staging + re-running creates no duplicate edges', async () => {
    // Stage the same logical spans again, then run a tick. Because
    // the aggregator MERGEs Components by (name, origin_namespace) +
    // edges by (src, dst, source, via), a second pass over identical
    // spans must produce zero new components and zero new edges —
    // only updated `last_seen` / `updated_at` timestamps.
    await stageSpans()
    const r3 = await runTick(fastify)
    expect(r3?.processed).toBe(2)

    const compCount = (await fastify.neo4j.write(`MATCH (c:Component) RETURN count(c) AS n`))[0].get('n').toNumber()
    expect(compCount).toBe(2)                      // still 2 — no duplicates.

    const edgeCount = (await fastify.neo4j.write(
      `MATCH (:Component)-[r:CONNECTS_TO {source: 'otel'}]->(:Component) RETURN count(r) AS n`,
    ))[0].get('n').toNumber()
    expect(edgeCount).toBe(1)                      // still 1 — no duplicates.
  })

  test('CONNECTS_TO edge written by aggregator carries the contract properties', async () => {
    // Locks the P2 :CONNECTS_TO invariant fix at the on-DB level —
    // every otel-emitted edge MUST carry source/via/confidence/
    // evidence per CLAUDE.md. The static-analysis test in
    // `__tests__/connects-to-invariant.test.js` pins this at the
    // source level; this test pins it on the actual graph state.
    const rows = await fastify.neo4j.write(
      `MATCH (:Component)-[r:CONNECTS_TO {source: 'otel'}]->(:Component)
       RETURN r.source AS src, r.via AS via, r.confidence AS conf, r.evidence AS ev`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.get('src')).toBe('otel')
      expect(row.get('via')).toBeTruthy()
      expect(row.get('conf')).toBeTruthy()
      expect(row.get('ev')).toBeTruthy()
    }
  })
})
