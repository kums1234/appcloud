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

  fastify.log.info(`Neo4j connecting to: ${uri}`)

  const driver = neo4j.driver(
    uri,
    neo4j.auth.basic(username, password)
  )

  try {
    await driver.verifyConnectivity()
    fastify.log.info('Neo4j connected successfully')
  } catch (err) {
    fastify.log.error({ err }, 'Neo4j connection failed')
    throw err
  }

  const query = async (cypher, params = {}) => {
    const session = driver.session()
    try {
      const result = await session.run(cypher, params)
      return result.records
    } finally {
      await session.close()
    }
  }

  const write = async (cypher, params = {}) => {
    const session = driver.session({ defaultAccessMode: neo4j.session.WRITE })
    try {
      const result = await session.executeWrite(tx => tx.run(cypher, params))
      return result.records
    } finally {
      await session.close()
    }
  }

  fastify.decorate('neo4j', { driver, query, write })
  fastify.addHook('onClose', async () => { await driver.close() })

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

  // Run index creation in parallel, best-effort (never block startup)
  try {
    await Promise.allSettled(indexes.map(idx => write(idx)))
    fastify.log.info(`Neo4j indexes ensured (${indexes.length} indexes)`)
  } catch (err) {
    fastify.log.warn(`Neo4j index creation: ${err.message}`)
  }
}