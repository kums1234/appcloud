// api/src/connectors/gcp/index.js
//
// Connector-framework adapter for Google Cloud Platform. Thin wrapper over
// the existing scanGCP() helper in routes/discovery.js.

import { scanGCP } from '../../routes/discovery.js'

const authSchema = {
  type: 'object',
  required: ['projectId'],
  properties: {
    projectId:      { type: 'string' },
    serviceAccount: { type: 'string' },  // JSON string; parsed at scan time
    syncScope:      { type: 'string' },
  },
}

/** @type {import('../types.js').UiMetadata} */
const uiMetadata = {
  vendor:         'Google',
  tagline:        'Discover GCE, GKE, Cloud SQL, Cloud Run and related services via Google Cloud APIs.',
  logo:           'GCP',
  color:          '#4285F4',
  secondaryColor: '#34A853',
  badge:          'Discovery',
  capabilities: [
    'GCE / GKE',
    'Cloud SQL',
    'Cloud Run',
    'Service-account JSON auth',
  ],
  fields: [
    { key: 'projectId',      label: 'PROJECT ID',           type: 'text',
      placeholder: 'my-gcp-project' },
    { key: 'serviceAccount', label: 'SERVICE ACCOUNT JSON', type: 'textarea',
      placeholder: '{ "type": "service_account", "client_email": "…", … }',
      help: 'Leave blank to use Application Default Credentials from the API pod.' },
    { key: 'syncScope',      label: 'SYNC SCOPE (RESERVED)', type: 'text',
      placeholder: 'Informational only for now',
      help: 'Future: scope to GKE + Compute only, or a label filter. Scan is currently project-wide.' },
  ],
}

async function healthCheck(cfg) {
  if (!cfg.projectId || !String(cfg.projectId).trim()) {
    return { ok: false, detail: 'projectId is required' }
  }
  if (cfg.serviceAccount) {
    try { JSON.parse(cfg.serviceAccount) }
    catch (err) { return { ok: false, detail: `serviceAccount must be valid JSON: ${err.message}` } }
  }
  return { ok: true, detail: 'config looks valid — use Scan to exercise credentials' }
}

async function* fetch(cfg) {
  yield cfg
}

function normalize(raw) {
  return { kind: 'gcp-scan', config: raw }
}

async function ingest({ config }, ctx) {
  let credentials = null
  if (config.serviceAccount) {
    try { credentials = JSON.parse(config.serviceAccount) }
    catch (err) {
      return { resourcesFound: 0, resourcesCreated: 0, resourcesUpdated: 0,
               resourcesSkipped: 0, warnings: [`serviceAccount JSON parse: ${err.message}`] }
    }
  }

  const r = await scanGCP({
    credentials,
    projectId: config.projectId,
    write:     ctx.neo4j.write,
    log:       ctx.log,
    scanEpoch: Date.now(),
  })

  const numericTotal =
    (r.instances || 0) + (r.gke || 0) + (r.sql || 0) + (r.cloudRun || 0)

  return {
    resourcesFound:    numericTotal,
    resourcesCreated:  0,
    resourcesUpdated:  numericTotal,
    resourcesSkipped:  0,
    edgesCreated:      0,
    warnings:          r.errors || [],
  }
}

/** @type {import('../types.js').ConnectorSpec} */
const spec = {
  id:          'gcp',
  category:    'cloud',
  displayName: 'Google Cloud Platform',
  description: 'Discovers GCP compute, container, database and serverless resources via Google Cloud APIs.',
  authSchema,
  uiMetadata,
  healthCheck,
  fetch,
  normalize,
  ingest,
}

export default spec
