// Shared OpenAPI tag table. Used by:
//   - server.js          (live Swagger UI grouping)
//   - scripts/export-openapi.js  (committed docs/openapi.{json,yaml})
//   - __tests__/openapi-drift.test.js  (drift assertion)
//
// The drift test boots its own Fastify and re-runs route registration,
// so any divergence between the test's tag table and the script's would
// produce a perpetual "out of sync" failure even when the docs are fine.
// Centralising here removes that whole class of bug — adding a path
// segment is a one-file change.

export const PATH_SEG_TO_TAG = {
  applications: 'Applications',
  components:   'Components',
  infra:        'Infra',
  graph:        'Graph',
  ai:           'AI',
  audit:        'Audit',
  cmdb:         'CMDB',
  admin:        'Admin',
  discovery:    'Discovery',
  integrations: 'Integrations',
  connectors:   'Connectors',
  health:       'Health',
  docs:         'OpenAPI',
  openapi:      'OpenAPI',
}

// `transform` callback for @fastify/swagger. Auto-tags every route by
// its first path segment unless the route's schema declares its own
// tags. Routes whose first segment isn't in the map fall back to 'Other'
// so the Swagger UI still groups them coherently.
export function autoTagRoute({ schema, url }) {
  if (schema?.tags?.length) return { schema, url }
  const seg = url.split('/').filter(Boolean)[0]
  const tag = PATH_SEG_TO_TAG[seg] || 'Other'
  return { schema: { ...(schema || {}), tags: [tag] }, url }
}
