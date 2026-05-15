// plugins/ai.js

import { createLocalProvider, createCloudProvider, createCloudProviderFromOptions } from '../utils/ai-providers.js'
import { decrypt } from '../utils/encrypt.js'

// ─── Prompt library ──────────────────────────────────────────────────────────

export const SYSTEM_INFRA = `You are an infrastructure intelligence assistant embedded in AppCloud,
a graph-based platform for modelling cloud infrastructure relationships and blast-radius reasoning.
Be concise, technical, and actionable. Never hallucinate resource IDs or names
— only refer to data provided in the prompt. Respond in plain text unless asked for JSON.`

// ─── Local AI helpers (Ollama) ────────────────────────────────────────────────

async function explainMapping(local, infra, suggestion) {
  const prompt = `You are reviewing a cloud resource mapping suggestion.

Resource: "${infra.name}" (${infra.provider} / ${infra.resourceType}, region: ${infra.region || 'unknown'})
Tags: ${JSON.stringify(infra.tags || {})}

Suggested action: ${suggestion.action} — ${suggestion.actionLabel}
Score: ${suggestion.score}/100
Reasons: ${(suggestion.reasons || []).join('; ')}

In 2-3 sentences, explain WHY this mapping makes sense (or doesn't) and what the operator
should verify before confirming it. Be specific to the resource type and tags shown.`

  const r = await local.chat([
    { role: 'system', content: SYSTEM_INFRA },
    { role: 'user',   content: prompt },
  ], { temperature: 0.2, maxTokens: 256 })
  return r.text.trim()
}

async function scoreMapping(local, infra, apps) {
  const candidates = apps.slice(0, 5).map(a => ({
    id: a.id, name: a.name, tier: a.tier, owner: a.owner, environment: a.environment,
    domain: a.domain,
  }))

  const prompt = `Given this cloud resource, rank which application it most likely belongs to.

Resource: ${infra.name} (${infra.provider}/${infra.resourceType})
Tags: ${JSON.stringify(infra.tags || {})}

Candidate applications:
${JSON.stringify(candidates, null, 2)}

Respond ONLY with a JSON array (no markdown, no explanation) in this exact format:
[{"appId":"<id>","confidence":"high|medium|low","reason":"<one sentence>"}]
Ordered by confidence descending. Include only candidates where you see a genuine signal.`

  const r = await local.chat([
    { role: 'system', content: SYSTEM_INFRA },
    { role: 'user',   content: prompt },
  ], { temperature: 0.1, maxTokens: 512 })

  try {
    const clean = r.text.replace(/```(?:json)?|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return []
  }
}

async function explainImpact(local, infraName, components, apps, walkContext = {}) {
  const appList  = apps.map(a => `${a.name} (tier ${a.tier || '?'}, env: ${a.environment || '?'})`).join(', ')
  // depth is optional and only set when callers feed the polymorphic
  // bfsWalk result through; older 1-hop callers omit it and the
  // direct-deployment label is implicit.
  const compList = components.map(c => {
    const tag = c.depth ? ` @depth ${c.depth}` : ''
    return `${c.name} (${c.type || 'service'}${tag})`
  }).join(', ')

  const rollupNote = (walkContext.rollups || []).length
    ? `Cross-bucket reach: ${walkContext.rollups.map(r => `${r.key} (${r.count} resources)`).join(', ')}.`
    : ''
  const reachedNote = walkContext.reachedDepth
    ? `Walk reached depth ${walkContext.reachedDepth}${walkContext.truncated ? ' (truncated, more downstream)' : ''}.`
    : ''

  const prompt = `Summarise the business impact if this infrastructure resource became unavailable.

Infrastructure: ${infraName}
Components affected: ${compList || 'none mapped'}
Applications affected: ${appList || 'none mapped'}
${reachedNote}
${rollupNote}

Write 2-3 sentences on likely user/business impact and which teams would be affected.
Components shown with `@depth N` are reached N hops up the structural chain — call out the difference between directly-deployed (depth 1) and transitively-affected (depth >1) where it matters.
Be direct — no hedging language.`

  const r = await local.chat([
    { role: 'system', content: SYSTEM_INFRA },
    { role: 'user',   content: prompt },
  ], { temperature: 0.2, maxTokens: 256 })
  return r.text.trim()
}

// ─── Cloud AI helpers ─────────────────────────────────────────────────────────

async function planArchitecture(cloud, context) {
  const prompt = `You are a senior cloud architect advising on AppCloud infrastructure.

Current topology summary:
${JSON.stringify(context, null, 2)}

Provide:
1. Three concrete architectural improvements ranked by impact
2. Any tier-1 application risks visible in the topology
3. A one-paragraph migration or modernisation recommendation

Be specific to the resources and relationships shown. Reference application names and tiers.`

  const r = await cloud.chat([
    { role: 'system', content: SYSTEM_INFRA },
    { role: 'user',   content: prompt },
  ], { temperature: 0.4, maxTokens: 1024 })
  return r.text.trim()
}

async function planDriftRemediation(cloud, driftItems) {
  const prompt = `Review these infrastructure drift items and produce a remediation plan.

Drift items (resources discovered in cloud but not linked to any application/component):
${JSON.stringify(driftItems.slice(0, 30), null, 2)}

For each item provide:
- Recommended action: link_to_existing | create_new_component | decommission | investigate
- Priority: critical | high | medium | low
- Rationale in one sentence

Then summarise: total items by action type, estimated effort, and the single highest-priority action.
Respond as structured JSON with keys: items (array), summary (object).`

  const r = await cloud.chat([
    { role: 'system', content: SYSTEM_INFRA },
    { role: 'user',   content: prompt },
  ], { temperature: 0.2, maxTokens: 2048 })

  const clean = r.text.replace(/```(?:json)?|```/g, '').trim()
  try {
    return { parsed: JSON.parse(clean), raw: r.text, provider: r.provider, model: r.model }
  } catch {
    return { parsed: null, raw: r.text, provider: r.provider, model: r.model }
  }
}

async function analyzeDependencies(cloud, topology, walkContext = {}) {
  const { apps, connections, components } = topology
  const crossApp = connections?.filter(c => c.fromAppId !== c.toAppId) || []

  // Per-Tier-1 fan-in (when supplied by the route). Each entry is a
  // bfsWalk(inbound) projection: upstream Applications by name + tier,
  // plus rollup buckets the dependents span. Gives the LLM concrete
  // hotspot signals to call out instead of paraphrasing edge counts.
  const fanInBlock = (walkContext.tier1FanIn || []).map(t1 => {
    const upstream = t1.upstreamApps?.length
      ? t1.upstreamApps.map(u => `${u.name} (tier ${u.tier || '?'})`).join(', ')
      : 'none reached'
    const rollups = t1.rollups?.length
      ? t1.rollups.map(r => `${r.key}×${r.count}`).join(', ')
      : 'none'
    return `  - ${t1.app} (tier ${t1.tier}): upstream=[${upstream}], rollup-fan=[${rollups}], depth=${t1.reachedDepth}${t1.truncated ? ' (truncated)' : ''}`
  }).join('\n')

  const prompt = `Analyse this application dependency topology for risks and improvement opportunities.

Applications: ${apps?.length || 0} total
  Tier-1: ${apps?.filter(a => a.tier === 1).map(a => a.name).join(', ') || 'none'}
  Tier-2: ${apps?.filter(a => a.tier === 2).map(a => a.name).join(', ') || 'none'}
Cross-application connections: ${crossApp.length}
Sample cross-app dependencies:
${crossApp.slice(0, 10).map(c => `  ${c.fromAppId} → ${c.toAppId} via ${c.protocol || 'unknown'}`).join('\n')}
${fanInBlock ? `\nTier-1 fan-in (who depends on each Tier-1 app, up to depth 4):\n${fanInBlock}\n` : ''}

Identify:
1. Single points of failure (services many others depend on — the Tier-1 fan-in shows you which apps have the largest upstream blast radius)
2. Circular or risky dependency chains
3. Tier-1 apps with external dependencies that could cascade
4. Shared-resource-group hotspots (multiple Tier-1 apps with overlapping rollup-fan keys = blast radius beyond what edge counts show)
5. Recommendations to improve resilience

Be specific. Reference the topology data provided.`

  const r = await cloud.chat([
    { role: 'system', content: SYSTEM_INFRA },
    { role: 'user',   content: prompt },
  ], { temperature: 0.3, maxTokens: 1024 })
  return { analysis: r.text.trim(), provider: r.provider, model: r.model }
}

// ─── Safe wrapper — never throws, returns { error } on failure ────────────────

function safe(fn) {
  return async (...args) => {
    try {
      return await fn(...args)
    } catch (err) {
      return { error: err.message, available: false }
    }
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export async function aiPlugin(fastify) {
  const local = createLocalProvider(fastify.log)
  const cloudEnv = createCloudProvider(fastify.log)   // from env vars (highest priority)

  // DB-sourced cloud provider (fallback when env vars don't provide one)
  let _cloudDb = null

  // The effective cloud provider: env vars take priority, then DB
  let cloud = cloudEnv

  // Track liveness with a short TTL — Ollama can crash mid-session and
  // the previous behaviour (cached at boot, only re-checked when
  // _localAvailable=false) would let a request 5xx with a confusing
  // "available" claim. The TTL is short enough that ops sees the
  // outage on the next request, long enough that we don't spam Ollama
  // with isAvailable() checks under burst traffic.
  let _localAvailable    = false
  let _localCheckedAt    = 0
  const LOCAL_CHECK_TTL_MS = parseInt(process.env.APPCLOUD_OLLAMA_CHECK_TTL_MS || '30000', 10)

  const checkLocal = async () => {
    try {
      _localAvailable = await local.isAvailable()
    } catch {
      _localAvailable = false
    }
    _localCheckedAt = Date.now()
    return _localAvailable
  }

  // Probe-with-cache: true if the cached result is fresh AND positive,
  // otherwise re-check. A negative cached result re-checks immediately
  // — fast path for "Ollama is up" the common case, accurate path for
  // "Ollama just came online or just crashed".
  const isLocalAvailable = async () => {
    if (_localAvailable && (Date.now() - _localCheckedAt) < LOCAL_CHECK_TTL_MS) {
      return true
    }
    return checkLocal()
  }

  // Non-blocking initial check
  checkLocal().then(ok => {
    if (ok)  fastify.log.info(`[AI] Local provider ready: Ollama (${local.model}) at ${local.baseUrl}`)
    else     fastify.log.warn(`[AI] Ollama not reachable at ${local.baseUrl} — local AI features will return 503 until Ollama is available`)
  })

  if (cloudEnv) fastify.log.info(`[AI] Cloud provider (env): ${cloudEnv.name} (${cloudEnv.model})`)
  else       fastify.log.info('[AI] Cloud AI not configured via env (set AI_CLOUD_PROVIDER + API key, or use Integrations UI)')

  // ── DB fallback — read ai_config table ─────────────────────────────────────
  const refreshCloudFromDb = async () => {
    if (!fastify.pg?.pool) return
    try {
      const rows = await fastify.pg.query(
        'SELECT provider, config FROM ai_config WHERE enabled = true LIMIT 1'
      )
      if (!rows.length) {
        _cloudDb = null
        if (!cloudEnv) cloud = null
        return
      }
      const row = rows[0]
      const config = row.config || {}
      // Decrypt the apiKey
      if (config.apiKey) {
        try { config.apiKey = decrypt(config.apiKey) } catch {}
      }
      _cloudDb = createCloudProviderFromOptions(fastify.log, {
        provider: row.provider,
        apiKey: config.apiKey,
        model: config.model,
        azureEndpoint: config.azureEndpoint,
        azureDeployment: config.azureDeployment,
      })
      // Only use DB provider if env vars didn't set one
      if (!cloudEnv && _cloudDb) {
        cloud = _cloudDb
        fastify.log.info(`[AI] Cloud provider (DB): ${_cloudDb.name} (${_cloudDb.model})`)
      }
    } catch (err) {
      fastify.log.warn(`[AI] Failed to load cloud config from DB: ${err.message}`)
      _cloudDb = null
    }
  }

  // Load DB config at startup (non-blocking)
  fastify.addHook('onReady', async () => {
    await refreshCloudFromDb()
  })

  // ── Provider accessors with proper HTTP errors ────────────────────────────
  // Uses fastify.httpErrors from @fastify/sensible — returns a proper 503 object
  // that Fastify's reply.send() serialises correctly, rather than a raw Error.

  const getLocal = async () => {
    if (!(await isLocalAvailable())) {
      throw fastify.httpErrors.serviceUnavailable(
        `Local AI (Ollama) is not reachable at ${local.baseUrl}. ` +
        `Ensure Ollama is running and the model is pulled: ollama pull ${local.model}`
      )
    }
    return local
  }

  const getCloud = () => {
    if (!cloud) {
      throw fastify.httpErrors.serviceUnavailable(
        'Cloud AI is not configured. Set AI_CLOUD_PROVIDER (anthropic|openai|gemini|azure) ' +
        'and the corresponding API key environment variable.'
      )
    }
    return cloud
  }

  fastify.decorate('ai', {
    local,
    get cloud() { return cloud },
    get localAvailable() { return _localAvailable },
    get cloudAvailable()  { return !!cloud },
    get cloudDbConfigured() { return !!_cloudDb },
    checkLocal,
    refreshCloudFromDb,

    // Local helpers — throw 503 if Ollama unavailable
    explainMapping: async (infra, suggestion) =>
      explainMapping(await getLocal(), infra, suggestion),
    scoreMapping: async (infra, apps) =>
      scoreMapping(await getLocal(), infra, apps),
    explainImpact: async (infraName, comps, apps, walkContext) =>
      explainImpact(await getLocal(), infraName, comps, apps, walkContext),

    // Cloud helpers — throw 503 if not configured
    planArchitecture: (ctx) =>
      planArchitecture(getCloud(), ctx),
    planDriftRemediation: (items) =>
      planDriftRemediation(getCloud(), items),
    analyzeDependencies: (topo, walkContext) =>
      analyzeDependencies(getCloud(), topo, walkContext),

    // Safe variants — return { error } instead of throwing (for optional enrichment)
    safe: {
      explainMapping: safe(async (infra, s) => explainMapping(await getLocal(), infra, s)),
      scoreMapping:   safe(async (infra, apps) => scoreMapping(await getLocal(), infra, apps)),
      explainImpact:  safe(async (n, c, a, wc) => explainImpact(await getLocal(), n, c, a, wc)),
    },
  })

  fastify.log.info('[AI] Plugin registered')
}