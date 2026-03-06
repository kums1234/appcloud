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

  const driver = neo4j.driver(
    process.env.NEO4J_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(username, password)
  )

  try {
    await driver.verifyConnectivity()
    fastify.log.info('Neo4j connected successfully')
  } catch (err) {
    fastify.log.error('Neo4j connection failed:', err.message)
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
}