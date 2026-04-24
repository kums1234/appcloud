// utils/ai-prompts.js
//
// All prompt templates for AppCloud's AI features.
//
// LOCAL (Ollama / llama3.2:3b):
//   promptTagNormalise       — clean and classify tags from a cloud resource
//   promptInferMapping       — decide app + component assignment for unmapped infra
//   promptExplainBlastRadius — short plain-English explanation of a risk score
//
// CLOUD (Anthropic / OpenAI):
//   promptPlanDecommission — decommissioning impact plan for an application

export const LOCAL_SYSTEM = `You are AppCloud, an infrastructure intelligence engine.
You reason about cloud resources, applications, and their relationships.
You always respond with valid JSON exactly matching the schema requested.
You never add commentary, apologies, or markdown fences.`

export const CLOUD_SYSTEM = `You are AppCloud Advisor, an expert infrastructure architect embedded in AppCloud.
AppCloud is a graph-native infrastructure intelligence platform that tracks applications,
components, and cloud resources with topology-aware risk scoring.
You give clear, actionable advice grounded in the data provided.
You flag risks, dependencies, and recommended actions explicitly.`

// ─── Local prompts ────────────────────────────────────────────────────────────

export function promptTagNormalise({ tags, name, provider }) {
  return {
    system: LOCAL_SYSTEM,
    json: true,
    temperature: 0.0,
    prompt: `Normalise the following cloud resource tags into AppCloud standard fields.

Resource name : ${name}
Provider      : ${provider}
Raw tags      : ${JSON.stringify(tags, null, 2)}

Rules:
- app / application: the application this resource belongs to (title-case, e.g. "Payments Platform")
- component: the component within that app (e.g. "api", "worker", "database")
- environment: production | staging | development | test
- owner: team or person name
- tier: integer 1-4 (1 = most critical)
- extra: any remaining tags that do not fit above, as-is

Infer values from the resource name when tags are empty or ambiguous.
Name segments separated by hyphens often encode app-component-env (e.g. payments-api-prod).

Respond with ONLY this JSON object:
{"app":null,"component":null,"environment":null,"owner":null,"tier":null,"confidence":"low","extra":{}}`
  }
}

export function promptInferMapping({ infra, normalisedTags, existingApps }) {
  const appList = existingApps.length
    ? existingApps.map(a => `- ${a.name} (tier ${a.tier || '?'}, env: ${a.environment || 'unknown'})`).join('\n')
    : '(none - no applications exist yet)'

  return {
    system: LOCAL_SYSTEM,
    json: true,
    temperature: 0.1,
    prompt: `Determine which AppCloud application and component this cloud resource belongs to.

Resource:
  name          : ${infra.name}
  provider      : ${infra.provider}
  resource_type : ${infra.resource_type}
  region        : ${infra.region || 'unknown'}
  normalised tags: ${JSON.stringify(normalisedTags, null, 2)}

Existing applications in AppCloud:
${appList}

Instructions:
1. If the resource belongs to an existing application, use action = "link_component" or "create_component".
2. If it belongs to a new application, use action = "create_application".
3. componentType must be one of: api, worker, database, cache, queue, storage, gateway, function, platform, monitoring, service.
4. confidence: "high" if tag evidence is strong, "medium" if inferred from name, "low" if uncertain.
5. reasons: short strings explaining each decision.
6. score: 0-100 representing certainty of the mapping.

Respond with ONLY this JSON object:
{"appName":null,"componentName":null,"componentType":"service","action":"create_application","confidence":"low","score":50,"reasons":[],"suggestedTier":null,"suggestedEnv":null,"suggestedOwner":null}`
  }
}

export function promptExplainBlastRadius({ application, riskScore, tier, components, connectedApps, infraCount }) {
  return {
    system: LOCAL_SYSTEM,
    json: false,
    temperature: 0.2,
    prompt: `Write a concise plain-English blast radius explanation for an infrastructure risk assessment.

Application   : ${application}
Risk score    : ${riskScore}/100
Tier          : ${tier} (1=most critical, 4=least critical)
Components    : ${components} component(s)
Infra nodes   : ${infraCount} infrastructure resource(s)
Connected apps: ${connectedApps.join(', ') || 'none'}

Write 2-3 sentences explaining:
1. What the risk score means in practical terms for this application
2. Which downstream systems would be affected by an outage
3. The key risk driver (tier, connections, or infra footprint)

Be direct and specific. No bullet points. No headers.`
  }
}

// ─── Cloud prompts ────────────────────────────────────────────────────────────

export function promptPlanDecommission({ application, components, connectedApps, infraNodes, owner }) {
  return {
    system: CLOUD_SYSTEM,
    temperature: 0.3,
    prompt: `Produce a decommissioning plan for the following application in AppCloud.

Application : ${application.name}
Owner       : ${owner || application.owner || 'unknown'}
Tier        : ${application.tier || 'unknown'} (1=most critical)
Environment : ${application.environment || 'unknown'}

Components (${components.length}):
${components.map(c => `- ${c.name} (${c.type || 'service'})`).join('\n') || '  none'}

Connected applications (upstream/downstream):
${connectedApps.map(a => `- ${a.name} [${a.direction}]`).join('\n') || '  none'}

Infrastructure resources (${infraNodes.length}):
${infraNodes.slice(0, 20).map(i => `- ${i.name} (${i.resource_type}, ${i.provider})`).join('\n')}
${infraNodes.length > 20 ? `  ...and ${infraNodes.length - 20} more` : ''}

Produce a structured decommissioning plan covering:
1. Pre-decommission checks (dependencies, traffic, data)
2. Ordered steps to safely remove each component
3. Required communications to connected application owners
4. Infrastructure teardown sequence
5. Validation steps to confirm clean removal
6. Risks and mitigations

Format as a clear plan an operations team can execute.`
  }
}

