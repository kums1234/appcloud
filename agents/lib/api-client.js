import { config } from './config.js';

export class AppCloudClient {
  constructor(baseUrl = config.appcloudApiUrl, token = config.appcloudJwtToken) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
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
  listCloudAccounts()       { return this.request('GET', '/discovery/accounts'); }
  scanProvider(provider)    { return this.request('POST', `/discovery/scan/${provider}`); }
  scanAll()                 { return this.request('POST', '/discovery/scan/all'); }
  getDiscoverySummary()     { return this.request('GET', '/discovery/summary'); }
  getResources(query = '')  { return this.request('GET', `/discovery/resources${query ? '?' + query : ''}`); }
  getSuggestions()           { return this.request('GET', '/discovery/suggest'); }
  linkInfra(infraId, componentId) {
    return this.request('POST', '/discovery/link', { infraId, componentId });
  }
  applyAllSuggestions(suggestions) {
    return this.request('POST', '/discovery/suggest/apply-all', { suggestions });
  }
  enrichAzure()             { return this.request('POST', '/discovery/enrich/azure'); }
  bootstrap()               { return this.request('POST', '/discovery/bootstrap'); }
  getLinkingStrategies()     { return this.request('GET', '/discovery/linking-strategies'); }

  // Applications
  listApplications()        { return this.request('GET', '/applications'); }
  createApplication(data)   { return this.request('POST', '/applications', data); }
  updateApplication(id, data) { return this.request('PATCH', `/applications/${id}`, data); }

  // Components
  listComponents()          { return this.request('GET', '/components'); }
  createComponent(data)     { return this.request('POST', '/components', data); }
  deployComponent(id, infraId) {
    return this.request('POST', `/components/${id}/deploy`, { infraId });
  }

  // Workflows
  checkOnboarding(appId)    { return this.request('GET', `/workflows/onboarding/${appId}`); }
  completeOnboardingStep(appId, step, data = {}) {
    return this.request('POST', `/workflows/onboarding/${appId}/complete-step`, { step, ...data });
  }

  // Changes & Blast Radius
  listChanges(status)       { return this.request('GET', `/changes${status ? '?status=' + status : ''}`); }
  getBlastRadius(changeId)  { return this.request('GET', `/changes/${changeId}/blast-radius`); }
  previewImpact(targetIds)  { return this.request('POST', '/changes/impact-preview', { targetIds }); }
  getHighRiskChanges()      { return this.request('GET', '/changes/risk/high'); }

  // Graph
  getTopology()             { return this.request('GET', '/graph/topology'); }
  getGraphSummary()         { return this.request('GET', '/graph/summary'); }
  getCrossAppDeps()         { return this.request('GET', '/graph/cross-app-dependencies'); }
  getImpact(infraId)        { return this.request('GET', `/graph/impact?infraId=${infraId}`); }
}
