// All requests go to /api/* on the same origin.
// Next.js rewrites /api/* → the Fastify API container server-side,
// so the browser never needs a direct connection to the API.
import { buildCloudOverrideForApi } from './ai-client-config'

const BASE = '/api'

function getToken() {
  try {
    const stored = sessionStorage.getItem('appcloud_token')
    if (stored) return JSON.parse(stored)?.token
  } catch {}
  return null
}

async function req(path, options = {}) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  // Token expired / revoked — redirect to login
  if (res.status === 401) {
    try { sessionStorage.removeItem('appcloud_token') } catch {}
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('Session expired — please log in again')
  }
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
    bootstrap:  (data={}) => req('/discovery/bootstrap', { method:'POST', body:JSON.stringify(data) }),
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

  ai: {
    status: (useLocal=false) => req(`/ai/status${useLocal ? '?local=1' : ''}`),
    chat: (messages, useLocal=false) =>
      req('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages,
          useLocal,
          cloudOverride: useLocal ? null : buildCloudOverrideForApi(),
        }),
      }),
  },

  governance: {
    summary:          () => req('/governance/summary'),
    violations:       () => req('/governance/policy-violations'),
    audit:            () => req('/governance/change-audit'),
    heatmap:          () => req('/governance/risk-heatmap'),
    complianceReport: () => req('/governance/compliance-report'),
    csvUrl:           () => `${BASE}/governance/compliance-report/csv`,
    pdfUrl:           () => `${BASE}/governance/compliance-report/pdf`,
  },

  integrations: {
    terraformHistory: () => req('/integrations/terraform/history'),
    aiConfig:         () => req('/integrations/ai'),
    saveAiConfig:     (data) => req('/integrations/ai', { method:'POST', body:JSON.stringify(data) }),
    deleteAiConfig:   () => req('/integrations/ai', { method:'DELETE' }),
    testAiConfig:     () => req('/integrations/ai/test', { method:'POST' }),
    // Connector-framework CRUD (backing store: `integrations` table)
    list:    () => req('/integrations'),
    get:     (id) => req(`/integrations/${id}`),
    create:  (data) => req('/integrations', { method:'POST', body:JSON.stringify(data) }),
    update:  (id, data) => req(`/integrations/${id}`, { method:'PATCH', body:JSON.stringify(data) }),
    delete:  (id) => req(`/integrations/${id}`, { method:'DELETE' }),
    test:    (id) => req(`/integrations/${id}/test`, { method:'POST' }),
    scan:    (id) => req(`/integrations/${id}/scan`, { method:'POST' }),
    history: (id) => req(`/integrations/${id}/history`),
  },

  connectors: {
    // Connector registry — drives the UI's dynamic card/form builder.
    list: () => req('/connectors'),
    get:  (id) => req(`/connectors/${id}`),
  },

  compliance: {
    frameworks:         () => req('/compliance/frameworks'),
    framework:          (id) => req(`/compliance/frameworks/${id}`),
    evaluate:           (id) => req(`/compliance/frameworks/${id}/evaluate`, { method:'POST' }),
    reseedBuiltins:     () => req('/compliance/frameworks/reseed-builtins', { method:'POST' }),
    remediationStatus:  (id) => req(`/compliance/frameworks/${id}/remediation-status`),
    control:            (fwId, ctrlId) => req(`/compliance/controls/${fwId}/${ctrlId}`),
    blastRadius:        (fwId, ctrlId) => req(`/compliance/controls/${fwId}/${ctrlId}/blast-radius`),
    createChange:       (fwId, ctrlId, opts={}) => req(`/compliance/controls/${fwId}/${ctrlId}/create-change`, { method:'POST', body:JSON.stringify(opts) }),
    // Phase B — form builder + CRUD
    schema:             () => req('/compliance/schema'),
    createFramework:    (data) => req('/compliance/frameworks', { method:'POST', body:JSON.stringify(data) }),
    deleteFramework:    (id) => req(`/compliance/frameworks/${id}`, { method:'DELETE' }),
    createControl:      (fwId, data) => req(`/compliance/frameworks/${fwId}/controls`, { method:'POST', body:JSON.stringify(data) }),
    updateControl:      (fwId, ctrlId, data) => req(`/compliance/frameworks/${fwId}/controls/${ctrlId}`, { method:'PATCH', body:JSON.stringify(data) }),
    deleteControl:      (fwId, ctrlId) => req(`/compliance/frameworks/${fwId}/controls/${ctrlId}`, { method:'DELETE' }),
    setOverride:        (fwId, ctrlId, data) => req(`/compliance/frameworks/${fwId}/controls/${ctrlId}/override`, { method:'PUT', body:JSON.stringify(data) }),
    clearOverride:      (fwId, ctrlId) => req(`/compliance/frameworks/${fwId}/controls/${ctrlId}/override`, { method:'DELETE' }),
    // Phase 5 — reporting & scoring
    history:            (fwId, days=30) => req(`/compliance/frameworks/${fwId}/history?days=${days}`),
    // Export URLs — trigger download via <a href>/window.open rather than fetch
    csvUrl:             (fwId) => `${BASE}/compliance/frameworks/${fwId}/export.csv`,
    pdfUrl:             (fwId) => `${BASE}/compliance/frameworks/${fwId}/export.pdf`,
  },

  users: {
    list:   () => req('/users'),
    get:    (id) => req(`/users/${id}`),
    create: (data) => req('/users', { method:'POST', body:JSON.stringify(data) }),
    update: (id, data) => req(`/users/${id}`, { method:'PATCH', body:JSON.stringify(data) }),
  },
}