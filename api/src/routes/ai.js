// routes/ai.js

import { props, serialize } from '../utils/serialize.js'
import { createCloudProviderFromOptions } from '../utils/ai-providers.js'
import { StandardErrorResponses } from '../schemas/openapi.js'

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
  fastify.get('/status', {
    schema: {
      summary:     'AI provider availability snapshot',
      description: 'Returns whether the local provider (Ollama) and the cloud provider (Anthropic / OpenAI / Gemini / Azure) are reachable, plus model + baseUrl. Used by the UI to gate AI-feature affordances.',
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    const svc = fastify.ai
    if (!svc) {
      return {
        local: { available: false, provider: 'ollama', model: null, baseUrl: null },
        cloud: { available: false, provider: null, model: null },
      }
    }
    await svc.checkLocal().catch(() => {})
    if (svc.refreshCloudFromDb) await svc.refreshCloudFromDb().catch(() => {})
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
      cloudDb: {
        configured: svc.cloudDbConfigured || false,
      },
    }
  })

  // ── POST /ai/suggest/explain ────────────────────────────────────────────────
  fastify.post('/suggest/explain', {
    schema: {
      summary:     'Plain-English explanation for a mapping suggestion',
      description: 'Given an Infra + a candidate Component mapping (output of `/discovery/suggest`), the local LLM produces a human-readable rationale. Useful for tooltips on suggestion cards.',
      body: { type: 'object', required: ['infra', 'suggestion'], additionalProperties: true, properties: {
        infra:      { type: 'object', additionalProperties: true },
        suggestion: { type: 'object', additionalProperties: true },
      } },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
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
  fastify.post('/suggest/score', {
    schema: {
      summary:     'AI-augmented Application/Component scoring for one Infra',
      description: 'Given an Infra id, returns LLM-scored candidate Applications. Complements the rule-based scores from the suggest engine; clients combine both.',
      body:        { type: 'object', required: ['infraId'], additionalProperties: true, properties: { infraId: { type: 'string', format: 'uuid' } } },
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
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

  // ── GET /ai/infra/:id/impact ────────────────────────────────────────────────
  fastify.get('/infra/:id/impact', {
    schema: {
      summary:     'Plain-English blast-radius narrative for one Infra',
      description: 'Walks the impact graph (same shape as `/graph/impact`), then asks the local LLM to summarise the change risk in one paragraph. Use this in the impact-review surface.',
      params:      { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    const { id } = req.params

    const records = await query(`
      MATCH (i:Infra {id: $id})
      OPTIONAL MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
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
  fastify.get('/architecture/plan', {
    schema: {
      summary:     'High-level architectural plan over the whole graph (cloud LLM)',
      description: 'Fetches a graph snapshot (apps, infra summary, cross-app dependencies) and asks the configured cloud LLM for an architectural review. Returns 503 when no cloud AI is configured.',
      response:    { 200: { type: 'object', additionalProperties: true }, 503: StandardErrorResponses[503] },
    },
  }, async (req, reply) => {
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
               count(CASE WHEN (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i) THEN 1 END) AS mapped
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
  fastify.post('/drift/remediation-plan', {
    schema: {
      summary:     'Remediation plan for unmapped/drifted Infra (cloud LLM)',
      description: 'Without a body, picks up to 50 unmapped discovered Infra nodes and asks the cloud LLM to propose mappings or tag changes. With a body, scores the supplied items.',
      body: { type: 'object', additionalProperties: true, properties: {
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      } },
      response: { 200: { type: 'object', additionalProperties: true }, 503: StandardErrorResponses[503] },
    },
  }, async (req, reply) => {
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
          AND NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
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

  // ── GET /ai/dependencies/analysis ──────────────────────────────────────────
  fastify.get('/dependencies/analysis', {
    schema: {
      summary:     'Cross-app dependency analysis (cloud LLM)',
      description: 'Pulls `/graph/topology` and asks the cloud LLM to flag risky dependency patterns (single points of failure, cycles, tier-skipping calls). Returns 503 when no cloud AI is configured.',
      response:    { 200: { type: 'object', additionalProperties: true }, 503: StandardErrorResponses[503] },
    },
  }, async (req, reply) => {
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
  //
  // Enriched chat: fetches a live context snapshot from Neo4j (applications,
  // infrastructure, unmapped resources, cross-app dependencies) and injects it
  // into the system prompt so the LLM can give informed, data-rich answers.
  //

  async function buildContextSnapshot() {
    try {
      const [appRecs, infraRecs, driftRecs, connRecs] = await Promise.all([
        // Applications with tier, owner, component count
        query(`
          MATCH (a:Application)
          OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
          RETURN a.id AS id, a.name AS name, a.tier AS tier, a.owner AS owner,
                 a.environment AS env, a.domain AS domain, count(c) AS components
          ORDER BY a.tier, a.name
        `).catch(() => []),

        // Infrastructure summary by provider and type
        query(`
          MATCH (i:Infra)
          OPTIONAL MATCH (comp:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
          RETURN i.provider AS provider, i.resource_type AS type,
                 count(DISTINCT i) AS count,
                 count(DISTINCT comp) AS mapped
          ORDER BY provider, count DESC
        `).catch(() => []),

        // Unmapped resources
        query(`
          MATCH (i:Infra)
          WHERE NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)
          RETURN i.provider AS provider, i.resource_type AS type, i.name AS name,
                 i.region AS region
          LIMIT 20
        `).catch(() => []),

        // Cross-app connections
        query(`
          MATCH (a1:Application)-[:CONTAINS]->(c1:Component)-[:CONNECTS_TO]->(c2:Component)<-[:CONTAINS]-(a2:Application)
          WHERE a1.id <> a2.id
          RETURN a1.name AS from, a2.name AS to, count(*) AS connections
          ORDER BY connections DESC LIMIT 10
        `).catch(() => []),
      ])

      const apps = appRecs.map(r => ({
        name: r.get('name'), tier: r.get('tier'), owner: r.get('owner'),
        env: r.get('env'), domain: r.get('domain'),
        components: (r.get('components') ?? 0).toString(),
      }))

      const infra = infraRecs.map(r => ({
        provider: r.get('provider'), type: r.get('type'),
        count: (r.get('count') ?? 0).toString(),
        mapped: (r.get('mapped') ?? 0).toString(),
      }))

      const unmapped = driftRecs.map(r => ({
        provider: r.get('provider'), type: r.get('type'),
        name: r.get('name'), region: r.get('region'),
      }))

      const crossApp = connRecs.map(r => ({
        from: r.get('from'), to: r.get('to'),
        connections: (r.get('connections') ?? 0).toString(),
      }))

      return { apps, infra, unmapped, crossApp }
    } catch (err) {
      fastify.log.warn(`[AI Chat] Context snapshot failed: ${err.message}`)
      return null
    }
  }

  // Pre-analyze the data in code so the LLM just needs to rewrite it.
  // Small models (llama3 8B) can reliably rewrite a report but cannot reliably
  // extract insights from raw data — so we do the analysis here.
  // Output is markdown-formatted for direct rendering in the UI.
  function buildPreAnalysis(ctx) {
    if (!ctx) return 'No data available from the infrastructure database.'
    const sections = []

    // ── Applications ──────────────────────────────────────────────────────────
    if (ctx.apps.length) {
      const byTier = {}
      const noOwner = []
      for (const a of ctx.apps) {
        const t = a.tier || '?'
        byTier[t] = (byTier[t] || 0) + 1
        if (!a.owner || a.owner === 'unassigned') noOwner.push(a.name)
      }
      const tierLine = Object.entries(byTier).sort(([a],[b]) => a - b)
        .map(([t, c]) => `Tier ${t}: **${c}**`).join(' | ')

      let s = `## Applications — ${ctx.apps.length} registered\n\n`
      s += `${tierLine}\n\n`
      s += `| Application | Tier | Owner | Environment | Components |\n`
      s += `|-------------|------|-------|-------------|------------|\n`
      for (const a of ctx.apps) {
        s += `| ${a.name} | ${a.tier || '?'} | ${a.owner || '*unassigned*'} | ${a.env || '—'} | ${a.components} |\n`
      }
      if (noOwner.length) {
        s += `\n> **Action needed:** ${noOwner.length} app(s) have no owner — ${noOwner.join(', ')}. Assign owners for incident accountability.`
      }
      sections.push(s)
    } else {
      sections.push('## Applications\n\nNo applications registered yet.')
    }

    // ── Infrastructure ────────────────────────────────────────────────────────
    if (ctx.infra.length) {
      const totalRes = ctx.infra.reduce((s, i) => s + parseInt(i.count || 0), 0)
      const totalMap = ctx.infra.reduce((s, i) => s + parseInt(i.mapped || 0), 0)
      const providers = [...new Set(ctx.infra.map(i => i.provider).filter(Boolean))]
      const pct = totalRes ? Math.round(totalMap / totalRes * 100) : 100

      let s = `## Infrastructure — ${totalRes} resources across ${providers.join(', ')}\n\n`
      s += `**${totalMap}** mapped (${pct}%) · **${totalRes - totalMap}** unmapped\n\n`
      s += `| Provider / Type | Count | Mapped |\n`
      s += `|-----------------|-------|--------|\n`
      for (const i of ctx.infra) {
        if (parseInt(i.count) > 0) {
          s += `| ${i.provider}/${i.type} | ${i.count} | ${i.mapped} |\n`
        }
      }
      sections.push(s)
    }

    // ── Unmapped resources ────────────────────────────────────────────────────
    if (ctx.unmapped.length) {
      let s = `## Unmapped Resources — ${ctx.unmapped.length}\n\n`
      s += `| Provider / Type | Name | Region |\n`
      s += `|-----------------|------|--------|\n`
      for (const u of ctx.unmapped) {
        s += `| ${u.provider}/${u.type} | ${u.name} | ${u.region || '—'} |\n`
      }
      s += `\n> **Recommendation:** Run discovery mapping to link these resources to applications.`
      sections.push(s)
    } else {
      sections.push('## Unmapped Resources\n\nAll resources mapped.')
    }

    // ── Cross-app dependencies ────────────────────────────────────────────────
    if (ctx.crossApp.length) {
      let s = `## Cross-App Dependencies\n\n`
      s += `| From | To | Connections |\n`
      s += `|------|----|-------------|\n`
      for (const d of ctx.crossApp) {
        s += `| ${d.from} | ${d.to} | ${d.connections} |\n`
      }
      sections.push(s)
    }

    return sections.join('\n\n')
  }

  function formatContextForPrompt(ctx) {
    if (!ctx) return ''
    const lines = ['\n\n--- LIVE INFRASTRUCTURE CONTEXT (from AppCloud graph database) ---\n']

    if (ctx.apps.length) {
      lines.push(`APPLICATIONS (${ctx.apps.length} total):`)
      for (const a of ctx.apps) {
        lines.push(`  - ${a.name} | tier ${a.tier || '?'} | owner: ${a.owner || 'unassigned'} | env: ${a.env || '?'} | domain: ${a.domain || '?'} | ${a.components} components`)
      }
    } else {
      lines.push('APPLICATIONS: none registered yet')
    }

    if (ctx.infra.length) {
      lines.push(`\nINFRASTRUCTURE:`)
      for (const i of ctx.infra) {
        lines.push(`  - ${i.provider}/${i.type}: ${i.count} resources (${i.mapped} mapped to components)`)
      }
    }

    if (ctx.unmapped.length) {
      lines.push(`\nUNMAPPED RESOURCES (${ctx.unmapped.length} shown):`)
      for (const u of ctx.unmapped) {
        lines.push(`  - ${u.provider}/${u.type}: ${u.name} (${u.region || 'unknown region'})`)
      }
    }

    if (ctx.crossApp.length) {
      lines.push(`\nCROSS-APPLICATION DEPENDENCIES:`)
      for (const d of ctx.crossApp) {
        lines.push(`  - ${d.from} → ${d.to} (${d.connections} connections)`)
      }
    }

    lines.push('\n--- END CONTEXT ---')
    return lines.join('\n')
  }

  // ── Chat actions — detect intent and execute via internal API calls ─────
  // Instead of asking the LLM to "run agents", we pattern-match the user's
  // message and call the real endpoints, then format the results as a response.

  const CHAT_ACTIONS = [
    {
      id: 'run_discovery',
      patterns: [/run\s+(the\s+)?discover/i, /scan\s+(all|cloud|infra)/i, /start\s+(the\s+)?discover/i, /trigger\s+(the\s+)?discover/i, /execute\s+(the\s+)?discover/i],
      description: 'Run cloud discovery scan across all configured accounts',
      execute: async () => {
        const res = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/scan/all`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        const data = await res.json()
        if (!res.ok) return `## Discovery Scan Failed\n\n${data.message || data.error || 'Unknown error'}`
        let report = `## Discovery Scan Complete\n\n`
        report += `**${data.total || 0}** resources found across **${data.accounts || 0}** account(s) in ${((data.duration || 0) / 1000).toFixed(1)}s.\n\n`
        if (data.results?.length) {
          report += `| Account | Resources | Status |\n|---------|-----------|--------|\n`
          for (const r of data.results) {
            report += `| ${r.account || r.provider || '?'} | ${r.total ?? 0} | ${r.error ? 'Error: ' + r.error : 'OK'} |\n`
          }
        }
        if (data.bootstrap) {
          const b = data.bootstrap
          report += `\n### Auto-Bootstrap Results\n`
          report += `- Applications created: **${b.appsCreated ?? 0}**\n`
          report += `- Components created: **${b.componentsCreated ?? 0}**\n`
          report += `- Resources linked: **${b.linked ?? 0}**\n`
        }
        if (data.stale) {
          report += `\n- Stale nodes cleaned: **${data.stale.removed ?? 0}**\n`
        }
        return report
      },
    },
    {
      id: 'run_mapping',
      patterns: [/run\s+(the\s+)?mapp/i, /start\s+(the\s+)?mapp/i, /trigger\s+(the\s+)?mapp/i, /execute\s+(the\s+)?mapp/i, /link\s+(unmapped|resources)/i, /map\s+(unmapped|resources)/i, /apply\s+(all\s+)?suggest/i],
      description: 'Run bootstrap mapping to link unmapped resources to applications',
      execute: async () => {
        const res = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/bootstrap`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        const data = await res.json()
        if (!res.ok) return `## Mapping Failed\n\n${data.message || data.error || 'Unknown error'}`
        let report = `## Mapping & Bootstrap Complete\n\n`
        report += `- Applications created: **${data.appsCreated ?? 0}**\n`
        report += `- Components created: **${data.componentsCreated ?? 0}**\n`
        report += `- Resources linked: **${data.linked ?? 0}**\n`
        if (data.tagBased) report += `- Tag-based matches: **${data.tagBased ?? 0}**\n`
        if (data.rgBased) report += `- Resource-group matches: **${data.rgBased ?? 0}**\n`
        if (data.details?.length) {
          report += `\n### Details\n\n`
          for (const d of data.details.slice(0, 15)) {
            report += `- ${d.action || 'linked'}: **${d.name || d.resource || '?'}** → ${d.app || d.application || '?'}\n`
          }
          if (data.details.length > 15) report += `- ... and ${data.details.length - 15} more\n`
        }
        return report
      },
    },
    {
      id: 'run_discovery_and_mapping',
      patterns: [/run\s+(the\s+)?(discover\w*\s+and\s+mapp|discover\w*\s*[&,]\s*mapp)/i, /run\s+(the\s+)?(mapp\w*\s+and\s+discover|mapp\w*\s*[&,]\s*discover)/i, /run\s+(all\s+)?(the\s+)?agents/i, /run\s+(the\s+)?pipeline/i, /execute\s+(all\s+)?(the\s+)?agents/i],
      description: 'Run discovery scan followed by mapping',
      execute: async () => {
        // Step 1: Discovery
        let report = `## Agent Pipeline Execution\n\n### Step 1: Discovery Scan\n\n`
        const discRes = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/scan/all`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        const disc = await discRes.json()
        if (discRes.ok) {
          report += `Scanned **${disc.accounts || 0}** account(s) — **${disc.total || 0}** resources found in ${((disc.duration || 0) / 1000).toFixed(1)}s.\n\n`
          if (disc.results?.length) {
            report += `| Account | Resources | Status |\n|---------|-----------|--------|\n`
            for (const r of disc.results) {
              report += `| ${r.account || r.provider || '?'} | ${r.total ?? 0} | ${r.error ? 'Error' : 'OK'} |\n`
            }
            report += '\n'
          }
        } else {
          report += `Discovery failed: ${disc.message || disc.error || 'Unknown error'}\n\n`
        }

        // Step 2: Mapping
        report += `### Step 2: Mapping & Bootstrap\n\n`
        const mapRes = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/bootstrap`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        const map = await mapRes.json()
        if (mapRes.ok) {
          report += `- Applications created: **${map.appsCreated ?? 0}**\n`
          report += `- Components created: **${map.componentsCreated ?? 0}**\n`
          report += `- Resources linked: **${map.linked ?? 0}**\n`
        } else {
          report += `Mapping failed: ${map.message || map.error || 'Unknown error'}\n`
        }

        // Summary
        report += `\n### Summary\n\n`
        report += `Discovery and mapping pipeline completed. `
        if (discRes.ok) report += `${disc.total || 0} resources discovered. `
        if (mapRes.ok) report += `${map.appsCreated ?? 0} apps created, ${map.linked ?? 0} resources linked.`
        return report
      },
    },
  ]

  function detectAction(userMessage) {
    const text = userMessage.trim()
    for (const action of CHAT_ACTIONS) {
      for (const pattern of action.patterns) {
        if (pattern.test(text)) return action
      }
    }
    return null
  }

  fastify.post('/chat', {
    schema: {
      summary:     'Conversational chat with live graph context',
      description: 'Injects a fresh snapshot of applications + infra + unmapped resources + cross-app deps into the system prompt before forwarding the conversation. Returns the assistant\'s reply plus a reference to the context used.',
      body: { type: 'object', required: ['messages'], additionalProperties: true, properties: {
        messages: { type: 'array', items: { type: 'object', required: ['role', 'content'], additionalProperties: true,
          properties: { role: { type: 'string', enum: ['user', 'assistant', 'system'] }, content: { type: 'string' } } } },
      } },
      response: { 200: { type: 'object', additionalProperties: true }, 503: StandardErrorResponses[503] },
    },
  }, async (req, reply) => {
    const svc = fastify.ai
    if (!svc) return reply.internalServerError('AI service unavailable')

    const { messages, useLocal = false, cloudOverride } = req.body || {}
    if (!messages?.length) return reply.badRequest('messages array is required')

    // ── Check for action intent before calling the LLM ────────────────────
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'user') {
      const action = detectAction(lastMsg.content)
      if (action) {
        try {
          fastify.log.info(`[AI Chat] Action detected: ${action.id}`)
          const result = await action.execute()
          return {
            choices: [{ message: { content: result }, finish_reason: 'stop' }],
            output: result,
            model: 'appcloud-actions',
            provider: 'internal',
            action: action.id,
          }
        } catch (err) {
          fastify.log.error(`[AI Chat] Action ${action.id} failed: ${err.message}`)
          const errorMsg = `## Action Failed\n\nFailed to execute **${action.description}**: ${err.message}`
          return {
            choices: [{ message: { content: errorMsg }, finish_reason: 'stop' }],
            output: errorMsg,
            model: 'appcloud-actions',
            provider: 'internal',
            action: action.id,
          }
        }
      }
    }

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
        // Refresh DB-stored cloud config in case it was saved since last check
        if (!svc.cloudAvailable && svc.refreshCloudFromDb) {
          await svc.refreshCloudFromDb()
        }
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

    // Build a live context snapshot from the graph database
    const ctx = await buildContextSnapshot()
    const contextBlock = formatContextForPrompt(ctx)

    // Build a pre-analyzed report from the data so the LLM only needs to
    // rewrite it in natural language — even small models can do this reliably.
    const preAnalysis = buildPreAnalysis(ctx)

    const systemPrompt = `You are AppCloud's infrastructure analyst. Rewrite the REPORT below into a clear, well-structured response. Use markdown formatting. Do not add any information that is not in the report. Do not suggest commands, URLs, or tools.`

    // For the user message, include the pre-analysis as a "report to rewrite"
    // plus the raw data as reference, plus the original question.
    const enrichedMessages = [...messages]
    const lastIdx = enrichedMessages.length - 1
    if (lastIdx >= 0 && enrichedMessages[lastIdx].role === 'user' && ctx) {
      const userQ = enrichedMessages[lastIdx].content
      enrichedMessages[lastIdx] = {
        role: 'user',
        content: `Question: ${userQ}

REPORT (rewrite this into a clear answer — do not add anything not in this report):
${preAnalysis}

RAW DATA for reference:
${contextBlock}

Rewrite the REPORT above as a helpful answer to the question. Use the exact names, numbers, and facts from the report. Do not invent any information.`,
      }
    }

    const withSystem = enrichedMessages[0]?.role === 'system'
      ? enrichedMessages
      : [{ role: 'system', content: systemPrompt }, ...enrichedMessages]

    try {
      const result = await provider.chat(withSystem, { maxTokens: 2048 })
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