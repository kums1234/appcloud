// api/src/connectors/servicenow/index.js
//
// Pull-only ServiceNow CMDB connector. Ingests raw CI rows into Neo4j as
// :CmdbCi nodes keyed on sys_id. Does NOT infer edges — correlation with
// cloud inventory lives in the /cmdb/assessment endpoint (Slice 6).
//
// Config shape:
//   {
//     instance:    'mycompany' | 'mycompany.service-now.com',
//     username:    'api-user',
//     password:    '…',                     // encrypted at rest (SECRET_FIELDS)
//     tables:      ['cmdb_ci_server', …],   // optional; defaults below
//     maxPerTable: 10000,                   // safety cap
//     pageSize:    500,                     // rows per REST call
//   }

import { ServiceNowClient } from './api.js'

const DEFAULT_TABLES = [
  'cmdb_ci_server',
  'cmdb_ci_database',
  'cmdb_ci_cloud_resource_base',
  'cmdb_ci_business_app',
]

// Columns we actually use downstream. Requesting an explicit whitelist keeps
// payloads small and decouples ingest from whatever custom columns a given
// tenant has added to CMDB tables.
const CI_FIELDS = [
  'sys_id',
  'sys_class_name',
  'name',
  'short_description',
  'operational_status',
  'install_status',
  'environment',
  'owned_by',
  'support_group',
  'ip_address',
  'fqdn',
  'cloud_id',
  'sys_updated_on',
]

const DEFAULT_MAX_PER_TABLE = 10000
const DEFAULT_PAGE_SIZE     = 500

// ── JSON Schema ─────────────────────────────────────────────────────────────
const authSchema = {
  type: 'object',
  required: ['instance', 'username', 'password'],
  properties: {
    instance:    { type: 'string' },
    username:    { type: 'string' },
    password:    { type: 'string' },
    tables:      { type: 'array',   items: { type: 'string' }, default: DEFAULT_TABLES },
    maxPerTable: { type: 'integer', minimum: 1, maximum: 1000000, default: DEFAULT_MAX_PER_TABLE },
    pageSize:    { type: 'integer', minimum: 1, maximum: 2000,    default: DEFAULT_PAGE_SIZE },
  },
}

// ── Connector hooks ─────────────────────────────────────────────────────────
async function healthCheck(cfg) {
  try {
    const client = new ServiceNowClient(cfg)
    await client.ping()
    const host = cfg.instance.includes('.') ? cfg.instance : `${cfg.instance}.service-now.com`
    return { ok: true, detail: `reachable at ${host}` }
  } catch (err) {
    return { ok: false, detail: err.message }
  }
}

/**
 * Yields one batch per page per configured table. Each batch carries its
 * table name so normalize() can attribute the rows.
 */
async function* fetch(cfg, ctx) {
  const tables = cfg.tables?.length ? cfg.tables : DEFAULT_TABLES
  const client = new ServiceNowClient({ ...cfg, signal: ctx?.signal })

  ctx?.log?.info?.(`[servicenow] scanning ${tables.length} table(s) at ${cfg.instance}`)

  for (const table of tables) {
    if (ctx?.signal?.aborted) return
    let pageCount = 0
    try {
      for await (const rows of client.listCis(table, {
        fields:   CI_FIELDS,
        pageSize: cfg.pageSize || DEFAULT_PAGE_SIZE,
        max:      cfg.maxPerTable || DEFAULT_MAX_PER_TABLE,
      })) {
        pageCount++
        yield { table, rows }
        if (ctx?.signal?.aborted) return
      }
      ctx?.log?.info?.(`[servicenow] ${table}: ${pageCount} page(s) fetched`)
    } catch (err) {
      // Surface the failure via normalize+ingest so the sync_job row captures
      // it, but don't abort the whole scan — other tables may still succeed.
      yield { table, rows: [], fetchError: err.message }
    }
  }
}

function normalize(raw) {
  if (raw.fetchError) {
    return {
      kind:    'cmdb-cis',
      source:  { connectorId: 'servicenow', fetchedAt: new Date().toISOString() },
      table:   raw.table,
      cis:     [],
      warning: `fetch failed for ${raw.table}: ${raw.fetchError}`,
    }
  }

  const cis = raw.rows.map(row => ({
    sys_id:             row.sys_id,
    sys_class_name:     row.sys_class_name || raw.table,
    name:               row.name || null,
    short_description:  row.short_description || null,
    operational_status: row.operational_status || null,
    install_status:     row.install_status || null,
    environment:        row.environment || null,
    owned_by:           row.owned_by || null,
    support_group:      row.support_group || null,
    ip_address:         row.ip_address || null,
    fqdn:               row.fqdn || null,
    cloud_id:           row.cloud_id || null,
    sn_updated_on:      row.sys_updated_on || null,
  })).filter(ci => ci.sys_id)

  return {
    kind:   'cmdb-cis',
    source: { connectorId: 'servicenow', fetchedAt: new Date().toISOString() },
    table:  raw.table,
    cis,
  }
}

async function ingest(normalized, ctx) {
  const warnings = []
  if (normalized.warning) warnings.push(normalized.warning)

  if (!normalized.cis.length) {
    return { resourcesFound: 0, resourcesCreated: 0, resourcesUpdated: 0, resourcesSkipped: 0, warnings }
  }

  // Split created vs updated by pre-querying which sys_ids already exist.
  // One extra round-trip per batch is acceptable for the accurate reporting
  // downstream consumers expect (sync_jobs.resources_created).
  const sysIds = normalized.cis.map(c => c.sys_id)
  let existing = new Set()
  try {
    const rows = await ctx.neo4j.query(
      'MATCH (n:CmdbCi) WHERE n.sys_id IN $ids RETURN n.sys_id AS sid',
      { ids: sysIds },
    )
    existing = new Set(rows.map(r => r.get('sid')))
  } catch (err) {
    warnings.push(`pre-existence check failed: ${err.message}`)
  }

  const now = new Date().toISOString()
  await ctx.neo4j.write(`
    UNWIND $cis AS ci
    MERGE (n:CmdbCi { sys_id: ci.sys_id })
    SET n.sys_class_name     = ci.sys_class_name,
        n.name               = ci.name,
        n.short_description  = ci.short_description,
        n.operational_status = ci.operational_status,
        n.install_status     = ci.install_status,
        n.environment        = ci.environment,
        n.owned_by           = ci.owned_by,
        n.support_group      = ci.support_group,
        n.ip_address         = ci.ip_address,
        n.fqdn               = ci.fqdn,
        n.cloud_id           = ci.cloud_id,
        n.sn_updated_on      = ci.sn_updated_on,
        n.source             = 'servicenow',
        n.lastSeenAt         = $now
  `, { cis: normalized.cis, now })

  const created = normalized.cis.filter(c => !existing.has(c.sys_id)).length
  const updated = normalized.cis.length - created

  return {
    resourcesFound:   normalized.cis.length,
    resourcesCreated: created,
    resourcesUpdated: updated,
    resourcesSkipped: 0,
    warnings,
  }
}

/** @type {import('../types.js').UiMetadata} */
const uiMetadata = {
  vendor:         'ServiceNow',
  tagline:        'Pull CMDB CIs (servers, databases, cloud resources, business apps) into the graph as :CmdbCi nodes.',
  logo:           'SN',
  color:          '#81B5A1',
  secondaryColor: '#293E40',
  badge:          'ITSM',
  capabilities: [
    'Basic-auth API',
    'Configurable CI tables',
    'sys_id-keyed idempotent MERGE',
  ],
  fields: [
    { key: 'instance', label: 'INSTANCE',   type: 'text',
      placeholder: 'mycompany',
      help: 'Just the subdomain (mycompany) or full host (mycompany.service-now.com).' },
    { key: 'username', label: 'USERNAME',   type: 'text',
      placeholder: 'integration-user' },
    { key: 'password', label: 'PASSWORD',   type: 'password',
      placeholder: '••••••••' },
    { key: 'tables',   label: 'CMDB TABLES (comma-separated)', type: 'text',
      placeholder: DEFAULT_TABLES.join(', '),
      help: 'Leave blank to scan the four defaults: servers, databases, cloud resources, business apps.' },
    { key: 'maxPerTable', label: 'MAX ROWS PER TABLE', type: 'number',
      placeholder: String(DEFAULT_MAX_PER_TABLE) },
    { key: 'pageSize',    label: 'PAGE SIZE',          type: 'number',
      placeholder: String(DEFAULT_PAGE_SIZE) },
  ],
}

/** @type {import('../types.js').ConnectorSpec} */
const spec = {
  id:          'servicenow',
  category:    'cmdb',
  displayName: 'ServiceNow CMDB',
  description: 'Pulls Configuration Items from ServiceNow CMDB tables (default: cmdb_ci_server, cmdb_ci_database, cmdb_ci_cloud_resource_base, cmdb_ci_business_app) into Neo4j as raw :CmdbCi nodes keyed on sys_id. Does not infer edges — correlation with cloud inventory is done by /cmdb/assessment.',
  authSchema,
  uiMetadata,
  healthCheck,
  fetch,
  normalize,
  ingest,
}

export default spec
