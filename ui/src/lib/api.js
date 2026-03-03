const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

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

// Graph
export const api = {
  graph: {
    summary: () => req('/graph/summary'),
    crossAppDeps: () => req('/graph/cross-app-dependencies'),
    allConnections: () => req('/graph/all-connections'),
    topology: () => req('/graph/topology'),
    impact: (infraId) => req(`/graph/impact?infraId=${infraId}`),
    path: (from, to) => req(`/graph/path?from=${from}&to=${to}`),
    snapshots: () => req('/graph/snapshots'),
    createSnapshot: (label) => req('/graph/snapshots', { method: 'POST', body: JSON.stringify({ label }) }),
  },

  // Applications
  applications: {
    list: () => req('/applications'),
    get: (id) => req(`/applications/${id}`),
    topology: (id) => req(`/applications/${id}/topology`),
    dependencies: (id) => req(`/applications/${id}/dependencies`),
    create: (data) => req('/applications', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/applications/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => req(`/applications/${id}`, { method: 'DELETE' }),
  },

  // Components
  components: {
    list: (type) => req(`/components${type ? `?type=${type}` : ''}`),
    get: (id) => req(`/components/${id}`),
    create: (data) => req('/components', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/components/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => req(`/components/${id}`, { method: 'DELETE' }),
    connect: (id, data) => req(`/components/${id}/connections`, { method: 'POST', body: JSON.stringify(data) }),
    deploy: (id, infraId) => req(`/components/${id}/deploy`, { method: 'POST', body: JSON.stringify({ infraId }) }),
  },

  // Infra
  infra: {
    list: (params = {}) => {
      const q = new URLSearchParams(params).toString()
      return req(`/infra${q ? `?${q}` : ''}`)
    },
    get: (id) => req(`/infra/${id}`),
    shared: () => req('/infra/shared/resources'),
    exposed: () => req('/infra/public/exposed'),
    create: (data) => req('/infra', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/infra/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => req(`/infra/${id}`, { method: 'DELETE' }),
  },

  // Changes
  changes: {
    list: (status) => req(`/changes${status ? `?status=${status}` : ''}`),
    get: (id) => req(`/changes/${id}`),
    blastRadius: (id) => req(`/changes/${id}/blast-radius`),
    create: (data) => req('/changes', { method: 'POST', body: JSON.stringify(data) }),
    approve: (id, userId) => req(`/changes/${id}/approve`, { method: 'POST', body: JSON.stringify({ userId }) }),
    reject: (id, userId, reason) => req(`/changes/${id}/reject`, { method: 'POST', body: JSON.stringify({ userId, reason }) }),
  },

  // Users
  users: {
    list: () => req('/users'),
    get: (id) => req(`/users/${id}`),
    create: (data) => req('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  },
}