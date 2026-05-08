// api/src/connectors/azure/index.js
//
// Connector-framework adapter for Azure. Thin wrapper over the existing
// scanAzure() helper in routes/discovery.js; same rationale + constraints
// as the aws adapter.

import { scanAzure } from '../../routes/discovery.js'

const authSchema = {
  type: 'object',
  required: ['subscriptionId'],
  properties: {
    subscriptionId: { type: 'string' },
    clientId:       { type: 'string' },
    clientSecret:   { type: 'string' },
    tenantId:       { type: 'string' },
    syncScope:      { type: 'string' },
  },
}

/** @type {import('../types.js').UiMetadata} */
const uiMetadata = {
  vendor:         'Microsoft',
  tagline:        'Discover Azure VMs, AKS, SQL, App Service, Redis, VNets and more via Azure Resource Manager.',
  logo:           'AZ',
  color:          '#0078D4',
  secondaryColor: '#50B0F0',
  badge:          'Discovery',
  capabilities: [
    'VMs / AKS / SQL',
    'App Service / Redis',
    'VNet topology',
    'Service principal or managed identity',
  ],
  fields: [
    { key: 'subscriptionId', label: 'SUBSCRIPTION ID',               type: 'text',
      placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    { key: 'clientId',       label: 'CLIENT ID (APP REGISTRATION)',  type: 'text',
      placeholder: 'App registration Application ID',
      help: 'Leave blank + clientSecret blank to use the pod\'s DefaultAzureCredential chain (managed identity / env).' },
    { key: 'clientSecret',   label: 'CLIENT SECRET',                 type: 'password',
      placeholder: '••••••••' },
    { key: 'tenantId',       label: 'TENANT ID (OPTIONAL)',          type: 'text',
      placeholder: 'Auto-detected via ARM metadata if blank' },
    { key: 'syncScope',      label: 'RESOURCE GROUPS (OPTIONAL)',    type: 'text',
      placeholder: '* for all, or comma-separated names',
      help: 'Currently informational; scanAzure queries all RGs in the subscription.' },
  ],
}

async function healthCheck(cfg) {
  if (!cfg.subscriptionId || !String(cfg.subscriptionId).trim()) {
    return { ok: false, detail: 'subscriptionId is required' }
  }
  return { ok: true, detail: 'config looks valid — use Scan to exercise credentials' }
}

async function* fetch(cfg) {
  yield cfg
}

function normalize(raw) {
  return { kind: 'azure-scan', config: raw }
}

async function ingest({ config }, ctx) {
  const credentials = (config.clientId && config.clientSecret)
    ? {
        clientId:     config.clientId,
        clientSecret: config.clientSecret,
        ...(config.tenantId ? { tenantId: config.tenantId } : {}),
      }
    : null

  const r = await scanAzure({
    credentials,
    subscriptionId: config.subscriptionId,
    write:          ctx.neo4j.write,
    log:            ctx.log,
    scanEpoch:      Date.now(),
  })

  const numericTotal =
    (r.vms || 0) + (r.aks || 0) + (r.sql || 0) +
    (r.appService || 0) + (r.redis || 0) + (r.vnet || 0)

  return {
    resourcesFound:    numericTotal,
    resourcesCreated:  0,
    resourcesUpdated:  numericTotal,
    resourcesSkipped:  (r.skipped || []).length,
    edgesCreated:      0,
    warnings:          r.errors || [],
  }
}

/** @type {import('../types.js').ConnectorSpec} */
const spec = {
  id:          'azure',
  category:    'cloud',
  displayName: 'Microsoft Azure',
  description: 'Discovers Azure Resource Manager topology across a subscription.',
  authSchema,
  uiMetadata,
  healthCheck,
  fetch,
  normalize,
  ingest,
}

export default spec
