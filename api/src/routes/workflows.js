// routes/workflows.js
// Three workflow engines:
//   1. Change Lifecycle  — draft → policy_check → review → approval → scheduled → deployed → verified
//   2. App Onboarding    — checklist enforcement when a new Application is created
//   3. Drift Detection   — fires after Terraform import, diffs graph vs state file
import { props, serialize } from '../utils/serialize.js'

// ─── Shared step definitions ──────────────────────────────────────────────────

const CHANGE_LIFECYCLE_STEPS = [
  { order:1, key:'policy_check',   label:'Policy Check',     type:'auto',     blocking:true,
    description:'Automated governance rules verified against the change' },
  { order:2, key:'review',         label:'Peer Review',      type:'manual',   blocking:true,
    description:'At least one peer must review the change before it proceeds' },
  { order:3, key:'approval',       label:'Approval Gate',    type:'approval', blocking:true,
    description:'Change owner or senior approver must formally approve' },
  { order:4, key:'notify',         label:'Notify Teams',     type:'integration', blocking:false,
    integrationRequired:'slack',
    description:'Notify affected application owners via Slack or Teams' },
  { order:5, key:'scheduled',      label:'Schedule Window',  type:'manual',   blocking:true,
    description:'Change is assigned a deployment window' },
  { order:6, key:'deployed',       label:'Deployment',       type:'manual',   blocking:true,
    description:'Change is deployed and verified in target environment' },
  { order:7, key:'verified',       label:'Post-Deploy Check', type:'auto',    blocking:false,
    description:'Automated check that affected services are healthy post-deployment' },
]

const ONBOARDING_STEPS = [
  { order:1, key:'owner',          label:'Assign Owner',        type:'manual', blocking:true,
    description:'Application must have a designated owner/team' },
  { order:2, key:'classification', label:'Data Classification', type:'manual', blocking:true,
    description:'Availability SLA and confidentiality level must be set' },
  { order:3, key:'component',      label:'Add Component',       type:'manual', blocking:true,
    description:'At least one component must be registered' },
  { order:4, key:'deployment',     label:'Deployment Record',   type:'manual', blocking:false,
    description:'At least one component should be linked to infrastructure' },
  { order:5, key:'domain',         label:'Set Domain',          type:'manual', blocking:false,
    description:'Assign the application to a business domain' },
  { order:6, key:'notify',         label:'Announce to Team',    type:'integration', blocking:false,
    integrationRequired:'slack',
    description:'Notify the broader team that a new application has been registered' },
]

const DRIFT_STEPS = [
  { order:1, key:'parse',          label:'Parse State',      type:'auto',   blocking:true,
    description:'Terraform state file parsed and resources extracted' },
  { order:2, key:'diff',           label:'Graph Diff',       type:'auto',   blocking:true,
    description:'Imported resources compared against current graph state' },
  { order:3, key:'review',         label:'Review Drift',     type:'manual', blocking:true,
    description:'Infrastructure owner reviews the detected drift items' },
  { order:4, key:'changes',        label:'Create Changes',   type:'auto',   blocking:false,
    description:'Draft changes auto-created for significant drift items' },
  { order:5, key:'notify',         label:'Notify Owners',    type:'integration', blocking:false,
    integrationRequired:'slack',
    description:'Application owners notified of drift affecting their services' },
]

// ─── Auto-run policy check for a change ──────────────────────────────────────
async function runPolicyCheck(changeId, query) {
  const records = await query(`
    MATCH (ch:Change {id: $id})
    OPTIONAL MATCH (ch)-[:AFFECTS]->(a:Application)
    OPTIONAL MATCH (submitter:User)-[:SUBMITTED]->(ch)
    OPTIONAL MATCH (ch)<-[:APPROVED]-(submitter)
    RETURN ch.riskScore AS riskScore,
           collect(DISTINCT a.tier) AS tiers,
           count(DISTINCT CASE WHEN submitter IS NOT NULL THEN submitter END) AS selfApproved
  `, { id: changeId })
  if (!records.length) return { passed: false, issues: ['Change not found'] }
  const r     = records[0]
  const risk  = serialize(r.get('riskScore')) || 0
  const tiers = serialize(r.get('tiers')) || []
  const issues = []
  if (risk >= 7 && tiers.includes(1)) issues.push('High-risk change affecting Tier-1 application requires extra approval')
  if (risk >= 9)                       issues.push('Extreme risk score — CISO sign-off required')
  return { passed: issues.length === 0, issues, riskScore: risk, affectedTiers: tiers }
}

// ─── Check onboarding completion for an application ──────────────────────────
async function checkOnboarding(appId, query) {
  const records = await query(`
    MATCH (a:Application {id: $id})
    OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
    OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
    RETURN a,
           count(DISTINCT c) AS compCount,
           count(DISTINCT i) AS infraCount
  `, { id: appId })
  if (!records.length) return null
  const r   = records[0]
  const app = props(r.get('a'))
  const compCount  = serialize(r.get('compCount'))
  const infraCount = serialize(r.get('infraCount'))
  const stepStatus = {
    owner:          { done: !!(app.owner),             note: app.owner || 'No owner set' },
    classification: { done: !!(app.availability && app.confidentiality),
                      note: `${app.availability || '?'} / ${app.confidentiality || '?'}` },
    component:      { done: compCount > 0,             note: `${compCount} component(s)` },
    deployment:     { done: infraCount > 0,            note: `${infraCount} infra link(s)` },
    domain:         { done: !!(app.domain),            note: app.domain || 'Not set' },
    notify:         { done: false,                     note: 'Pending integration' },
  }
  const required = ['owner','classification','component']
  const complete = required.every(k => stepStatus[k].done)
  const pct = Math.round(Object.values(stepStatus).filter(s=>s.done).length / 6 * 100)
  return { app, stepStatus, complete, completionPct: pct, compCount, infraCount }
}

// ─── Route definitions ────────────────────────────────────────────────────────
export default async function workflowRoutes(fastify) {
  const { query, write } = fastify.neo4j

  // ── WORKFLOW DEFINITIONS ──────────────────────────────────────────────────

  // GET /workflows/definitions — static step definitions for all workflow types
  fastify.get('/definitions', async () => ({
    change_lifecycle: { id:'change_lifecycle', name:'Change Lifecycle',
      description:'Gate and track changes from draft to verified deployment',
      trigger:'change_created', steps: CHANGE_LIFECYCLE_STEPS,
      integrations: ['slack','teams','servicenow'] },
    app_onboarding: { id:'app_onboarding', name:'Application Onboarding',
      description:'Checklist enforcement for new application registration',
      trigger:'application_created', steps: ONBOARDING_STEPS,
      integrations: ['slack','teams'] },
    drift_detection: { id:'drift_detection', name:'Drift Detection',
      description:'Auto-detect infrastructure drift after Terraform import',
      trigger:'terraform_import', steps: DRIFT_STEPS,
      integrations: ['slack','teams'] },
  }))

  // ── CHANGE LIFECYCLE WORKFLOW ─────────────────────────────────────────────

  // GET /workflows/changes — all change workflows with current step
  fastify.get('/changes', async (req, reply) => {
    const records = await query(`
      MATCH (ch:Change)
      OPTIONAL MATCH (u:User)-[:SUBMITTED]->(ch)
      OPTIONAL MATCH (ch)-[:AFFECTS]->(a:Application)
      RETURN ch, u.name AS submittedBy,
             collect(DISTINCT {name:a.name, tier:a.tier}) AS apps
      ORDER BY ch.createdAt DESC
      LIMIT 50
    `)
    return records.map(r => {
      const ch   = props(r.get('ch'))
      const apps = serialize(r.get('apps'))
      const step = deriveChangeStep(ch)
      return { ...ch, submittedBy: r.get('submittedBy'), affectedApps: apps, ...step }
    })
  })

  // GET /workflows/changes/:id — single change workflow detail
  fastify.get('/changes/:id', async (req, reply) => {
    const records = await query(`
      MATCH (ch:Change {id: $id})
      OPTIONAL MATCH (submitter:User)-[:SUBMITTED]->(ch)
      OPTIONAL MATCH (approver:User)-[:APPROVED]->(ch)
      OPTIONAL MATCH (ch)-[:AFFECTS]->(a:Application)
      OPTIONAL MATCH (ch)-[:MODIFIES]->(n)
      RETURN ch, submitter.name AS submittedBy, approver.name AS approvedBy,
             collect(DISTINCT {name:a.name, tier:a.tier, owner:a.owner}) AS apps,
             collect(DISTINCT {label:labels(n)[0], name:n.name}) AS modifies
    `, { id: req.params.id })
    if (!records.length) return reply.notFound('Change not found')
    const r    = records[0]
    const ch   = props(r.get('ch'))
    const step = deriveChangeStep(ch)
    const policyResult = await runPolicyCheck(req.params.id, query)
    return {
      ...ch,
      submittedBy:   r.get('submittedBy'),
      approvedBy:    r.get('approvedBy'),
      affectedApps:  serialize(r.get('apps')),
      modifies:      r.get('modifies'),
      workflowSteps: CHANGE_LIFECYCLE_STEPS.map(s => ({
        ...s, status: getStepStatus(s.key, ch, policyResult)
      })),
      policyCheck:   policyResult,
      ...step,
    }
  })

  // POST /workflows/changes/:id/advance — move a change to next step
  fastify.post('/changes/:id/advance', async (req, reply) => {
    const { action, userId, note, scheduledFor } = req.body
    const records = await query(`
      MATCH (ch:Change {id: $id})
      OPTIONAL MATCH (u:User)-[:SUBMITTED]->(ch)
      RETURN ch, u.id AS submitterId
    `, { id: req.params.id })
    if (!records.length) return reply.notFound('Change not found')
    const ch      = props(records[0].get('ch'))
    const current = deriveChangeStep(ch)

    // Run policy check on first advance attempt
    if (current.currentStep === 'policy_check' || action === 'pass_policy') {
      const result = await runPolicyCheck(req.params.id, query)
      if (!result.passed) {
        await write(`
          MATCH (ch:Change {id: $id})
          SET ch.workflowStatus = 'blocked', ch.policyIssues = $issues
        `, { id: req.params.id, issues: result.issues.join('; ') })
        return { advanced: false, blocked: true, reason: 'Policy check failed', issues: result.issues }
      }
    }

    // Apply the transition
    const now = new Date().toISOString()
    const nextStatus = getNextStatus(ch, action)
    await write(`
      MATCH (ch:Change {id: $id})
      SET ch.status = $status,
          ch.workflowStatus = $wfStatus,
          ch.lastActionAt = datetime(),
          ch.lastActionBy = $userId,
          ch.lastNote = $note
      ${scheduledFor ? ', ch.scheduledFor = $scheduledFor' : ''}
    `, { id: req.params.id, status: nextStatus.changeStatus,
         wfStatus: nextStatus.wfStatus, userId: userId || 'system',
         note: note || '', scheduledFor: scheduledFor || null })

    return { advanced: true, previousStep: current.currentStep,
             newStatus: nextStatus.changeStatus, newWorkflowStatus: nextStatus.wfStatus }
  })

  // ── ONBOARDING WORKFLOWS ──────────────────────────────────────────────────

  // GET /workflows/onboarding — all apps with onboarding status
  fastify.get('/onboarding', async (req, reply) => {
    const records = await query(`
      MATCH (a:Application)
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
      RETURN a, count(DISTINCT c) AS compCount, count(DISTINCT i) AS infraCount
      ORDER BY a.tier ASC, a.name ASC
    `)
    return records.map(r => {
      const app        = props(r.get('a'))
      const compCount  = serialize(r.get('compCount'))
      const infraCount = serialize(r.get('infraCount'))
      const stepStatus = {
        owner:          { done: !!(app.owner),                             note: app.owner || 'Not set' },
        classification: { done: !!(app.availability && app.confidentiality), note: `${app.availability||'?'} / ${app.confidentiality||'?'}` },
        component:      { done: compCount > 0,                             note: `${compCount} component(s)` },
        deployment:     { done: infraCount > 0,                            note: `${infraCount} infra link(s)` },
        domain:         { done: !!(app.domain),                            note: app.domain || 'Not set' },
        notify:         { done: !!(app.onboardingNotified),                note: app.onboardingNotified ? 'Sent' : 'Pending' },
      }
      const pct      = Math.round(Object.values(stepStatus).filter(s=>s.done).length / 6 * 100)
      const complete = ['owner','classification','component'].every(k => stepStatus[k].done)
      return { ...app, compCount, infraCount, stepStatus, completionPct: pct, complete }
    })
  })

  // GET /workflows/onboarding/:id — single app onboarding detail
  fastify.get('/onboarding/:id', async (req, reply) => {
    const result = await checkOnboarding(req.params.id, query)
    if (!result) return reply.notFound('Application not found')
    return {
      ...result,
      steps: ONBOARDING_STEPS.map(s => ({
        ...s,
        status: result.stepStatus[s.key]?.done ? 'complete'
               : s.blocking ? 'required' : 'optional',
        note:   result.stepStatus[s.key]?.note,
      }))
    }
  })

  // POST /workflows/onboarding/:id/complete-step — mark a step done
  fastify.post('/onboarding/:id/complete-step', async (req, reply) => {
    const { step } = req.body
    if (step === 'notify') {
      await write(`
        MATCH (a:Application {id: $id})
        SET a.onboardingNotified = true, a.onboardingNotifiedAt = datetime()
      `, { id: req.params.id })
    }
    const result = await checkOnboarding(req.params.id, query)
    if (!result) return reply.notFound('Application not found')
    return { step, refreshed: result }
  })

  // ── DRIFT DETECTION WORKFLOW ──────────────────────────────────────────────

  // GET /workflows/drift — drift detection runs (from terraform_imports table)
  fastify.get('/drift', async (req, reply) => {
    // Recent imports from PostgreSQL — gracefully degrade if table missing or PG unavailable
    let imports = []
    if (fastify.pg?.pool) {
      try {
        imports = await fastify.pg.query(
          `SELECT id, filename, status, resources_imported, resources_created,
                  resources_updated, terraform_version, created_at, finished_at,
                  raw_summary
           FROM terraform_imports ORDER BY created_at DESC LIMIT 20`
        )
      } catch (err) {
        fastify.log.warn(`[drift] terraform_imports query failed: ${err.message}`)
        imports = []
      }
    }

    // Drift counts from Neo4j — unmapped = terraform-sourced infra with no component link
    let graphTfCount = 0, unmappedCount = 0
    try {
      const drifted = await query(`
        MATCH (i:Infra)
        WHERE i.source = 'terraform' OR i.source = 'discovery'
        RETURN count(i) AS tfCount,
               count(CASE WHEN NOT exists((i)<-[:DEPLOYED_ON]-(:Component)) THEN 1 END) AS unmapped
      `)
      graphTfCount  = serialize(drifted[0]?.get('tfCount'))  || 0
      unmappedCount = serialize(drifted[0]?.get('unmapped')) || 0
    } catch (err) {
      fastify.log.warn(`[drift] Neo4j drift query failed: ${err.message}`)
    }

    return {
      graphTerraformResources: graphTfCount,
      staleResources: unmappedCount,
      recentImports: imports.map(imp => ({
        ...imp,
        rawSummary: imp.raw_summary,
        driftSteps: DRIFT_STEPS.map(s => ({
          ...s,
          status: getDriftStepStatus(s.key, imp)
        }))
      }))
    }
  })

  // GET /workflows/drift/analysis — live diff: terraform resources vs graph
  fastify.get('/drift/analysis', async (req, reply) => {
    const records = await query(`
      // Resources that came from terraform
      MATCH (i:Infra) WHERE i.source = 'terraform'
      OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN i.terraform_id AS tfId, i.id AS nodeId, i.name AS name,
             i.provider AS provider, i.resource_type AS resourceType,
             i.region AS region, i.imported_at AS importedAt,
             i.updated_at AS updatedAt,
             collect(DISTINCT c.name) AS components,
             collect(DISTINCT a.name) AS applications
      ORDER BY i.provider, i.name
    `)

    const resources = records.map(r => ({
      tfId:          r.get('tfId'),
      nodeId:        r.get('nodeId'),
      name:          r.get('name'),
      provider:      r.get('provider'),
      resourceType:  r.get('resourceType'),
      region:        r.get('region'),
      importedAt:    r.get('importedAt')?.toString(),
      updatedAt:     r.get('updatedAt')?.toString(),
      components:    r.get('components').filter(Boolean),
      applications:  r.get('applications').filter(Boolean),
      status:        r.get('components').filter(Boolean).length > 0 ? 'mapped' : 'unmapped',
    }))

    const mapped   = resources.filter(r => r.status === 'mapped')
    const unmapped = resources.filter(r => r.status === 'unmapped')

    // Group unmapped by provider for easy review
    const unmappedByProvider = unmapped.reduce((acc, r) => {
      if (!acc[r.provider]) acc[r.provider] = []
      acc[r.provider].push(r)
      return acc
    }, {})

    return { total: resources.length, mapped: mapped.length,
             unmapped: unmapped.length, unmappedByProvider, resources }
  })

  // POST /workflows/drift/create-changes — auto-create draft changes for unmapped resources
  fastify.post('/drift/create-changes', async (req, reply) => {
    const { infraIds, submittedBy } = req.body
    if (!infraIds?.length) return reply.badRequest('infraIds required')

    const userRecords = await query(`MATCH (u:User {id:$id}) RETURN u`, { id: submittedBy })
    if (!userRecords.length) return reply.badRequest('submittedBy user not found')

    const created = []
    for (const infraId of infraIds) {
      const infraRecs = await query(`MATCH (i:Infra {id:$id}) RETURN i`, { id: infraId })
      if (!infraRecs.length) continue
      const infra = props(infraRecs[0].get('i'))
      const changeRecs = await write(`
        MATCH (u:User {id: $userId})
        CREATE (ch:Change {
          id: randomUUID(), status: "draft",
          createdAt: datetime(),
          riskScore: 3.0,
          description: $description,
          workflowStatus: "drift_detected",
          source: "drift_detection"
        })
        CREATE (u)-[:SUBMITTED]->(ch)
        CREATE (ch)-[:MODIFIES]->(i)
        WITH ch
        MATCH (i:Infra {id: $infraId})
        RETURN ch
      `, {
        userId: submittedBy,
        infraId,
        description: `[Drift] Unlinked infrastructure resource: ${infra.name} (${infra.provider}/${infra.resourceType})`,
      })
      if (changeRecs.length) created.push(props(changeRecs[0].get('ch')))
    }

    return { created: created.length, changes: created }
  })

  // GET /workflows/summary — counts across all three workflow types
  fastify.get('/summary', async (req, reply) => {
    const [changeRecs, appRecs, infraRecs] = await Promise.all([
      query(`
        MATCH (ch:Change)
        RETURN count(ch) AS total,
               count(CASE WHEN ch.status='draft'    THEN 1 END) AS draft,
               count(CASE WHEN ch.status='approved' THEN 1 END) AS approved,
               count(CASE WHEN ch.workflowStatus='blocked' THEN 1 END) AS blocked
      `),
      query(`
        MATCH (a:Application)
        OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
        OPTIONAL MATCH (c)-[:DEPLOYED_ON]->(i:Infra)
        WITH a, count(DISTINCT c) AS compCount, count(DISTINCT i) AS infraCount
        RETURN count(a) AS total,
               count(CASE WHEN a.owner IS NOT NULL AND a.availability IS NOT NULL
                               AND compCount > 0 THEN 1 END) AS complete
      `),
      query(`
        OPTIONAL MATCH (i:Infra)
        WHERE i.source IN ['terraform','discovery']
        OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
        WITH i, count(c) AS linked
        RETURN count(i) AS total,
               count(CASE WHEN linked = 0 AND i IS NOT NULL THEN 1 END) AS unmapped
      `),
    ])
    const g = (rec, key) => rec?.[0] ? (serialize(rec[0].get(key)) || 0) : 0
    const onboardTotal    = g(appRecs,   'total')
    const onboardComplete = g(appRecs,   'complete')
    return {
      changeLcm: {
        total:    g(changeRecs, 'total'),
        draft:    g(changeRecs, 'draft'),
        approved: g(changeRecs, 'approved'),
        blocked:  g(changeRecs, 'blocked'),
      },
      onboarding: {
        total:    onboardTotal,
        complete: onboardComplete,
        pending:  onboardTotal - onboardComplete,
      },
      drift: {
        total:    g(infraRecs, 'total'),
        unmapped: g(infraRecs, 'unmapped'),
      },
    }
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveChangeStep(ch) {
  const s = ch.status, ws = ch.workflowStatus
  if (ws === 'blocked') return { currentStep:'policy_check', stepIndex:0, blocked:true }
  if (s === 'draft' && !ws) return { currentStep:'policy_check', stepIndex:0, blocked:false }
  if (s === 'draft' && ws === 'policy_passed') return { currentStep:'review', stepIndex:1 }
  if (s === 'draft' && ws === 'reviewed')      return { currentStep:'approval', stepIndex:2 }
  if (s === 'approved' && !ch.scheduledFor)    return { currentStep:'scheduled', stepIndex:4 }
  if (s === 'approved' && ch.scheduledFor)     return { currentStep:'deployed', stepIndex:5 }
  if (s === 'deployed')                        return { currentStep:'verified', stepIndex:6 }
  if (s === 'rejected')                        return { currentStep:'rejected', stepIndex:-1 }
  return { currentStep:'policy_check', stepIndex:0 }
}

function getStepStatus(key, ch, policyResult) {
  const s = ch.status, ws = ch.workflowStatus
  const stepMap = {
    policy_check: ws==='blocked' ? 'failed'
                : (ws && ws !== 'policy_check') ? 'complete'
                : s==='draft' && !ws ? 'active' : 'pending',
    review:       ws==='reviewed'||ws==='approved'||s==='approved' ? 'complete'
                : ws==='policy_passed' ? 'active' : 'pending',
    approval:     s==='approved'||s==='deployed' ? 'complete'
                : ws==='reviewed' ? 'active'
                : s==='rejected' ? 'failed' : 'pending',
    notify:       ws==='notified'||s==='approved' ? 'complete' : 'pending',
    scheduled:    ch.scheduledFor ? 'complete'
                : s==='approved' ? 'active' : 'pending',
    deployed:     s==='deployed' ? 'complete'
                : ch.scheduledFor ? 'active' : 'pending',
    verified:     s==='deployed' ? 'active' : 'pending',
  }
  return stepMap[key] || 'pending'
}

function getNextStatus(ch, action) {
  const transitions = {
    pass_policy:  { changeStatus:'draft',    wfStatus:'policy_passed' },
    submit_review:{ changeStatus:'draft',    wfStatus:'reviewed' },
    approve:      { changeStatus:'approved', wfStatus:'approved' },
    reject:       { changeStatus:'rejected', wfStatus:'rejected' },
    schedule:     { changeStatus:'approved', wfStatus:'scheduled' },
    deploy:       { changeStatus:'deployed', wfStatus:'deployed' },
    verify:       { changeStatus:'deployed', wfStatus:'verified' },
  }
  return transitions[action] || { changeStatus: ch.status, wfStatus: ch.workflowStatus }
}

function getDriftStepStatus(key, imp) {
  if (!imp) return 'pending'
  const done = imp.status === 'done' || imp.status === 'success'
  const map = {
    parse:   done ? 'complete' : imp.status==='parsing' ? 'active' : 'pending',
    diff:    done ? 'complete' : 'pending',
    review:  'pending',
    changes: imp.resources_created > 0 ? 'complete' : 'pending',
    notify:  'pending',
  }
  return map[key] || 'pending'
}