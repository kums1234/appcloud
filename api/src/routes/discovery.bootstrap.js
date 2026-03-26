export async function bootstrapDiscovery(fastify) {
  const { write, query } = fastify.neo4j

  function parse(val) {
    try { return typeof val === 'string' ? JSON.parse(val) : val || {} } catch { return {} }
  }

  function inferComponent(type = '', name = '') {
    const t = type.toLowerCase()
    if (t.includes('rds') || t.includes('sql')) return 'database'
    if (t.includes('redis')) return 'cache'
    if (t.includes('function')) return 'function'
    if (t.includes('load_balancer')) return 'gateway'
    if (t.includes('cluster')) return 'platform'
    if (name.includes('api')) return 'api'
    if (name.includes('worker')) return 'worker'
    return 'service'
  }

  const infraRecords = await query(`
    MATCH (i:Infra)
    WHERE i.source = 'discovery'
      AND NOT (:Component)-[:DEPLOYED_ON]->(i)
    RETURN i
  `)

  let createdApps = 0
  let createdComponents = 0
  let linked = 0

  for (const ir of infraRecords) {
    const i = ir.get('i').properties
    const tags = parse(i.tags)
    const name = (i.name || '').toLowerCase()

    const appName = tags.app || tags.application || tags.project || name.split('-')[0] || 'default-app'
    const componentName = tags.component || tags.service || inferComponent(i.resource_type, name)

    const appRes = await write(`
      MERGE (a:Application {name: $appName})
      ON CREATE SET a.id = randomUUID(), a.tier = 3
      RETURN a
    `, { appName })

    const appId = appRes[0].get('a').properties.id
    if (appRes[0].get('a').properties) createdApps++

    const compRes = await write(`
      MATCH (a:Application {id: $appId})
      MERGE (a)-[:CONTAINS]->(c:Component {name: $componentName})
      ON CREATE SET c.id = randomUUID()
      RETURN c
    `, { appId, componentName })

    const compId = compRes[0].get('c').properties.id
    if (compId) createdComponents++

    await write(`
      MATCH (c:Component {id: $compId})
      MATCH (i:Infra {id: $infraId})
      MERGE (c)-[:DEPLOYED_ON]->(i)
    `, { compId, infraId: i.id })

    linked++
  }

  return { createdApps, createdComponents, linked, total: infraRecords.length }
}