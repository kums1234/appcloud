import { config } from './config.js';

export class AppCloudClient {
  constructor(
    baseUrl    = config.appcloudApiUrl,
    apiKey     = config.appcloudApiKey,
    tenantSlug = config.appcloudTenantSlug,
  ) {
    this.baseUrl    = baseUrl.replace(/\/$/, '');
    this.apiKey     = apiKey;
    this.tenantSlug = tenantSlug;
  }

  async request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {};
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (this.tenantSlug) {
      headers['X-Tenant-Slug'] = this.tenantSlug;
    }

    const opts = { method, headers };
    if (body && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);

    if (res.status === 204) return null;

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const msg = typeof data === 'object' ? (data.message || data.error || JSON.stringify(data)) : data;
      throw new Error(`API ${method} ${path} failed (${res.status}): ${msg}`);
    }

    return data;
  }

  // Discovery
  listCloudAccounts()       { return this.request('GET', '/integrations/cloud'); }
  scanProvider(provider)    { return this.request('POST', `/discovery/scan/${provider}`); }
  scanAll()                 { return this.request('POST', '/discovery/scan/all'); }
  getDiscoverySummary()     { return this.request('GET', '/discovery/summary'); }
  getResources(query = '')  { return this.request('GET', `/discovery/resources${query ? '?' + query : ''}`); }
  getUnmappedResources(limit = 1000) {
    // Server-side filter via ?mapped=false — keeps the LIMIT honest so we
    // don't silently truncate the unmapped set on a large tenant.
    return this.request('GET', `/discovery/resources?mapped=false&limit=${limit}`);
  }
  getSuggestions()           { return this.request('GET', '/discovery/suggest'); }
  linkInfra(infraId, componentId) {
    return this.request('POST', '/discovery/link', { infraId, componentId });
  }
  // Body shape on the API side is { actions: [...] }. Three action types:
  //   link_component       — { action, infraId, componentId }
  //   create_component     — { action, infraId, applicationId, newCompName, suggestedType }
  //   create_application   — { action, infraId, newAppName, newCompName, suggestedType,
  //                            suggestedTier, suggestedEnv, suggestedOwner }
  applySuggestActions(actions) {
    return this.request('POST', '/discovery/suggest/apply-all', { actions });
  }
  enrichAzure()             { return this.request('POST', '/discovery/enrich/azure'); }
  bootstrap()               { return this.request('POST', '/discovery/bootstrap'); }
  getLinkingStrategies()     { return this.request('GET', '/discovery/linking-strategies'); }

  // Applications
  listApplications()        { return this.request('GET', '/applications'); }
  getApplication(id)        { return this.request('GET', `/applications/${id}`); }
  getAppTopology(id)        { return this.request('GET', `/applications/${id}/topology`); }
  // /applications/:id/dependencies was removed — use getDependencies(id) on
  // /graph/dependencies for the polymorphic, depth-aware tree.
  createApplication(data)   { return this.request('POST', '/applications', data); }
  updateApplication(id, data) { return this.request('PATCH', `/applications/${id}`, data); }

  // Components
  listComponents()          { return this.request('GET', '/components'); }
  getComponent(id)          { return this.request('GET', `/components/${id}`); }
  createComponent(data)     { return this.request('POST', '/components', data); }
  deployComponent(id, infraId) {
    return this.request('POST', `/components/${id}/deploy`, { infraId });
  }

  // Infra
  listInfra()               { return this.request('GET', '/infra'); }
  getInfra(id)              { return this.request('GET', `/infra/${id}`); }
  getPublicExposed()        { return this.request('GET', '/infra/public/exposed'); }
  getSharedInfra()          { return this.request('GET', '/infra/shared/resources'); }

  // Graph
  getTopology()             { return this.request('GET', '/graph/topology'); }
  getGraphSummary()         { return this.request('GET', '/graph/summary'); }
  getCrossAppDeps()         { return this.request('GET', '/graph/cross-app-dependencies'); }
  getImpact(id)             { return this.request('GET', `/graph/impact?id=${encodeURIComponent(id)}`); }
  getDependencies(id)       { return this.request('GET', `/graph/dependencies?id=${encodeURIComponent(id)}`); }

  // AI assistant chat
  aiStatus()                { return this.request('GET', '/ai/status'); }
  chat(messages, opts = {}) {
    const body = { messages, ...opts };  // opts may include useLocal, cloudOverride
    return this.request('POST', '/ai/chat', body);
  }

  // NOTE: /changes/*, /workflows/*, /users were removed when the project
  // refocused on the multi-tenant control plane. The blast-radius agent
  // was ported to /graph/* in this branch. The onboarding agent's only
  // useful behaviour (Job 2 — infer Application/Component from naming
  // patterns) was folded into the mapping agent's two-pass loop.
}
