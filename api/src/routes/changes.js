// routes/changes.js
const toInt = v => v == null ? null : typeof v.toNumber === 'function' ? v.toNumber() : Number(v)

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
      ...r.get('ch').properties,
      submittedBy: r.get('submittedBy')
    }))
  })

  // GET /changes/:id — change with full blast radius
  fastify.get('/:id', async (req, reply) => {
    const records = await query(`
      MATCH (ch:Change {id: $id})
      OPTIONAL MATCH (submitter:User)-[:SUBMITTED]->(ch)
      OPTIONAL MATCH (approver:User)-[approved:APPROVED]->(ch)
      OPTIONAL MATCH (rejector:User)-[rejected:REJECTED]->(ch)
      OPTIONAL MATCH (ch)-[:MODIFIES]->(modified)
      OPTIONAL MATCH (ch)-[:AFFECTS]->(affected:Application)
      RETURN ch,
        submitter.name AS submittedBy,
        approver.name AS approvedBy,
        approved.at AS approvedAt,
        rejector.name AS rejectedBy,
        rejected.reason AS rejectionReason,
        collect(DISTINCT {label: labels(modified)[0], name: modified.name, id: modified.id}) AS modifies,
        collect(DISTINCT {name: affected.name, id: affected.id, tier: affected.tier}) AS affects
    `, { id: req.params.id })

    if (!records.length) return reply.notFound('Change not found')
    const r = records[0]
    return {
      ...r.get('ch').properties,
      submittedBy: r.get('submittedBy'),
      approvedBy: r.get('approvedBy'),
      approvedAt: r.get('approvedAt'),
      rejectedBy: r.get('rejectedBy'),
      rejectionReason: r.get('rejectionReason'),
      modifies: r.get('modifies').filter(m => m.name !== null),
      affects: r.get('affects').filter(a => a.name !== null)
    }
  })

  // POST /changes — submit a new change
  fastify.post('/', async (req, reply) => {
    const { description, riskScore, submittedBy, modifiesIds, affectsIds } = req.body
    const records = await write(`
      MATCH (u:User {id: $submittedBy})
      CREATE (ch:Change {
        id: randomUUID(),
        status: "draft",
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
      affectsIds: affectsIds || []
    })

    reply.code(201)
    return records[0].get('ch').properties
  })

  // POST /changes/:id/approve
  fastify.post('/:id/approve', async (req, reply) => {
    const { userId } = req.body
    const records = await write(`
      MATCH (ch:Change {id: $id}), (u:User {id: $userId})
      WHERE ch.status = "draft"
      SET ch.status = "approved"
      CREATE (u)-[:APPROVED {at: datetime()}]->(ch)
      RETURN ch
    `, { id: req.params.id, userId })

    if (!records.length) return reply.badRequest('Change not found or not in draft status')
    return records[0].get('ch').properties
  })

  // POST /changes/:id/reject
  fastify.post('/:id/reject', async (req, reply) => {
    const { userId, reason } = req.body
    const records = await write(`
      MATCH (ch:Change {id: $id}), (u:User {id: $userId})
      WHERE ch.status = "draft"
      SET ch.status = "rejected"
      CREATE (u)-[:REJECTED {at: datetime(), reason: $reason}]->(ch)
      RETURN ch
    `, { id: req.params.id, userId, reason })

    if (!records.length) return reply.badRequest('Change not found or not in draft status')
    return records[0].get('ch').properties
  })

  // POST /changes/impact-preview — analyse impact BEFORE creating a change
  // Body: { targetIds: [id, ...] }  (mix of Component and Infra IDs)
  fastify.post('/impact-preview', async (req, reply) => {
    const { targetIds = [] } = req.body
    if (!targetIds.length) return { affectedComponents: [], affectedApplications: [], teams: [], riskScore: 0 }

    // For each target (Component or Infra), walk outward through the graph
    const [compRecords, infraRecords] = await Promise.all([
      // Direct component targets + everything that CONNECTS_TO them (transitive)
      query(`
        UNWIND $ids AS tid
        OPTIONAL MATCH (c:Component {id: tid})
        OPTIONAL MATCH (c)<-[:CONTAINS]-(a:Application)
        OPTIONAL MATCH (upstream:Component)-[:CONNECTS_TO*1..4]->(c)
        OPTIONAL MATCH (upstream)<-[:CONTAINS]-(upApp:Application)
        RETURN
          collect(DISTINCT {id: c.id, name: c.name, type: c.type, appName: a.name, appId: a.id, appOwner: a.owner, appTier: a.tier}) AS directComps,
          collect(DISTINCT {id: upstream.id, name: upstream.name, type: upstream.type, appName: upApp.name, appId: upApp.id, appOwner: upApp.owner, appTier: upApp.tier}) AS upstreamComps
      `, { ids: targetIds }),

      // Infra targets — find all components deployed on them + their upstream dependents
      query(`
        UNWIND $ids AS tid
        OPTIONAL MATCH (i:Infra {id: tid})
        OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
        OPTIONAL MATCH (c)<-[:CONTAINS]-(a:Application)
        OPTIONAL MATCH (upstream:Component)-[:CONNECTS_TO*1..4]->(c)
        OPTIONAL MATCH (upstream)<-[:CONTAINS]-(upApp:Application)
        RETURN
          collect(DISTINCT {id: i.id, name: i.name, provider: i.provider, resourceType: i.resource_type}) AS infraNodes,
          collect(DISTINCT {id: c.id, name: c.name, type: c.type, appName: a.name, appId: a.id, appOwner: a.owner, appTier: a.tier}) AS deployedComps,
          collect(DISTINCT {id: upstream.id, name: upstream.name, type: upstream.type, appName: upApp.name, appId: upApp.id, appOwner: upApp.owner, appTier: upApp.tier}) AS upstreamComps
      `, { ids: targetIds }),
    ])

    const cr = compRecords[0], ir = infraRecords[0]

    // Merge and deduplicate all affected components
    const allComps = [
      ...(cr?.get('directComps')   || []),
      ...(cr?.get('upstreamComps') || []),
      ...(ir?.get('deployedComps') || []),
      ...(ir?.get('upstreamComps') || []),
    ].filter(c => c.id)

    const seenComps = new Set()
    const affectedComponents = allComps.filter(c => {
      if (seenComps.has(c.id)) return false
      seenComps.add(c.id); return true
    })

    // Unique affected applications with owner info
    const appMap = {}
    affectedComponents.forEach(c => {
      if (c.appId && !appMap[c.appId]) {
        appMap[c.appId] = { id: c.appId, name: c.appName, owner: c.appOwner, tier: toInt(c.appTier) }
      }
    })
    const affectedApplications = Object.values(appMap)

    // Teams = unique owners of affected apps + infra owners (via app owners for now)
    const teamSet = new Set(affectedApplications.map(a => a.owner).filter(Boolean))
    const teams = [...teamSet].map(t => ({ name: t }))

    // Risk score heuristic:
    // Base: 2 per Tier-1 app, 1.5 per Tier-2, 1 per Tier-3+
    // +1 per 3 affected components, max 10
    const tierScore = affectedApplications.reduce((s, a) => {
      return s + (a.tier === 1 ? 2 : a.tier === 2 ? 1.5 : 1)
    }, 0)
    const compScore = affectedComponents.length / 3
    const infraNodes = ir?.get('infraNodes')?.filter(i => i.id) || []
    const riskScore  = Math.min(10, parseFloat((tierScore + compScore + (infraNodes.length > 0 ? 1 : 0)).toFixed(1)))

    return {
      affectedComponents,
      affectedApplications,
      teams,
      infraNodes,
      riskScore,
    }
  })

  // GET /changes/:id/blast-radius — everything a change touches
  fastify.get('/:id/blast-radius', async (req, reply) => {
    const records = await query(`
      MATCH (ch:Change {id: $id})-[:MODIFIES]->(n)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(:Component)-[:DEPLOYED_ON]->(n)
      WITH ch, n, collect(DISTINCT a) AS indirectApps
      OPTIONAL MATCH (ch)-[:AFFECTS]->(directApp:Application)
      RETURN ch.description AS change,
             ch.riskScore AS riskScore,
             collect(DISTINCT {label: labels(n)[0], name: n.name}) AS directlyModified,
             collect(DISTINCT directApp.name) AS directlyAffected,
             collect(DISTINCT [app IN indirectApps | app.name]) AS indirectlyAffected
    `, { id: req.params.id })

    if (!records.length) return reply.notFound('Change not found')
    const r = records[0]
    return {
      change: r.get('change'),
      riskScore: r.get('riskScore'),
      directlyModified: r.get('directlyModified'),
      directlyAffected: r.get('directlyAffected'),
      indirectlyAffected: [...new Set(r.get('indirectlyAffected').flat())]
    }
  })

  // GET /changes/high-risk — approved changes above risk threshold
  fastify.get('/risk/high', async (req, reply) => {
    const threshold = parseFloat(req.query.threshold || '7.0')
    const records = await query(`
      MATCH (u:User)-[:APPROVED]->(ch:Change)
      WHERE ch.riskScore >= $threshold
      RETURN ch, u.name AS approvedBy
      ORDER BY ch.riskScore DESC
    `, { threshold })

    return records.map(r => ({
      ...r.get('ch').properties,
      approvedBy: r.get('approvedBy')
    }))
  })
}