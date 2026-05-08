import { INFRA_ONLY_TYPES, PLATFORM_TYPES, hasExplicitAppTag } from './discovery.schema.js'

export function bootstrapSuggestFallback(infraRecords, props) {
  const grouped = {}

  const parse = (v) => {
    try { return typeof v === 'string' ? JSON.parse(v) : v || {} } catch { return {} }
  }

  function normalizeTags(tags) {
    if (!tags || typeof tags !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(tags)) {
      const norm = k.toLowerCase()
        .replace(/^appcloud[:-]/, '')
        .replace(/^app[:-]/, '')
        .replace(/-/g, '_')
        .trim()
      if (!out[norm]) out[norm] = v
    }
    return out
  }

  for (const ir of infraRecords) {
    const infra = props(ir.get('i'))
    const tags = parse(infra.tags)
    const name = (infra.name || '').toLowerCase()
    const rtype = (infra.resource_type || '').toLowerCase()

    // Infrastructure plumbing should never suggest creating its own
    // application — skip so it remains unmapped and gets linked once
    // a workload application exists.
    if (INFRA_ONLY_TYPES.has(rtype) && !hasExplicitAppTag(tags)) continue

    const nt = normalizeTags(tags)
    const app = nt.app || nt.application || nt.project || name.split('-')[0] || 'default-app'

    if (!grouped[app]) grouped[app] = []

    // Match frontend expected shape — include region and tags for UI display
    grouped[app].push({
      infra: {
        id: infra.id,
        name: infra.name,
        resourceType: infra.resource_type,
        provider: infra.provider,
        region: infra.region,
        tags,
      },
      score: 85,
      reasons: ['tag-based grouping']
    })
  }

  return {
    suggestions: Object.entries(grouped).map(([app, list]) => ({
      application: { name: app },
      matches: list
    })),
    diagnostic: {
      mode: 'bootstrap',
      inferredApps: Object.keys(grouped).length,
      totalInfra: infraRecords.length
    }
  }
}
