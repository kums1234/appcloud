// utils/ai-prompts.js
//
// All prompt templates for AppCloud's AI features.
//
// LOCAL (Ollama / llama3.2:3b):
//   promptTagNormalise     — clean and classify tags from a cloud resource
//   promptInferMapping     — decide app + component assignment for unmapped infra
//   promptClassifyDrift    — decide if a config change is drift or expected
//   promptExplainBlastRadius — short plain-English explanation of a risk score
//
// CLOUD (Anthropic / OpenAI):
//   promptPlanDecommission — decommissioning impact plan for an application
//   promptPlanChange       — change advisory for a proposed modification
//   promptGovernanceAdvice — policy gap analysis against governance rules
//   promptDriftReport      — summary report across multiple drift events

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

export function promptClassifyDrift({ resource, before, after, changeType }) {
  return {
    system: LOCAL_SYSTEM,
    json: true,
    temperature: 0.0,
    prompt: `Classify whether this infrastructure change represents unexpected drift or a legitimate expected change.

Resource    : ${resource.name} (${resource.resource_type} / ${resource.provider})
Change type : ${changeType}
Before      : ${JSON.stringify(before, null, 2)}
After       : ${JSON.stringify(after, null, 2)}

Drift classification:
- "configuration_drift": unplanned config change (security group, tags, instance type)
- "state_drift": resource added or removed outside of managed workflows
- "tag_drift": tags changed or removed (could indicate ownership changes)
- "expected_change": change was likely planned (version bump, scaling event)
- "unknown": insufficient data to classify

Respond with ONLY this JSON object:
{"classification":"unknown","severity":"low","explanation":"","recommendation":"","requiresReview":false}`
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

export function promptPlanChange({ application, component, proposedChange, connectedApps, riskScore, tier }) {
  return {
    system: CLOUD_SYSTEM,
    temperature: 0.3,
    prompt: `Provide a change advisory for the following proposed infrastructure change in AppCloud.

Application  : ${application}
Component    : ${component}
Risk score   : ${riskScore}/100
Tier         : ${tier} (1=most critical)
Proposed change: ${proposedChange}

Connected applications that may be affected:
${connectedApps.map(a => `- ${a.name} [${a.direction}]`).join('\n') || '  none'}

Provide:
1. Impact assessment — what could break and for which downstream systems
2. Recommended change window (business hours vs maintenance window)
3. Rollback plan
4. Pre-change verification steps
5. Post-change validation steps
6. Overall recommendation: PROCEED | PROCEED_WITH_CAUTION | DEFER | REJECT

Be specific to the application context. Call out Tier 1 risks explicitly.`
  }
}

export function promptGovernanceAdvice({ application, policies, violations, components }) {
  return {
    system: CLOUD_SYSTEM,
    temperature: 0.3,
    prompt: `Analyse this application's compliance with AppCloud governance policies.

Application : ${application.name} (Tier ${application.tier || '?'})
Environment : ${application.environment || 'unknown'}

Active governance policies:
${policies.map(p => `- ${p.name}: ${p.description}`).join('\n') || '  none'}

Current violations:
${violations.length ? violations.map(v => `- [${v.severity}] ${v.policy}: ${v.message}`).join('\n') : '  none - fully compliant'}

Components:
${components.map(c => `- ${c.name} (${c.type || 'service'})`).join('\n') || '  none'}

Provide:
1. Summary of compliance posture
2. Explanation of each violation and its risk
3. Specific remediation steps ordered by severity
4. Any policy gaps — areas not currently covered by policies that present risk
5. Recommended policy additions for this application type

Be concrete. Reference specific component names where relevant.`
  }
}

export function promptDriftReport({ driftEvents, timeWindow, affectedApps }) {
  return {
    system: CLOUD_SYSTEM,
    temperature: 0.3,
    prompt: `Produce a drift detection summary report for AppCloud.

Time window      : ${timeWindow}
Drift events     : ${driftEvents.length}
Affected applications: ${affectedApps.join(', ') || 'none'}

Events:
${driftEvents.slice(0, 30).map(e =>
  `- [${e.severity}] ${e.resourceName} (${e.resourceType}): ${e.classification} — ${e.explanation}`
).join('\n')}
${driftEvents.length > 30 ? `...and ${driftEvents.length - 30} more events` : ''}

Produce an executive drift report covering:
1. Overall drift health summary (1 paragraph)
2. Top 3 most significant drift patterns observed
3. Applications requiring immediate attention
4. Root cause hypotheses for recurring patterns
5. Recommended actions to reduce drift going forward

Suitable for an engineering lead or platform team review.`
  }
}