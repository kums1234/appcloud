import fp from 'fastify-plugin'
import neo4j from 'neo4j-driver'
import fs from 'fs'

// Read a value from a Docker secret file, falling back to a plain env var.
// Docker mounts secrets as files at the path given by the *_FILE env var.
// This pattern keeps plaintext credentials out of environment variables entirely.
function readSecret(fileEnvVar, plainEnvVar, fallback = '') {
  const filePath = process.env[fileEnvVar]
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim()
    } catch {
      // file not present — fall through
    }
  }
  return process.env[plainEnvVar] || fallback
}

async function neo4jPlugin(fastify, options) {
  const username = readSecret('DB_USERNAME_FILE', 'NEO4J_USER', 'neo4j')
  const password = readSecret('DB_PASSWORD_FILE', 'NEO4J_PASSWORD', '')

  const driver = neo4j.driver(
    process.env.NEO4J_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(username, password)
  )

  // Verify connectivity on startup
  try {
    await driver.verifyConnectivity()
    fastify.log.info('Neo4j connected successfully')
  } catch (err) {
    fastify.log.error('Neo4j connection failed:', err)
    throw err
  }

  // Helper to run a read query and return records
  const query = async (cypher, params = {}) => {
    const session = driver.session()
    try {
      const result = await session.run(cypher, params)
      return result.records
    } finally {
      await session.close()
    }
  }

  // Helper to run a write query in a transaction
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

  fastify.addHook('onClose', async () => {
    await driver.close()
    fastify.log.info('Neo4j driver closed')
  })
}

export default fp(neo4jPlugin)