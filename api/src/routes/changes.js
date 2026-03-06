import { props, serialize } from '../utils/serialize.js'

const toInt = v => v == null ? null : typeof v?.toNumber === 'function' ? v.toNumber() : Number(v)

export default async function changeRoutes(fastify) {
  const { query, write } = fastify.neo4j

  // GET /changes
  fastify.get('/', async (req, reply) => {
    const { status } = req.query
    const records = await query(`
      MATCH (ch:Change)
      ${status ? 'WHERE ch.status = $status' : ''}
      OPTIONAL MATCH (u:User)-[:SUBMITTED]->(ch)
      RETURN ch, u.name AS submittedBy
      ORDER BY ch.createdAt DESC
    `, { status })
    return records.map(r => ({
      ...props(r.get('ch')),
      submittedBy: r.get('submittedBy'),
    }))
  })

  // GET /changes/:id
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (ch:Change {id: $id})
      OPTIONAL MATCH (submitter:User)-[:SUBMITTED]->(ch)
      OPTIONAL MATCH (approver:User)-[:APPROVED]->(ch)
      OPTIONAL MATCH (ch)-[:MODIFIES]->(modified)
      OPTIONAL MATCH (ch)-[:AFFECTS]->(affected:Application)
      RETURN ch,
        submitter.name AS submittedBy,
        approver.name  AS approvedBy,
        collect(DISTINCT {label: labels(modified)[0], name: modified.name}) AS modifies,
        collect(DISTINCT affected.name) AS affects
    `, { id: req.params.id })
    if (!records.length) return reply.notFound('Change not found')
    const r = records[0]
    return {
      ...props(r.get('ch')),
      submittedBy: r.get('submittedBy'),
      approvedBy:  r.get('approvedBy'),
      modifies:    r.get('modifies'),
      affects:     r.get('affects'),
    }
  })

  // POST /changes
  fastify.post('/', async (req, reply) => {
    const { description, riskScore, submittedBy, modifiesIds, affectsIds } = req.body
    const records = await write(`
      MATCH (u:User {id: $submittedBy})
      CREATE (ch:Change {
        id: randomUUID(), status: "draft",
        createdAt: datetime(),
        riskScore: $riskScore,
        description: $description
      })
      CREATE (u)-[:SUBMITTED]->(ch)
      WITH ch
      UNWIND $modifiesIds AS mId
        MATCH (n {id: mId})
        CREATE (ch)-[:MODIFIES]->(n)
      WITH ch
      UNWIND $affectsIds AS aId
        MATCH (a:Application {id: aId})
        MERGE (ch)-[:AFFECTS]->(a)
      RETURN ch
    `, {
      description,
      riskScore: parseFloat(riskScore),
      submittedBy,
      modifiesIds: modifiesIds || [],
      affectsIds:  affectsIds  || [],
    })
    reply.code(201)
    return props(records[0].get('ch'))
  })

  // POST /changes/:id/approve
  fastify.post('/:id/approve', async (req, reply) => {
    const { userId } = req.body
    const records = await write(`
      MATCH (ch:Change {id: $id}), (u:User {id: $userId})
      SET ch.status = "approved", ch.approvedAt = datetime()
      CREATE (u)-[:APPROVED]->(ch)
      RETURN ch
    `, { id: req.params.id, userId })
    if (!records.length) return reply.notFound('Change not found')
    return props(records[0].get('ch'))
  })

  // POST /changes/:id/reject
  fastify.post('/:id/reject', async (req, reply) => {
    const { userId, reason } = req.body
    const records = await write(`
      MATCH (ch:Change {id: $id}), (u:User {id: $userId})
      SET ch.status = "rejected", ch.rejectedAt = datetime(),
          ch.rejectionReason = $reason
      CREATE (u)-[:REJECTED]->(ch)
      RETURN ch
    `, { id: req.params.id, userId, reason })
    if (!records.length) return reply.notFound('Change not found')
    return props(records[0].get('ch'))
  })

  // GET /changes/:id/blast-radius
  fastify.get('/:id/blast-radius', async (req, reply) => {
    const records = await query(`
      MATCH (ch:Change {id: $id})-[:MODIFIES]->(n)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(:Component)-[:DEPLOYED_ON]->(n)
      WITH ch, n, collect(DISTINCT a) AS indirectApps
      OPTIONAL MATCH (ch)-[:AFFECTS]->(directApp:Application)
      RETURN ch.description AS change,
             ch.riskScore   AS riskScore,
             collect(DISTINCT {label: labels(n)[0], name: n.name}) AS directlyModified,
             collect(DISTINCT directApp.name)  AS directlyAffected,
             collect(DISTINCT [app IN indirectApps | app.name]) AS indirectlyAffected
    `, { id: req.params.id })
    if (!records.length) return reply.notFound('Change not found')
    const r = records[0]
    return {
      change:             r.get('change'),
      riskScore:          serialize(r.get('riskScore')),
      directlyModified:   r.get('directlyModified'),
      directlyAffected:   r.get('directlyAffected'),
      indirectlyAffected: [...new Set(r.get('indirectlyAffected').flat())],
    }
  })

  // POST /changes/impact-preview
  fastify.post('/impact-preview', async (req, reply) => {
    const { targetIds = [] } = req.body
    if (!targetIds.length) return { affectedComponents:[], affectedApplications:[], teams:[], riskScore:0 }

    const [compRecords, infraRecords] = await Promise.all([
      query(`
        UNWIND $ids AS tid
        OPTIONAL MATCH (c:Component {id: tid})
        OPTIONAL MATCH (c)<-[:CONTAINS]-(a:Application)
        OPTIONAL MATCH (upstream:Component)-[:CONNECTS_TO*1..4]->(c)
        OPTIONAL MATCH (upstream)<-[:CONTAINS]-(upApp:Application)
        RETURN
          collect(DISTINCT {id: c.id, name: c.name, type: c.type,
            appName: a.name, appId: a.id, appOwner: a.owner, appTier: a.tier}) AS directComps,
          collect(DISTINCT {id: upstream.id, name: upstream.name, type: upstream.type,
            appName: upApp.name, appId: upApp.id, appOwner: upApp.owner, appTier: upApp.tier}) AS upstreamComps
      `, { ids: targetIds }),
      query(`
        UNWIND $ids AS tid
        OPTIONAL MATCH (i:Infra {id: tid})
        OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
        OPTIONAL MATCH (c)<-[:CONTAINS]-(a:Application)
        OPTIONAL MATCH (upstream:Component)-[:CONNECTS_TO*1..4]->(c)
        OPTIONAL MATCH (upstream)<-[:CONTAINS]-(upApp:Application)
        RETURN
          collect(DISTINCT {id: i.id, name: i.name, provider: i.provider, resourceType: i.resource_type}) AS infraNodes,
          collect(DISTINCT {id: c.id, name: c.name, type: c.type,
            appName: a.name, appId: a.id, appOwner: a.owner, appTier: a.tier}) AS deployedComps,
          collect(DISTINCT {id: upstream.id, name: upstream.name, type: upstream.type,
            appName: upApp.name, appId: upApp.id, appOwner: upApp.owner, appTier: upApp.tier}) AS upstreamComps
      `, { ids: targetIds }),
    ])

    const cr = compRecords[0], ir = infraRecords[0]
    const allComps = [
      ...(serialize(cr?.get('directComps'))   || []),
      ...(serialize(cr?.get('upstreamComps')) || []),
      ...(serialize(ir?.get('deployedComps')) || []),
      ...(serialize(ir?.get('upstreamComps')) || []),
    ].filter(c => c.id)

    const seenComps = new Set()
    const affectedComponents = allComps.filter(c => {
      if (seenComps.has(c.id)) return false
      seenComps.add(c.id); return true
    })

    const appMap = {}
    affectedComponents.forEach(c => {
      if (c.appId && !appMap[c.appId])
        appMap[c.appId] = { id:c.appId, name:c.appName, owner:c.appOwner, tier:toInt(c.appTier) }
    })
    const affectedApplications = Object.values(appMap)
    const teams = [...new Set(affectedApplications.map(a => a.owner).filter(Boolean))].map(t => ({ name: t }))

    const tierScore  = affectedApplications.reduce((s,a) => s+(a.tier===1?2:a.tier===2?1.5:1), 0)
    const infraNodes = serialize(ir?.get('infraNodes'))?.filter(i => i.id) || []
    const riskScore  = Math.min(10, parseFloat((tierScore + affectedComponents.length/3 + (infraNodes.length?1:0)).toFixed(1)))

    return { affectedComponents, affectedApplications, teams, infraNodes, riskScore }
  })

  // GET /changes/risk/high
  fastify.get('/risk/high', async (req, reply) => {
    const { threshold = 7 } = req.query
    const records = await query(`
      MATCH (u:User)-[:APPROVED]->(ch:Change)
      WHERE ch.riskScore >= $threshold AND ch.status = "approved"
      RETURN ch, u.name AS approvedBy ORDER BY ch.riskScore DESC
    `, { threshold: parseFloat(threshold) })
    return records.map(r => ({ ...props(r.get('ch')), approvedBy: r.get('approvedBy') }))
  })
}