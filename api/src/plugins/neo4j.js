import neo4j from 'neo4j-driver'
import fs from 'fs'

function readSecret(fileEnvVar, plainEnvVar, fallback = '') {
  const filePath = process.env[fileEnvVar]
  if (filePath) {
    try { return fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  return process.env[plainEnvVar] || fallback
}

// Called directly on the root fastify instance — no encapsulation issues
export async function neo4jPlugin(fastify) {
  const username = readSecret('DB_USERNAME_FILE', 'NEO4J_USER', 'neo4j')
  const password = readSecret('DB_PASSWORD_FILE', 'NEO4J_PASSWORD', '')

  // Use APPCLOUD_NEO4J_URI instead of NEO4J_URI.
  // When deployed on Kubernetes, the Neo4j service injects env vars like
  // NEO4J_PORT=tcp://10.x.x.x:7474 into every pod in the namespace.
  // The Neo4j JS driver scans all NEO4J_* env vars and treats NEO4J_PORT
  // as a connection URI, overriding the bolt://neo4j:7687 we intend to use.
  // A non-NEO4J_-prefixed name is invisible to the driver's env var scanner.
  const uri = process.env.APPCLOUD_NEO4J_URI
           || process.env.NEO4J_URI  // fallback for docker-compose compatibility
           || 'bolt://localhost:7687'

  // TLS — `bolt+s://` (verified) and `bolt+ssc://` (self-signed-cert
  // tolerated) flip on driver-side encryption. The driver picks up the
  // scheme on its own, so all we do here is warn when prod-shaped
  // hostnames stay on plaintext bolt://. See DEVELOPMENT.md "Internal TLS
  // posture" — current default is plaintext intra-cluster on K8s.
  const isPlainBolt = /^bolt:\/\//.test(uri) || /^neo4j:\/\//.test(uri)
  const looksRemote = !/(localhost|127\.0\.0\.1|::1|\bneo4j\b)/i.test(uri)
  if (isPlainBolt && /^(true|1|yes)$/i.test(process.env.APPCLOUD_REQUIRE_TLS || '')) {
    // Hard-fail: APPCLOUD_REQUIRE_TLS=true means refuse to start without
    // an encrypted connection, regardless of host shape.
    throw new Error(
      `[neo4j] APPCLOUD_REQUIRE_TLS=true but URI ${uri} is plaintext — ` +
      `switch APPCLOUD_NEO4J_URI to bolt+s:// (or neo4j+s://, or bolt+ssc:// for self-signed certs) ` +
      `or unset APPCLOUD_REQUIRE_TLS`,
    )
  }
  if (isPlainBolt && looksRemote) {
    fastify.log.warn(
      `[neo4j] ${uri} is unencrypted — switch to bolt+s:// (or neo4j+s://) when ` +
      `the target is outside the cluster trust boundary`,
    )
  }

  fastify.log.info(`Neo4j connecting to: ${uri}`)

  // Graceful degradation: if Neo4j is unreachable at boot, decorate
  // with a stub that returns 503 from query/write rather than crashing
  // the entire API. The previous behaviour (throw on verifyConnectivity
  // failure) meant a Neo4j rolling restart, version upgrade, or pre-
  // ready-state during a fresh deploy would crash-loop the API pods.
  // The /ready endpoint (server.js) probes connectivity per-request so
  // K8s can route traffic away from a pod whose Neo4j is degraded.
  let driver
  let connected = false
  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password))
    await driver.verifyConnectivity()
    connected = true
    fastify.log.info('Neo4j connected successfully')
  } catch (err) {
    fastify.log.error({ err: err.message, uri }, 'Neo4j connection failed — decorating fastify.neo4j with a 503 stub')
    if (driver) { try { await driver.close() } catch {} }
    driver = null
  }

  const unavailableErr = () => Object.assign(
    new Error('neo4j unavailable'),
    { code: 'NEO4J_UNAVAILABLE', statusCode: 503 },
  )

  const query = connected
    ? async (cypher, params = {}) => {
        const session = driver.session()
        try {
          const result = await session.run(cypher, params)
          return result.records
        } finally {
          await session.close()
        }
      }
    : async () => { throw unavailableErr() }

  const write = connected
    ? async (cypher, params = {}) => {
        const session = driver.session({ defaultAccessMode: neo4j.session.WRITE })
        try {
          const result = await session.executeWrite(tx => tx.run(cypher, params))
          return result.records
        } finally {
          await session.close()
        }
      }
    : async () => { throw unavailableErr() }

  // verifyConnectivity() called from /ready with a tight timeout; the
  // stub returns immediately so a degraded pod stays unready instead
  // of hanging until the probe deadline.
  const ping = connected
    ? async () => { await driver.verifyConnectivity(); return true }
    : async () => { throw unavailableErr() }

  fastify.decorate('neo4j', { driver, query, write, ping, connected })
  fastify.addHook('onClose', async () => { if (driver) await driver.close() })

  // ── Ensure indexes on startup ──────────────────────────────────────────
  // Creates indexes for core Infra properties and typed labels.
  // CREATE INDEX IF NOT EXISTS is idempotent — safe to run every startup.
  const indexes = [
    // Core Infra indexes
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.id)',
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.cloud_id)',
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.provider)',
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.resource_type)',
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.lastupdated)',
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.firstseen)',
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.source)',
    // Promoted field indexes
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.resource_group)',
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.server_farm_id)',
    'CREATE INDEX IF NOT EXISTS FOR (i:Infra) ON (i.private_ip)',
    // Typed label indexes (ontology categories)
    'CREATE INDEX IF NOT EXISTS FOR (n:ComputeInstance) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:DatabaseInstance) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:ContainerCluster) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:WebService) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:ServerlessFunction) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:CacheInstance) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:ObjectStorage) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:NetworkDevice) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:MessageBroker) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:MonitoringService) ON (n.id)',
    'CREATE INDEX IF NOT EXISTS FOR (n:SecretsManager) ON (n.id)',
    // Application & Component indexes
    'CREATE INDEX IF NOT EXISTS FOR (a:Application) ON (a.id)',
    'CREATE INDEX IF NOT EXISTS FOR (a:Application) ON (a.name)',
    'CREATE INDEX IF NOT EXISTS FOR (c:Component) ON (c.id)',
    'CREATE INDEX IF NOT EXISTS FOR (c:Component) ON (c.name)',
  ]

  // Run index creation in parallel, best-effort (never block startup).
  // Skipped when Neo4j is unreachable (stub mode) since `write()` would
  // throw NEO4J_UNAVAILABLE for every index.
  if (connected) {
    try {
      await Promise.allSettled(indexes.map(idx => write(idx)))
      fastify.log.info(`Neo4j indexes ensured (${indexes.length} indexes)`)
    } catch (err) {
      fastify.log.warn(`Neo4j index creation: ${err.message}`)
    }
  } else {
    fastify.log.warn('[neo4j] index creation skipped — Neo4j unavailable (stub mode)')
  }
}