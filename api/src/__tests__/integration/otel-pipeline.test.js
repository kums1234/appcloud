// Integration test — full OTel pipeline against real Postgres + Neo4j via
// Testcontainers. Skips cleanly if Docker is unavailable so the unit suite
// still passes in environments without the daemon.
//
// Run explicitly with:
//   cd api && npm run test:integration
import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals'
import { randomUUID } from 'crypto'

jest.setTimeout(600_000)

// Detect docker + a supported Node version up-front so failures surface as
// skips, not timeouts. Testcontainers 10.x has a known bug on Node 24+
// (createEmptyTmpFile calls path.resolve(undefined)), so we pin to Node 20/22
// LTS. CI environments hitting this test should use those versions.
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10)
const NODE_SUPPORTED = NODE_MAJOR >= 18 && NODE_MAJOR <= 22
let DOCKER_AVAILABLE = false
try {
  const { execSync } = await import('child_process')
  execSync('docker info', { stdio: 'ignore', timeout: 5000 })
  DOCKER_AVAILABLE = true
} catch { /* docker not available — test below becomes a skip */ }

const maybeDescribe = (DOCKER_AVAILABLE && NODE_SUPPORTED) ? describe : describe.skip
if (DOCKER_AVAILABLE && !NODE_SUPPORTED) {
  // eslint-disable-next-line no-console
  console.warn(`[otel-pipeline integration] skipped: Node ${NODE_MAJOR} not supported by Testcontainers 10.x; use Node 20 or 22 LTS`)
}

maybeDescribe('OTel ingest → aggregator pipeline (Testcontainers)', () => {
  let pgContainer, neo4jContainer, pgClient, neo4jDriver
  let fakeFastify

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql')
    const { Neo4jContainer }      = await import('@testcontainers/neo4j')
    const pgModule                = await import('pg')
    const neo4jModule             = await import('neo4j-driver')
    const Client                  = pgModule.default?.Client || pgModule.Client
    const neo4j                   = neo4jModule.default || neo4jModule

    // Start containers in parallel — saves ~1 min on a cold Docker.
    ;[pgContainer, neo4jContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('appcloud').withUsername('appcloud').withPassword('pw').start(),
      new Neo4jContainer('neo4j:5').withoutAuthentication().start(),
    ])

    pgClient = new Client({
      host: pgContainer.getHost(), port: pgContainer.getMappedPort(5432),
      database: 'appcloud', user: 'appcloud', password: 'pw',
    })
    await pgClient.connect()

    // Apply the baseline schema + evolutions + staging DDL in the same order
    // postgres-init applies them on a fresh volume.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const initDir = path.resolve(here, '../../../../postgres-init')
    for (const f of ['01-schema.sql', '07-integrations-evolution.sql', '08-otel-staging.sql']) {
      const sql = await fs.readFile(path.join(initDir, f), 'utf8')
      await pgClient.query(sql)
    }

    // Container configured withoutAuthentication() — driver still needs a placeholder.
    neo4jDriver = neo4j.driver(
      neo4jContainer.getBoltUri(),
      neo4j.auth.basic('neo4j', 'none'),
    )

    // Fake the decorators that the aggregator plugin expects on `fastify`.
    fakeFastify = {
      log: { info() {}, warn() {}, error() {} },
      pg: {
        pool: pgClient,
        query: async (sql, params = []) => (await pgClient.query(sql, params)).rows,
      },
      neo4j: {
        write: async (cypher, params = {}) => {
          const session = neo4jDriver.session()
          try { return (await session.run(cypher, params)).records }
          finally { await session.close() }
        },
        query: async (cypher, params = {}) => {
          const session = neo4jDriver.session()
          try { return (await session.run(cypher, params)).records }
          finally { await session.close() }
        },
      },
    }
  }, 180_000)

  afterAll(async () => {
    try { await pgClient?.end() }          catch {}
    try { await neo4jDriver?.close() }     catch {}
    try { await pgContainer?.stop() }      catch {}
    try { await neo4jContainer?.stop() }   catch {}
  })

  test('spans → aggregator tick → Neo4j :Component + :CONNECTED_TO edges', async () => {
    const { flattenResourceSpans } = await import('../../connectors/otel-ingest/parse.js')
    const { aggregateBatch }        = await import('../../plugins/otel-aggregator.js')
    const { VIA_TO_REL_TYPE, TELEMETRY_COMPONENT_LABELS } = await import('../../routes/discovery.schema.js')

    // ── Seed an integration + tenant row ──
    const integrationId = randomUUID()
    await pgClient.query(
      `INSERT INTO integrations (id, type, name, config, enabled)
        VALUES ($1, 'otel-ingest', 'test', '{}'::jsonb, true)`,
      [integrationId],
    )
    const tenantRes = await pgClient.query(
      `INSERT INTO otel_tenants (integration_id, token_hash) VALUES ($1, $2) RETURNING id`,
      [integrationId, 'test-hash'],
    )
    const tenantId = tenantRes.rows[0].id

    // ── Stage a 3-service trace through the real parse helper ──
    const payload = {
      resourceSpans: [
        { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'frontend' } }] },
          scopeSpans: [{ scope: { name: 't' }, spans: [{
            traceId: '11111111111111111111111111111111', spanId: 'aaaaaaaaaaaaaaaa',
            name: 'GET /', kind: 2,
            startTimeUnixNano: '1000000000', endTimeUnixNano: '20000000',
            status: { code: 1 }, attributes: [{ key: 'http.route', value: { stringValue: '/' } }] },
          ]}]},
        { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'orders' } }] },
          scopeSpans: [{ scope: { name: 't' }, spans: [{
            traceId: '11111111111111111111111111111111', spanId: 'bbbbbbbbbbbbbbbb',
            parentSpanId: 'aaaaaaaaaaaaaaaa', name: 'POST /orders', kind: 2,
            startTimeUnixNano: '5000000', endTimeUnixNano: '15000000',
            status: { code: 1 }, attributes: [{ key: 'http.method', value: { stringValue: 'POST' } }] },
          ]}]},
        { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payments' } }] },
          scopeSpans: [{ scope: { name: 't' }, spans: [{
            traceId: '11111111111111111111111111111111', spanId: 'cccccccccccccccc',
            parentSpanId: 'bbbbbbbbbbbbbbbb', name: 'POST /charge', kind: 2,
            startTimeUnixNano: '8000000', endTimeUnixNano: '11000000',
            status: { code: 2 }, attributes: [{ key: 'http.method', value: { stringValue: 'POST' } }] },
          ]}]},
      ],
    }
    const rowObjects = flattenResourceSpans(payload)
    for (const r of rowObjects) {
      await pgClient.query(
        `INSERT INTO otel_spans_raw (
           tenant_id, trace_id, span_id, parent_span_id,
           service_name, service_namespace, deployment_environment,
           span_name, span_kind, start_time_ns, end_time_ns,
           status_code, attributes, resource_attributes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [tenantId, r.trace_id, r.span_id, r.parent_span_id,
         r.service_name, r.service_namespace, r.deployment_environment,
         r.span_name, r.span_kind, r.start_time_ns, r.end_time_ns,
         r.status_code, r.attributes, r.resource_attributes],
      )
    }

    // ── Aggregate in memory, emit to Neo4j manually (mirroring runTick) ──
    const { rows } = await pgClient.query(
      `SELECT id, span_id, parent_span_id,
              service_name, service_namespace, deployment_environment,
              start_time_ns, end_time_ns, status_code,
              attributes, resource_attributes
         FROM otel_spans_raw ORDER BY start_time_ns`,
    )
    const { components, edges } = aggregateBatch(rows)
    expect(components.map(c => c.name).sort()).toEqual(['frontend', 'orders', 'payments'])
    expect(edges.length).toBe(2)

    const teleLabels = TELEMETRY_COMPONENT_LABELS.join(':')
    await fakeFastify.neo4j.write(`
      UNWIND $components AS c
      MERGE (comp:Component { name: c.name, origin_source: 'otel', origin_namespace: c.namespace })
        ON CREATE SET comp.id = randomUUID()
      SET comp:${teleLabels},
          comp.environment           = c.environment,
          comp.source                = 'otel',
          comp.sample_resource_attrs = c.sampleResourceAttrsJson
    `, { components })

    await fakeFastify.neo4j.write(`
      UNWIND $edges AS e
      MATCH (src:Component { name: e.srcName, origin_source: 'otel', origin_namespace: e.srcNs })
      MATCH (dst:Component { name: e.dstName, origin_source: 'otel', origin_namespace: e.dstNs })
      MERGE (src)-[r:CONNECTED_TO { source: 'otel', via: e.via }]->(dst)
      SET   r.rps = e.rps, r.error_rate = e.errorRate,
            r.p50_ms = e.p50Ms, r.p95_ms = e.p95Ms,
            r.route = e.route
    `, { edges })

    // ── Verify :Component nodes ──
    const compRes = await fakeFastify.neo4j.query(
      `MATCH (c:Component {origin_source:'otel'}) RETURN c.name AS name, labels(c) AS labels ORDER BY name`,
    )
    const compNames = compRes.map(r => r.get('name'))
    expect(compNames).toEqual(['frontend', 'orders', 'payments'])
    for (const r of compRes) {
      expect(r.get('labels')).toEqual(expect.arrayContaining(['Component', 'TelemetryService', 'Workload']))
    }

    // ── Verify :CONNECTED_TO edges with OTel provenance + error rate ──
    const edgeRes = await fakeFastify.neo4j.query(
      `MATCH (a:Component {origin_source:'otel'})-[r:CONNECTED_TO {source:'otel'}]->(b:Component {origin_source:'otel'})
       RETURN a.name AS src, b.name AS dst, r.via AS via, r.error_rate AS err
       ORDER BY src`,
    )
    const summary = edgeRes.map(r => `${r.get('src')}→${r.get('dst')} (err=${r.get('err')})`).join(',')
    expect(summary).toContain('frontend→orders (err=0)')
    expect(summary).toContain('orders→payments (err=1)')

    // ── Ontology constant is kept in sync: via keys have a typed alias ──
    for (const e of edges) expect(VIA_TO_REL_TYPE[e.via]).toBeDefined()
  })
})
