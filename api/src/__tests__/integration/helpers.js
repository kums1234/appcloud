// __tests__/integration/helpers.js
//
// Shared scaffolding for the Testcontainers-backed integration tests
// (cmdb-assessment, otel-pipeline, future ones). The two test files
// previously hand-rolled identical container start-up + driver-wrapping
// boilerplate; centralising it here means a Testcontainers API change
// (like the v10.28 `withoutAuthentication()` removal) is a one-file edit.
//
// What's exported:
//
//   getMaybeDescribe(testName)
//     Returns Jest's `describe` or `describe.skip` based on Docker and
//     Node-version availability. Logs a one-line warning when skipping
//     so the suite output makes the reason obvious.
//
//   startNeo4j({ image?, password? })
//     Boots a Neo4j container with an explicit password (Testcontainers
//     v10.28+ no longer supports `withoutAuthentication()`). Returns the
//     container plus a `neo4j-driver` instance bound to it.
//
//   startPostgres({ image?, database?, username?, password? })
//     Boots a Postgres container. Returns the container plus a connected
//     `pg.Client`.
//
//   wrapNeo4jDriver(driver)
//     Mirrors the `query` / `write` shape that the Fastify decorators
//     expose at runtime. Each call opens a fresh session, runs the
//     statement, returns `records`, and closes — same isolation the
//     production code paths get.
//
//   applyPostgresInitFiles(client, files)
//     Applies SQL files from postgres-init/ in the order given. Used to
//     seed a fresh container with schema + evolutions before the test
//     does its work.

import { describe } from '@jest/globals'

// ── Skip gate ────────────────────────────────────────────────────────────────

const NODE_MAJOR     = parseInt(process.versions.node.split('.')[0], 10)
const NODE_SUPPORTED = NODE_MAJOR >= 18 && NODE_MAJOR <= 22
let DOCKER_AVAILABLE = false
try {
  const { execSync } = await import('child_process')
  execSync('docker info', { stdio: 'ignore', timeout: 5000 })
  DOCKER_AVAILABLE = true
} catch { /* docker unavailable — describe.skip below */ }

export function getMaybeDescribe(testName) {
  if (DOCKER_AVAILABLE && NODE_SUPPORTED) return describe
  if (DOCKER_AVAILABLE && !NODE_SUPPORTED) {
    // eslint-disable-next-line no-console
    console.warn(
      `[${testName}] skipped: Node ${NODE_MAJOR} not supported by Testcontainers 10.x; ` +
      `use Node 20 or 22 LTS`,
    )
  }
  return describe.skip
}

// ── Neo4j ────────────────────────────────────────────────────────────────────

export async function startNeo4j({ image = 'neo4j:5', password = 'test1234' } = {}) {
  const { Neo4jContainer } = await import('@testcontainers/neo4j')
  const neo4jModule        = await import('neo4j-driver')
  const neo4j              = neo4jModule.default || neo4jModule

  const container = await new Neo4jContainer(image).withPassword(password).start()
  const driver    = neo4j.driver(
    container.getBoltUri(),
    neo4j.auth.basic(container.getUsername(), container.getPassword()),
  )
  return { container, driver }
}

// `query` and `write` mirror the production fastify.neo4j shape: each call
// opens a fresh session, runs the statement, returns `records`, closes the
// session. Tests that build a `ctx` for service-layer entry points should use
// this wrapper rather than raw driver sessions so the contract stays one
// place.
export function wrapNeo4jDriver(driver) {
  const run = async (cypher, params = {}) => {
    const session = driver.session()
    try { return (await session.run(cypher, params)).records }
    finally { await session.close() }
  }
  return { query: run, write: run }
}

// ── Postgres ─────────────────────────────────────────────────────────────────

export async function startPostgres({
  image    = 'postgres:16-alpine',
  database = 'appcloud',
  username = 'appcloud',
  password = 'pw',
} = {}) {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql')
  const pgModule                = await import('pg')
  const Client                  = pgModule.default?.Client || pgModule.Client

  const container = await new PostgreSqlContainer(image)
    .withDatabase(database)
    .withUsername(username)
    .withPassword(password)
    .start()

  const client = new Client({
    host:     container.getHost(),
    port:     container.getMappedPort(5432),
    database, user: username, password,
  })
  await client.connect()
  return { container, client }
}

// Apply DDL files from <repo>/postgres-init in the order given. The path is
// resolved relative to this file, so tests don't need to compute their own
// `import.meta.url` / repo-root climb.
export async function applyPostgresInitFiles(client, files) {
  const fs   = await import('node:fs/promises')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const initDir = path.resolve(here, '../../../../postgres-init')
  for (const f of files) {
    const sql = await fs.readFile(path.join(initDir, f), 'utf8')
    await client.query(sql)
  }
}
