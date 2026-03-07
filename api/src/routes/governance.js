import { props, serialize } from '../utils/serialize.js'

export default async function governanceRoutes(fastify) {
  const { query } = fastify.neo4j

  // GET /governance/summary — headline compliance metrics
  fastify.get('/summary', async (req, reply) => {
    const [changeRecords, riskRecords, appRecords, infraRecords] = await Promise.all([

      // Change approval stats
      query(`
        OPTIONAL MATCH (ch:Change)
        OPTIONAL MATCH (approved:Change {status:"approved"})
        OPTIONAL MATCH (rejected:Change {status:"rejected"})
        OPTIONAL MATCH (draft:Change    {status:"draft"})
        OPTIONAL MATCH (high:Change) WHERE high.riskScore >= 7
        OPTIONAL MATCH (highApproved:Change {status:"approved"}) WHERE highApproved.riskScore >= 7
        OPTIONAL MATCH (unapproved:Change {status:"draft"})     WHERE unapproved.riskScore >= 7
        RETURN count(DISTINCT ch)            AS total,
               count(DISTINCT approved)      AS approvedCount,
               count(DISTINCT rejected)      AS rejectedCount,
               count(DISTINCT draft)         AS draftCount,
               count(DISTINCT high)          AS highRiskTotal,
               count(DISTINCT highApproved)  AS highRiskApproved,
               count(DISTINCT unapproved)    AS highRiskUnapproved
      `),

      // Average risk + unapproved high-risk changes detail
      query(`
        MATCH (ch:Change)
        RETURN avg(ch.riskScore) AS avgRisk,
               max(ch.riskScore) AS maxRisk
      `),

      // Applications without an owner (governance gap)
      query(`
        MATCH (a:Application)
        RETURN count(a) AS total,
               count(CASE WHEN a.owner IS NULL OR a.owner = "" THEN 1 END) AS unowned
      `),

      // Public-facing infra items (attack surface)
      query(`
        OPTIONAL MATCH (pub:Infra {public: true})
        OPTIONAL MATCH (priv:Infra {public: false})
        RETURN count(DISTINCT pub)  AS publicCount,
               count(DISTINCT priv) AS privateCount
      `),
    ])

    const c = changeRecords[0], r = riskRecords[0],
          a = appRecords[0],    i = infraRecords[0]

    const total        = serialize(c.get('total'))
    const approvedCount= serialize(c.get('approvedCount'))
    const approvalRate = total > 0 ? Math.round((approvedCount / total) * 100) : 0

    return {
      changes: {
        total,
        approved:           approvedCount,
        rejected:           serialize(c.get('rejectedCount')),
        draft:              serialize(c.get('draftCount')),
        approvalRate,
        highRiskTotal:      serialize(c.get('highRiskTotal')),
        highRiskApproved:   serialize(c.get('highRiskApproved')),
        highRiskUnapproved: serialize(c.get('highRiskUnapproved')),
      },
      risk: {
        avgScore: r ? Math.round((serialize(r.get('avgRisk')) || 0) * 10) / 10 : 0,
        maxScore: r ? serialize(r.get('maxRisk')) || 0 : 0,
      },
      applications: {
        total:   serialize(a.get('total')),
        unowned: serialize(a.get('unowned')),
      },
      infrastructure: {
        publicCount:  serialize(i.get('publicCount')),
        privateCount: serialize(i.get('privateCount')),
      },
    }
  })

  // GET /governance/policy-violations — things that breach governance rules
  fastify.get('/policy-violations', async (req, reply) => {
    const [
      unownedApps, highRiskUnapproved, publicInfraWithTier1,
      confOnPublic, tier1NoDeploy, selfApproved
    ] = await Promise.all([

      // POLICY 1: All applications must have an owner
      query(`
        MATCH (a:Application)
        WHERE a.owner IS NULL OR a.owner = ""
        RETURN "NO_OWNER" AS policy,
               "Application has no designated owner" AS description,
               "HIGH" AS severity,
               a.id AS resourceId, a.name AS resourceName, "Application" AS resourceType
      `),

      // POLICY 2: High-risk changes (score >= 7) must be approved before affecting Tier-1 apps
      query(`
        MATCH (ch:Change {status:"draft"})-[:AFFECTS]->(a:Application)
        WHERE ch.riskScore >= 7 AND a.tier = 1
        RETURN "HIGH_RISK_UNAPPROVED" AS policy,
               "High-risk change affecting Tier-1 app is not yet approved" AS description,
               "CRITICAL" AS severity,
               ch.id AS resourceId, ch.description AS resourceName, "Change" AS resourceType
      `),

      // POLICY 3: Tier-1 applications must not have public-facing infra without justification
      query(`
        MATCH (a:Application {tier:1})-[:CONTAINS]->(c:Component)-[:DEPLOYED_ON]->(i:Infra {public:true})
        RETURN "PUBLIC_INFRA_TIER1" AS policy,
               "Tier-1 application component deployed on public-facing infrastructure" AS description,
               "HIGH" AS severity,
               i.id AS resourceId, i.name AS resourceName, "Infra" AS resourceType
      `),

      // POLICY 3b: Restricted/Confidential apps must not have public-facing infra
      query(`
        MATCH (a:Application)-[:CONTAINS]->(c:Component)-[:DEPLOYED_ON]->(i:Infra {public:true})
        WHERE a.confidentiality IN ['restricted','confidential']
          AND NOT a.tier = 1
        RETURN "CONFIDENTIAL_ON_PUBLIC_INFRA" AS policy,
               "Confidential/Restricted application has components on public-facing infrastructure" AS description,
               "HIGH" AS severity,
               a.id AS resourceId, a.name AS resourceName, "Application" AS resourceType
      `),

      // POLICY 4: Tier-1 apps must have at least one deployed component
      query(`
        MATCH (a:Application {tier:1})
        WHERE NOT (a)-[:CONTAINS]->(:Component)-[:DEPLOYED_ON]->(:Infra)
        RETURN "NO_DEPLOYMENT_RECORD" AS policy,
               "Tier-1 application has no infrastructure deployment recorded" AS description,
               "MEDIUM" AS severity,
               a.id AS resourceId, a.name AS resourceName, "Application" AS resourceType
      `),

      // POLICY 5: A user should not approve their own submitted change
      query(`
        MATCH (u:User)-[:SUBMITTED]->(ch:Change)<-[:APPROVED]-(u)
        RETURN "SELF_APPROVED" AS policy,
               "Change was submitted and approved by the same user" AS description,
               "HIGH" AS severity,
               ch.id AS resourceId, ch.description AS resourceName, "Change" AS resourceType
      `),
    ])

    const all = [
      ...unownedApps, ...highRiskUnapproved, ...publicInfraWithTier1,
      ...confOnPublic, ...tier1NoDeploy, ...selfApproved
    ]

    const SEVERITY_ORDER = { CRITICAL:0, HIGH:1, MEDIUM:2, LOW:3 }
    return all
      .map(r => ({
        policy:       r.get('policy'),
        description:  r.get('description'),
        severity:     r.get('severity'),
        resourceId:   r.get('resourceId'),
        resourceName: r.get('resourceName'),
        resourceType: r.get('resourceType'),
      }))
      .sort((a,b) => (SEVERITY_ORDER[a.severity]||9) - (SEVERITY_ORDER[b.severity]||9))
  })

  // GET /governance/change-audit — full audit trail of all changes with actors
  fastify.get('/change-audit', async (req, reply) => {
    const records = await query(`
      MATCH (ch:Change)
      OPTIONAL MATCH (submitter:User)-[:SUBMITTED]->(ch)
      OPTIONAL MATCH (approver:User)-[:APPROVED]->(ch)
      OPTIONAL MATCH (rejector:User)-[:REJECTED]->(ch)
      OPTIONAL MATCH (ch)-[:AFFECTS]->(a:Application)
      RETURN ch,
             submitter.name AS submittedBy,
             approver.name  AS approvedBy,
             rejector.name  AS rejectedBy,
             collect(DISTINCT a.name) AS affectedApps
      ORDER BY ch.createdAt DESC
      LIMIT 100
    `)
    return records.map(r => ({
      ...props(r.get('ch')),
      submittedBy:  r.get('submittedBy'),
      approvedBy:   r.get('approvedBy'),
      rejectedBy:   r.get('rejectedBy'),
      affectedApps: r.get('affectedApps'),
    }))
  })

  // GET /governance/risk-heatmap — risk by application and tier
  fastify.get('/risk-heatmap', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application)
      OPTIONAL MATCH (ch:Change)-[:AFFECTS]->(a)
      RETURN a.id AS id, a.name AS name, a.tier AS tier,
             a.owner AS owner, a.environment AS environment,
             count(DISTINCT ch)  AS changeCount,
             avg(ch.riskScore)   AS avgRisk,
             max(ch.riskScore)   AS maxRisk,
             count(DISTINCT CASE WHEN ch.status = "draft" THEN ch END) AS pendingChanges
      ORDER BY a.tier ASC, avgRisk DESC
    `)
    return records.map(r => ({
      id:             r.get('id'),
      name:           r.get('name'),
      tier:           serialize(r.get('tier')),
      owner:          r.get('owner'),
      environment:    r.get('environment'),
      changeCount:    serialize(r.get('changeCount')),
      avgRisk:        r.get('avgRisk') ? Math.round(serialize(r.get('avgRisk')) * 10) / 10 : 0,
      maxRisk:        serialize(r.get('maxRisk')) || 0,
      pendingChanges: serialize(r.get('pendingChanges')),
    }))
  })

  // GET /governance/compliance-report — exportable summary
  fastify.get('/compliance-report', async (req, reply) => {
    const [summary, violations, audit] = await Promise.all([
      fastify.inject({ method:'GET', url:'/governance/summary' }).then(r => JSON.parse(r.body)),
      fastify.inject({ method:'GET', url:'/governance/policy-violations' }).then(r => JSON.parse(r.body)),
      fastify.inject({ method:'GET', url:'/governance/change-audit' }).then(r => JSON.parse(r.body)),
    ])
    return {
      generatedAt: new Date().toISOString(),
      period: 'all-time',
      summary,
      policyViolations: violations,
      recentChanges: audit.slice(0, 20),
      complianceScore: calculateComplianceScore(summary, violations),
    }
  })
}

// (unused server-side — score is computed client-side)
function calculateComplianceScore(summary, violations) {
  let score = 100
  const c = summary?.changes || {}
  const criticals = violations.filter(v => v.severity === 'CRITICAL').length
  const highs     = violations.filter(v => v.severity === 'HIGH').length
  const mediums   = violations.filter(v => v.severity === 'MEDIUM').length
  score -= criticals * 15
  score -= highs     * 8
  score -= mediums   * 3
  if (c.approvalRate < 80)  score -= 10
  if (c.highRiskUnapproved > 0) score -= 5 * c.highRiskUnapproved
  if (summary?.applications?.unowned > 0) score -= 5
  return Math.max(0, Math.min(100, score))
}