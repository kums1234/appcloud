export function bootstrapSuggestFallback(infraRecords, props) {
  const grouped = {}

  const parse = (v) => {
    try { return typeof v === 'string' ? JSON.parse(v) : v || {} } catch { return {} }
  }

  for (const ir of infraRecords) {
    const infra = props(ir.get('i'))
    const tags = parse(infra.tags)
    const name = (infra.name || '').toLowerCase()

    const app = tags.app || tags.application || tags.project || name.split('-')[0] || 'default-app'

    if (!grouped[app]) grouped[app] = []

    // Match frontend expected shape
    grouped[app].push({
      infra: {
        id: infra.id,
        name: infra.name,
        resourceType: infra.resource_type,
        provider: infra.provider
      },
      score: 50,
      reasons: ['bootstrap inferred grouping']
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