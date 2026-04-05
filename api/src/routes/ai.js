// routes/ai.js

import { props, serialize } from '../utils/serialize.js'
import { createCloudProviderFromOptions } from '../utils/ai-providers.js'

export default async function aiRoutes(fastify) {
  const { query } = fastify.neo4j
  const ai = fastify.ai

  // ── Shared error handler ────────────────────────────────────────────────────
  // @fastify/sensible errors have .statusCode set — send them directly.
  // Other errors are 500s.
  const handleAIError = (err, reply) => {
    fastify.log.error(`[AI] ${err.message}`)
    if (err.statusCode) return reply.send(err)          // structured httpError
    return reply.internalServerError(err.message)
  }

  // ── GET /ai/status ─────────────────────────────────────────────────────────
  fastify.get('/status', async () => {
    const svc = fastify.ai
    if (!svc) {
      return {
        local: { available: false, provider: 'ollama', model: null, baseUrl: null },
        cloud: { available: false, provider: null, model: null },
      }
    }
    await svc.checkLocal().catch(() => {})
    return {
      local: {
        available: svc.localAvailable,
        provider:  'ollama',
        model:     svc.local?.model,
        baseUrl:   svc.local?.baseUrl,
        inCluster: Boolean(process.env.KUBERNETES_SERVICE_HOST),
      },
      cloud: {
        available: svc.cloudAvailable,
        provider:  svc.cloud?.name || null,
        model:     svc.cloud?.model || null,
      },
    }
  })

  // ── POST /ai/suggest/explain ────────────────────────────────────────────────
  fastify.post('/suggest/explain', async (req, reply) => {
    const { infra, suggestion } = req.body || {}
    if (!infra || !suggestion) return reply.badRequest('infra and suggestion are required')
    if (!infra.name)           return reply.badRequest('infra.name is required')

    try {
      const explanation = await ai.explainMapping(infra, suggestion)
      return { explanation, provider: 'ollama', model: ai.local?.model }
    } catch (err) {
      return handleAIError(err, reply)
    }
  })

  // ── POST /ai/suggest/score ──────────────────────────────────────────────────
  fastify.post('/suggest/score', async (req, reply) => {
    const { infraId } = req.body || {}
    if (!infraId) return reply.badRequest('infraId is required')

    const infraRecords = await query(`MATCH (i:Infra {id: $id}) RETURN i`, { id: infraId })
    if (!infraRecords.length) return reply.notFound(`Infra node not found: ${infraId}`)

    const infra = props(infraRecords[0].get('i'))
    const parseProp = v => { try { return typeof v === 'string' ? JSON.parse(v) : v || {} } catch { return {} } }
    infra.tags = parseProp(infra.tags)

    const appRecords = await query(`MATCH (a:Application) RETURN a ORDER BY a.tier, a.name LIMIT 20`)
    const apps = appRecords.map(r => props(r.get('a')))

    if (!apps.length) return { scores: [], message: 'No applications exist yet — create applications first' }

    try {
      const scores = await ai.scoreMapping(infra, apps)
      return { infraId, infraName: infra.name, scores, provider: 'ollama', model: ai.local?.model }
    } catch (err) {
      return handleAIError(err, reply)
    }
  })

  // ── GET /ai/changes/:id/risk-explain ───────────────────────────────────────
  fastify.get('/changes/:id/risk-explain', async (req, reply) => {
    const { id } = req.params

    const changeRecords = await query(`MATCH (ch:Change {id: $id}) RETURN ch`, { id })
    if (!changeRecords.length) return reply.notFound('Change not found')
    const change = props(changeRecords[0].get('ch'))

    const brRecords = await query(`
      MATCH (ch:Change {id: $id})-[:MODIFIES]->(n)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(:Component)-[:DEPLOYED_ON]->(n)
      WITH ch, n, collect(DISTINCT a) AS indirectApps
      OPTIONAL MATCH (ch)-[:AFFECTS]->(directApp:Application)
      RETURN collect(DISTINCT {label: labels(n)[0], name: n.name}) AS directlyModified,
             collect(DISTINCT directApp.name)  AS directlyAffected,
             collect(DISTINCT [app IN indirectApps | app.name]) AS indirectlyAffected
    `, { id })

    const br = brRecords[0] ? {
      directlyModified:   brRecords[0].get('directlyModified') || [],
      directlyAffected:   brRecords[0].get('directlyAffected') || [],
      indirectlyAffected: [...new Set((brRecords[0].get('indirectlyAffected') || []).flat())],
    } : {}

    try {
      const explanation = await ai.explainRisk(change, br)
      return { changeId: id, explanation, riskScore: change.riskScore, provider: 'ollama', model: ai.local?.model }
    } catch (err) {
      return handleAIError(err, reply)
    }
  })

  // ── GET /ai/infra/:id/impact ────────────────────────────────────────────────
  fastify.get('/infra/:id/impact', async (req, reply) => {
    const { id } = req.params

    const records = await query(`
      MATCH (i:Infra {id: $id})
      OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN i,
             collect(DISTINCT {name: c.name, type: c.type}) AS components,
             collect(DISTINCT {name: a.name, tier: a.tier, environment: a.environment, owner: a.owner}) AS applications
    `, { id })

    if (!records.length) return reply.notFound('Infra node not found')
    const r          = records[0]
    const infraName  = props(r.get('i'))?.name || id
    const components = serialize(r.get('components')).filter(c => c.name)
    const apps       = serialize(r.get('applications')).filter(a => a.name)

    try {
      const narrative = await ai.explainImpact(infraName, components, apps)
      return { infraId: id, infraName, components, applications: apps, narrative, provider: 'ollama', model: ai.local?.model }
    } catch (err) {
      return handleAIError(err, reply)
    }
  })

  // ── GET /ai/architecture/plan ───────────────────────────────────────────────
  fastify.get('/architecture/plan', async (req, reply) => {
    // Check cloud available before running expensive graph queries
    if (!ai.cloudAvailable) {
      return reply.send(fastify.httpErrors.serviceUnavailable(
        'Cloud AI is not configured. Set AI_CLOUD_PROVIDER and the corresponding API key.'
      ))
    }

    const [appRecs, infraRecs, connRecs] = await Promise.all([
      query(`
        MATCH (a:Application)
        OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
        RETURN a.name AS name, a.tier AS tier, a.owner AS owner,
               a.environment AS env, count(c) AS compCount
        ORDER BY a.tier, a.name
      `),
      query(`
        MATCH (i:Infra) WHERE i.source = 'discovery'
        RETURN i.provider AS provider, i.resource_type AS type,
               count(i) AS cnt,
               count(CASE WHEN (:Component)-[:DEPLOYED_ON]->(i) THEN 1 END) AS mapped
        ORDER BY provider, type
      `),
      query(`
        MATCH (a1:Application)-[:CONTAINS]->(c1:Component)-[:CONNECTS_TO]->(c2:Component)<-[:CONTAINS]-(a2:Application)
        WHERE a1.id <> a2.id
        RETURN a1.name AS from, a2.name AS to, count(*) AS connections
        ORDER BY connections DESC LIMIT 20
      `),
    ])

    const context = {
      applications: appRecs.map(r => ({
        name: r.get('name'), tier: serialize(r.get('tier')),
        owner: r.get('owner'), environment: r.get('env'),
        components: serialize(r.get('compCount')),
      })),
      infraSummary: infraRecs.map(r => ({
        provider: r.get('provider'), type: r.get('type'),
        count: serialize(r.get('cnt')), mapped: serialize(r.get('mapped')),
      })),
      crossAppDependencies: connRecs.map(r => ({
        from: r.get('from'), to: r.get('to'), connections: serialize(r.get('connections')),
      })),
    }

    try {
      const plan = await ai.planArchitecture(context)
      return { plan, context, provider: ai.cloud?.name, model: ai.cloud?.model }
    } catch (err) {
      return handleAIError(err, reply)
    }
  })

  // ── POST /ai/drift/remediation-plan ────────────────────────────────────────
  fastify.post('/drift/remediation-plan', async (req, reply) => {
    if (!ai.cloudAvailable) {
      return reply.send(fastify.httpErrors.serviceUnavailable(
        'Cloud AI is not configured. Set AI_CLOUD_PROVIDER and the corresponding API key.'
      ))
    }

    let items = req.body?.items
    if (!items) {
      const records = await query(`
        MATCH (i:Infra)
        WHERE i.source = 'discovery'
          AND NOT (:Component)-[:DEPLOYED_ON]->(i)
        RETURN i.id AS id, i.name AS name, i.provider AS provider,
               i.resource_type AS resourceType, i.region AS region,
               i.tags AS tags
        ORDER BY i.provider, i.resource_type, i.name
        LIMIT 50
      `)
      items = records.map(r => ({
        id: r.get('id'), name: r.get('name'), provider: r.get('provider'),
        resourceType: r.get('resourceType'), region: r.get('region'),
        tags: (() => { try { return JSON.parse(r.get('tags') || '{}') } catch { return {} } })(),
      }))
    }

    if (!items.length) return { plan: null, message: 'No unmapped drift items found', items: [] }

    try {
      const result = await ai.planDriftRemediation(items)
      return { ...result, itemCount: items.length }
    } catch (err) {
      return handleAIError(err, reply)
    }
  })

  // ── GET /ai/compliance/narrative ────────────────────────────────────────────
  fastify.get('/compliance/narrative', async (req, reply) => {
    if (!ai.cloudAvailable) {
      return reply.send(fastify.httpErrors.serviceUnavailable(
        'Cloud AI is not configured. Set AI_CLOUD_PROVIDER and the corresponding API key.'
      ))
    }

    const [summaryRes, violationsRes] = await Promise.all([
      fastify.inject({ method: 'GET', url: '/governance/summary' }),
      fastify.inject({ method: 'GET', url: '/governance/policy-violations' }),
    ])

    const report = {
      summary:          JSON.parse(summaryRes.body),
      policyViolations: JSON.parse(violationsRes.body),
    }
    const v = report.policyViolations || []
    const c = report.summary?.changes || {}
    let score = 100
    score -= v.filter(x => x.severity === 'CRITICAL').length * 15
    score -= v.filter(x => x.severity === 'HIGH').length     * 8
    score -= v.filter(x => x.severity === 'MEDIUM').length   * 3
    if ((c.approvalRate || 0) < 80)        score -= 10
    if ((c.highRiskUnapproved || 0) > 0)   score -= 5 * c.highRiskUnapproved
    if ((report.summary?.applications?.unowned || 0) > 0) score -= 5
    report.complianceScore = Math.max(0, Math.min(100, score))

    try {
      const result = await ai.generateComplianceNarrative(report)
      return { ...result, complianceScore: report.complianceScore }
    } catch (err) {
      return handleAIError(err, reply)
    }
  })

  // ── GET /ai/dependencies/analysis ──────────────────────────────────────────
  fastify.get('/dependencies/analysis', async (req, reply) => {
    if (!ai.cloudAvailable) {
      return reply.send(fastify.httpErrors.serviceUnavailable(
        'Cloud AI is not configured. Set AI_CLOUD_PROVIDER and the corresponding API key.'
      ))
    }

    const topoRes  = await fastify.inject({ method: 'GET', url: '/graph/topology' })
    const topology = JSON.parse(topoRes.body)

    try {
      const result = await ai.analyzeDependencies(topology)
      return result
    } catch (err) {
      return handleAIError(err, reply)
    }
  })

  // ── POST /ai/chat ───────────────────────────────────────────────────────────
  fastify.post('/chat', async (req, reply) => {
    const svc = fastify.ai
    if (!svc) return reply.internalServerError('AI service unavailable')

    const { messages, useLocal = false, cloudOverride } = req.body || {}
    if (!messages?.length) return reply.badRequest('messages array is required')

    // Prefer cloud unless useLocal=true; fall back to local if cloud not configured.
    // Optional cloudOverride: credentials from Integrations UI (browser); otherwise server env.
    let provider
    if (useLocal) {
      if (!svc.localAvailable) await svc.checkLocal()
      if (!svc.localAvailable) {
        return reply.send(fastify.httpErrors.serviceUnavailable(
          `Ollama not available at ${svc.local?.baseUrl}`
        ))
      }
      provider = svc.local
    } else {
      let fromUi = null
      const ov = cloudOverride
      if (ov && typeof ov === 'object' && ov.provider && ov.provider !== 'auto' && ov.apiKey) {
        try {
          fromUi = createCloudProviderFromOptions(fastify.log, {
            provider: ov.provider,
            apiKey: ov.apiKey,
            model: ov.model,
            azureEndpoint: ov.azureEndpoint,
            azureDeployment: ov.azureDeployment,
          })
        } catch (err) {
          return reply.badRequest(err.message || 'Invalid cloud credentials')
        }
        if (!fromUi) return reply.badRequest('Invalid cloud provider')
      }

      if (fromUi) {
        provider = fromUi
      } else {
        provider = svc.cloud || svc.local
        if (!provider) {
          return reply.send(fastify.httpErrors.serviceUnavailable('No AI provider available'))
        }
        if (provider === svc.local && !svc.localAvailable) {
          await svc.checkLocal()
          if (!svc.localAvailable) {
            return reply.send(fastify.httpErrors.serviceUnavailable('No AI provider available'))
          }
        }
      }
    }

    const withSystem = messages[0]?.role === 'system'
      ? messages
      : [{ role: 'system', content: 'You are an infrastructure intelligence assistant for AppCloud. Be concise and technical.' }, ...messages]

    try {
      const result = await provider.chat(withSystem, { maxTokens: 1024 })
      // Normalise to an OpenAI-shaped payload so the UI can read choices[0].message.content
      if (result && typeof result.text === 'string') {
        return {
          choices: [{ message: { content: result.text }, finish_reason: 'stop' }],
          output: result.text,
          model: result.model,
          provider: result.provider,
          tokens: result.tokens,
        }
      }
      return result
    } catch (err) {
      return handleAIError(err, reply)
    }
  })
}