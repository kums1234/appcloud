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

  // GET /governance/compliance-report — exportable summary (JSON)
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

  // GET /governance/compliance-report/csv
  fastify.get('/compliance-report/csv', async (req, reply) => {
    const [summary, violations, audit] = await Promise.all([
      fastify.inject({ method:'GET', url:'/governance/summary' }).then(r => JSON.parse(r.body)),
      fastify.inject({ method:'GET', url:'/governance/policy-violations' }).then(r => JSON.parse(r.body)),
      fastify.inject({ method:'GET', url:'/governance/change-audit' }).then(r => JSON.parse(r.body)),
    ])
    const score = calculateComplianceScore(summary, violations)
    const ts    = new Date().toISOString()

    const lines = []

    // Header block
    lines.push(`AppCloud Compliance Report`)
    lines.push(`Generated,${ts}`)
    lines.push(`Compliance Score,${score}%`)
    lines.push(`Period,all-time`)
    lines.push(``)

    // Summary section
    lines.push(`SUMMARY`)
    lines.push(`Metric,Value`)
    lines.push(`Total Applications,${summary?.applications?.total ?? 0}`)
    lines.push(`Unowned Applications,${summary?.applications?.unowned ?? 0}`)
    lines.push(`Total Changes,${summary?.changes?.total ?? 0}`)
    lines.push(`Approval Rate,${summary?.changes?.approvalRate ?? 0}%`)
    lines.push(`High-Risk Unapproved,${summary?.changes?.highRiskUnapproved ?? 0}`)
    lines.push(`Public Infrastructure,${summary?.infrastructure?.public ?? 0}`)
    lines.push(``)

    // Violations section
    lines.push(`POLICY VIOLATIONS`)
    lines.push(`Policy,Severity,Resource,Detail`)
    for (const v of violations) {
      const detail = (v.detail || '').replace(/,/g, ';')
      lines.push(`${v.policy},${v.severity},${v.resource || ''},${detail}`)
    }
    lines.push(``)

    // Recent changes audit
    lines.push(`RECENT CHANGES (last 20)`)
    lines.push(`Title,Status,Risk Score,Submitted By,Created At`)
    for (const ch of audit.slice(0, 20)) {
      const title = (ch.title || '').replace(/,/g, ';')
      lines.push(`${title},${ch.status ?? ''},${ch.riskScore ?? ''},${ch.submittedBy ?? ''},${ch.createdAt ?? ''}`)
    }

    const csv = lines.join('\n')
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="appcloud-compliance-${ts.slice(0,10)}.csv"`)
      .send(csv)
  })

  // GET /governance/compliance-report/pdf  — returns HTML that the browser prints as PDF
  // The frontend triggers window.print() after loading this in a hidden iframe / new tab.
  fastify.get('/compliance-report/pdf', async (req, reply) => {
    const [summary, violations, audit] = await Promise.all([
      fastify.inject({ method:'GET', url:'/governance/summary' }).then(r => JSON.parse(r.body)),
      fastify.inject({ method:'GET', url:'/governance/policy-violations' }).then(r => JSON.parse(r.body)),
      fastify.inject({ method:'GET', url:'/governance/change-audit' }).then(r => JSON.parse(r.body)),
    ])
    const score = calculateComplianceScore(summary, violations)
    const ts    = new Date().toISOString()

    const SEV_COLOR  = { CRITICAL:'#f43f5e', HIGH:'#fb923c', MEDIUM:'#f59e0b', LOW:'#22c55e' }
    const scoreColor = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#f43f5e'

    const violationRows = violations.map(v => `
      <tr>
        <td>${v.policy ?? ''}</td>
        <td><span class="sev" style="background:${SEV_COLOR[v.severity] ?? '#64748b'}22;
            color:${SEV_COLOR[v.severity] ?? '#64748b'};
            border:1px solid ${SEV_COLOR[v.severity] ?? '#64748b'}44">${v.severity ?? ''}</span></td>
        <td>${v.resource ?? ''}</td>
        <td>${v.detail ?? ''}</td>
      </tr>`).join('')

    const changeRows = audit.slice(0, 20).map(ch => `
      <tr>
        <td>${ch.title ?? ''}</td>
        <td>${ch.status ?? ''}</td>
        <td>${ch.riskScore ?? ''}</td>
        <td>${ch.submittedBy ?? ''}</td>
        <td>${ch.createdAt ? ch.createdAt.slice(0,10) : ''}</td>
      </tr>`).join('')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>AppCloud Compliance Report — ${ts.slice(0,10)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #fff; color: #1e293b;
         padding: 40px 48px; font-size: 13px; line-height: 1.6 }
  h1   { font-size: 22px; font-weight: 800; color: #0f172a; margin-bottom: 4px }
  h2   { font-size: 14px; font-weight: 700; color: #0f172a; margin: 28px 0 10px;
         padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; text-transform: uppercase;
         letter-spacing: 0.06em }
  .meta  { font-size: 11px; color: #64748b; margin-bottom: 28px }
  .cards { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 28px }
  .card  { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px }
  .card .val  { font-size: 26px; font-weight: 800; color: #0f172a }
  .card .lbl  { font-size: 9px; color: #94a3b8; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 2px }
  .score-card { border-color: ${scoreColor}44; background: ${scoreColor}0a }
  .score-card .val { color: ${scoreColor} }
  table  { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px }
  th     { text-align: left; padding: 8px 10px; background: #f1f5f9; color: #475569;
           font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
           border-bottom: 1px solid #e2e8f0 }
  td     { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top }
  tr:last-child td { border-bottom: none }
  .sev   { padding: 2px 7px; border-radius: 3px; font-size: 9px; font-weight: 700;
           letter-spacing: 0.06em }
  .empty { color: #94a3b8; font-style: italic }
  @media print {
    body { padding: 20px 28px }
    .no-print { display: none }
    @page { margin: 1cm }
  }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
    <h1>AppCloud Compliance Report</h1>
    <button class="no-print" onclick="window.print()"
      style="padding:8px 18px;background:#0f172a;color:#fff;border:none;border-radius:6px;
             font-size:12px;font-weight:600;cursor:pointer">Print / Save PDF</button>
  </div>
  <div class="meta">Generated ${new Date(ts).toLocaleString()} &nbsp;·&nbsp; Period: all-time</div>

  <div class="cards">
    <div class="card score-card">
      <div class="val">${score}%</div>
      <div class="lbl">Compliance Score</div>
    </div>
    <div class="card">
      <div class="val">${violations.length}</div>
      <div class="lbl">Policy Violations</div>
    </div>
    <div class="card">
      <div class="val">${violations.filter(v=>v.severity==='CRITICAL').length}</div>
      <div class="lbl">Critical Issues</div>
    </div>
    <div class="card">
      <div class="val">${summary?.changes?.approvalRate ?? 0}%</div>
      <div class="lbl">Approval Rate</div>
    </div>
  </div>

  <h2>Summary Metrics</h2>
  <div class="cards" style="grid-template-columns:repeat(3,1fr)">
    <div class="card"><div class="val">${summary?.applications?.total ?? 0}</div><div class="lbl">Total Applications</div></div>
    <div class="card"><div class="val">${summary?.applications?.unowned ?? 0}</div><div class="lbl">Unowned Applications</div></div>
    <div class="card"><div class="val">${summary?.infrastructure?.public ?? 0}</div><div class="lbl">Public Infrastructure</div></div>
  </div>

  <h2>Policy Violations (${violations.length})</h2>
  ${violations.length === 0
    ? '<p class="empty">No policy violations detected.</p>'
    : `<table>
        <thead><tr><th>Policy</th><th>Severity</th><th>Resource</th><th>Detail</th></tr></thead>
        <tbody>${violationRows}</tbody>
       </table>`}

  <h2>Recent Changes (last 20)</h2>
  ${audit.length === 0
    ? '<p class="empty">No changes recorded.</p>'
    : `<table>
        <thead><tr><th>Title</th><th>Status</th><th>Risk</th><th>Submitted By</th><th>Date</th></tr></thead>
        <tbody>${changeRows}</tbody>
       </table>`}

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;
              font-size:10px;color:#94a3b8;display:flex;justify-content:space-between">
    <span>AppCloud · Infrastructure Intelligence Platform</span>
    <span>Report generated ${ts.slice(0,10)}</span>
  </div>
</body>
</html>`

    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Disposition', `inline; filename="appcloud-compliance-${ts.slice(0,10)}.html"`)
      .send(html)
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