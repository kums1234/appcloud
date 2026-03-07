// All requests go to /api/* on the same origin.
// Next.js rewrites /api/* → the Fastify API container server-side,
// so the browser never needs a direct connection to the API.
const BASE = '/api'

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error(err.message || 'Request failed')
  }
  if (res.status === 204) return null
  return res.json()
}

export const api = {
  graph: {
    summary:        () => req('/graph/summary'),
    crossAppDeps:   () => req('/graph/cross-app-dependencies'),
    allConnections: () => req('/graph/all-connections'),
    topology:       () => req('/graph/topology'),
    impact:         (infraId) => req(`/graph/impact?infraId=${infraId}`),
    path:           (from, to) => req(`/graph/path?from=${from}&to=${to}`),
    snapshots:      () => req('/graph/snapshots'),
    createSnapshot: (label) => req('/graph/snapshots', { method:'POST', body:JSON.stringify({ label }) }),
  },

  applications: {
    list:         () => req('/applications'),
    get:          (id) => req(`/applications/${id}`),
    topology:     (id) => req(`/applications/${id}/topology`),
    dependencies: (id) => req(`/applications/${id}/dependencies`),
    create:       (data) => req('/applications', { method:'POST', body:JSON.stringify(data) }),
    update:       (id, data) => req(`/applications/${id}`, { method:'PATCH', body:JSON.stringify(data) }),
    delete:       (id) => req(`/applications/${id}`, { method:'DELETE' }),
  },

  components: {
    list:    (type) => req(`/components${type ? `?type=${type}` : ''}`),
    get:     (id) => req(`/components/${id}`),
    create:  (data) => req('/components', { method:'POST', body:JSON.stringify(data) }),
    update:  (id, data) => req(`/components/${id}`, { method:'PATCH', body:JSON.stringify(data) }),
    delete:  (id) => req(`/components/${id}`, { method:'DELETE' }),
    connect: (id, data) => req(`/components/${id}/connections`, { method:'POST', body:JSON.stringify(data) }),
    deploy:  (id, infraId) => req(`/components/${id}/deploy`, { method:'POST', body:JSON.stringify({ infraId }) }),
  },

  infra: {
    list:    (params = {}) => { const q = new URLSearchParams(params).toString(); return req(`/infra${q ? `?${q}` : ''}`) },
    get:     (id) => req(`/infra/${id}`),
    shared:  () => req('/infra/shared/resources'),
    exposed: () => req('/infra/public/exposed'),
    create:  (data) => req('/infra', { method:'POST', body:JSON.stringify(data) }),
    update:  (id, data) => req(`/infra/${id}`, { method:'PATCH', body:JSON.stringify(data) }),
    delete:  (id) => req(`/infra/${id}`, { method:'DELETE' }),
  },

  changes: {
    list:          (status) => req(`/changes${status ? `?status=${status}` : ''}`),
    get:           (id) => req(`/changes/${id}`),
    blastRadius:   (id) => req(`/changes/${id}/blast-radius`),
    impactPreview: (targetIds) => req('/changes/impact-preview', { method:'POST', body:JSON.stringify({ targetIds }) }),
    create:        (data) => req('/changes', { method:'POST', body:JSON.stringify(data) }),
    approve:       (id, userId) => req(`/changes/${id}/approve`, { method:'POST', body:JSON.stringify({ userId }) }),
    reject:        (id, userId, reason) => req(`/changes/${id}/reject`, { method:'POST', body:JSON.stringify({ userId, reason }) }),
  },

  discovery: {
    summary:    () => req('/discovery/summary'),
    resources:  (params = {}) => { const q = new URLSearchParams(params).toString(); return req(`/discovery/resources${q ? `?${q}` : ''}`) },
    accounts:   () => req('/discovery/accounts'),
    addAccount: (data) => req('/discovery/accounts', { method:'POST', body:JSON.stringify(data) }),
    delAccount: (id)  => req(`/discovery/accounts/${id}`, { method:'DELETE' }),
    scanAWS:    (data) => req('/discovery/scan/aws',   { method:'POST', body:JSON.stringify(data) }),
    scanAzure:  (data) => req('/discovery/scan/azure', { method:'POST', body:JSON.stringify(data) }),
    scanGCP:    (data) => req('/discovery/scan/gcp',   { method:'POST', body:JSON.stringify(data) }),
    scanAll:    (data) => req('/discovery/scan/all',   { method:'POST', body:JSON.stringify(data) }),
    link:       (infraId, componentId) => req('/discovery/link', { method:'POST', body:JSON.stringify({ infraId, componentId }) }),
    deleteResource: (id) => req(`/discovery/resources/${id}`, { method:'DELETE' }),
  },

  workflows: {
    summary:           () => req('/workflows/summary'),
    definitions:       () => req('/workflows/definitions'),
    changes:           () => req('/workflows/changes'),
    change:            (id) => req(`/workflows/changes/${id}`),
    advanceChange:     (id, data) => req(`/workflows/changes/${id}/advance`, { method:'POST', body:JSON.stringify(data) }),
    onboarding:        () => req('/workflows/onboarding'),
    onboardingDetail:  (id) => req(`/workflows/onboarding/${id}`),
    completeStep:      (id, step) => req(`/workflows/onboarding/${id}/complete-step`, { method:'POST', body:JSON.stringify({ step }) }),
    drift:             () => req('/workflows/drift'),
    driftAnalysis:     () => req('/workflows/drift/analysis'),
    createDriftChanges:(data) => req('/workflows/drift/create-changes', { method:'POST', body:JSON.stringify(data) }),
  },

  governance: {
    summary:    () => req('/governance/summary'),
    violations: () => req('/governance/policy-violations'),
    audit:      () => req('/governance/change-audit'),
    heatmap:    () => req('/governance/risk-heatmap'),
  },

  integrations: {
    terraformHistory: () => req('/integrations/terraform/history'),
  },

  users: {
    list:   () => req('/users'),
    get:    (id) => req(`/users/${id}`),
    create: (data) => req('/users', { method:'POST', body:JSON.stringify(data) }),
    update: (id, data) => req(`/users/${id}`, { method:'PATCH', body:JSON.stringify(data) }),
  },
}