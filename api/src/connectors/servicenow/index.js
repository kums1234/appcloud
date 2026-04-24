// api/src/connectors/servicenow/index.js
//
// Pull-only ServiceNow CMDB connector. Two responsibilities:
//
//   1. Ingest CI rows from configured CMDB tables as :CmdbCi nodes keyed
//      on sys_id (raw, no inference).
//   2. Ingest ServiceNow's own CI→CI relationships from cmdb_rel_ci as
//      :CONNECTS_TO / :DEPLOYED_ON edges between :CmdbCi nodes with
//      source='servicenow-cmdb-rel'. The original ServiceNow relation
//      label ("Hosted on", "Depends on", …) is preserved as the `relType`
//      property.
//
// This connector intentionally does NOT cross-link to :Infra — that is
// the job of the /cmdb/assessment engine in services/cmdb-assessment.
//
// Config shape:
//   {
//     instance:      'mycompany' | 'mycompany.service-now.com',
//     username:      'api-user',
//     password:      '…',                    // encrypted at rest (SECRET_FIELDS)
//     tables:        ['cmdb_ci_server', …],  // optional; defaults below
//     maxPerTable:   10000,                  // safety cap
//     pageSize:      500,                    // rows per REST call
//     pullRelations: true,                   // include cmdb_rel_ci? (default true)
//     maxRelations:  100000,                 // safety cap for cmdb_rel_ci
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
const DEFAULT_MAX_RELATIONS = 100000

// ServiceNow relation-type display names → AppCloud edge labels.
// Anything not listed falls through to :CONNECTS_TO (the more permissive
// of the two existing edge types, consistent with CLAUDE.md's rule that
// CONNECTS_TO is "a relationship inferred between resources").
const REL_TYPE_TO_EDGE = {
  'Hosted on::Hosts':             'DEPLOYED_ON',
  'Runs on::Runs':                'DEPLOYED_ON',
  'Virtualised by::Virtualises':  'DEPLOYED_ON',
  'Virtualized by::Virtualizes':  'DEPLOYED_ON',
  'Installed on::Installs':       'DEPLOYED_ON',
  'Depends on::Used by':          'CONNECTS_TO',
  'Uses::Used by':                'CONNECTS_TO',
  'Provides::Receives':           'CONNECTS_TO',
  'Receives data from::Sends data to': 'CONNECTS_TO',
  'Connected to::Connected by':   'CONNECTS_TO',
}

// ── JSON Schema ─────────────────────────────────────────────────────────────
const authSchema = {
  type: 'object',
  required: ['instance', 'username', 'password'],
  properties: {
    instance:      { type: 'string' },
    username:      { type: 'string' },
    password:      { type: 'string' },
    tables:        { type: 'array',   items: { type: 'string' }, default: DEFAULT_TABLES },
    maxPerTable:   { type: 'integer', minimum: 1, maximum: 1000000, default: DEFAULT_MAX_PER_TABLE },
    pageSize:      { type: 'integer', minimum: 1, maximum: 2000,    default: DEFAULT_PAGE_SIZE },
    pullRelations: { type: 'boolean', default: true },
    maxRelations:  { type: 'integer', minimum: 1, maximum: 10000000, default: DEFAULT_MAX_RELATIONS },
  },
}

// Map the display_value on cmdb_rel_ci.type — which comes back as a
// parent/child pair "Hosted on::Hosts" — to our edge type. Exported for
// tests + downstream observability.
export function mapRelToEdge(displayName) {
  if (!displayName) return { edge: 'CONNECTS_TO', relType: 'Unknown' }
  const edge = REL_TYPE_TO_EDGE[displayName] || 'CONNECTS_TO'
  // Preserve the forward-direction label ("Depends on" from "Depends on::Used by").
  const relType = displayName.split('::')[0] || displayName
  return { edge, relType }
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
 * Yields batches from two sources:
 *   1. One batch per page per configured CI table.
 *   2. One batch per page of cmdb_rel_ci (relationships) when pullRelations
 *      is enabled.
 * Batch shape carries a `kind` discriminator consumed by normalize().
 */
async function* fetch(cfg, ctx) {
  const tables = cfg.tables?.length ? cfg.tables : DEFAULT_TABLES
  const client = new ServiceNowClient({ ...cfg, signal: ctx?.signal })

  ctx?.log?.info?.(`[servicenow] scanning ${tables.length} CI table(s) at ${cfg.instance}`)

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
        yield { kind: 'cis', table, rows }
        if (ctx?.signal?.aborted) return
      }
      ctx?.log?.info?.(`[servicenow] ${table}: ${pageCount} page(s) fetched`)
    } catch (err) {
      // Surface the failure via normalize+ingest so the sync_job row captures
      // it, but don't abort the whole scan — other tables may still succeed.
      yield { kind: 'cis', table, rows: [], fetchError: err.message }
    }
  }

  if (cfg.pullRelations !== false) {
    if (ctx?.signal?.aborted) return
    ctx?.log?.info?.(`[servicenow] scanning cmdb_rel_ci at ${cfg.instance}`)
    let pageCount = 0
    try {
      for await (const rows of client.listRelations({
        pageSize: cfg.pageSize || DEFAULT_PAGE_SIZE,
        max:      cfg.maxRelations || DEFAULT_MAX_RELATIONS,
      })) {
        pageCount++
        yield { kind: 'rels', rows }
        if (ctx?.signal?.aborted) return
      }
      ctx?.log?.info?.(`[servicenow] cmdb_rel_ci: ${pageCount} page(s) fetched`)
    } catch (err) {
      yield { kind: 'rels', rows: [], fetchError: err.message }
    }
  }
}

function normalize(raw) {
  const fetchedAt = new Date().toISOString()
  const source    = { connectorId: 'servicenow', fetchedAt }

  if (raw.kind === 'rels') {
    if (raw.fetchError) {
      return {
        kind:    'cmdb-rels',
        source,
        rels:    [],
        warning: `fetch failed for cmdb_rel_ci: ${raw.fetchError}`,
      }
    }
    // cmdb_rel_ci row shape when sysparm_display_value=all:
    //   sys_id:         { value, display_value }
    //   parent:         { value, display_value }
    //   child:          { value, display_value }
    //   type:           { value, display_value }   // e.g. "Hosted on::Hosts"
    //   sys_updated_on: { value, display_value }
    // `value` is the raw string/sys_id; `display_value` is the human label.
    const v = (col) => (col == null) ? null : (typeof col === 'object' ? col.value : col)
    const dv = (col) => (col == null) ? null : (typeof col === 'object' ? col.display_value : col)

    const rels = raw.rows.map(row => {
      const parentId = v(row.parent)
      const childId  = v(row.child)
      if (!parentId || !childId) return null
      const { edge, relType } = mapRelToEdge(dv(row.type))
      return {
        rel_sys_id: v(row.sys_id),
        parent:     parentId,
        child:      childId,
        edge,                                   // 'CONNECTS_TO' | 'DEPLOYED_ON'
        relType,                                // e.g. 'Depends on'
        relTypeRaw: dv(row.type) || null,
        updatedOn:  v(row.sys_updated_on) || null,
      }
    }).filter(Boolean)

    return { kind: 'cmdb-rels', source, rels }
  }

  // Default / explicit 'cis' kind
  if (raw.fetchError) {
    return {
      kind:    'cmdb-cis',
      source,
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

  return { kind: 'cmdb-cis', source, table: raw.table, cis }
}

async function ingest(normalized, ctx) {
  if (normalized.kind === 'cmdb-rels') return ingestRels(normalized, ctx)
  return ingestCis(normalized, ctx)
}

async function ingestCis(normalized, ctx) {
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

// ── cmdb_rel_ci → :CONNECTS_TO / :DEPLOYED_ON edges between :CmdbCi nodes
//
// We do a separate batch per edge label so the Cypher query can use a
// literal relationship type (Neo4j doesn't support variable rel types in
// MERGE without APOC). For each group, we pre-materialise the CI stubs
// with MERGE on sys_id so dangling parent/child references don't fail the
// write — they get upgraded later by a CI-table scan.
async function ingestRels(normalized, ctx) {
  const warnings = []
  if (normalized.warning) warnings.push(normalized.warning)

  if (!normalized.rels.length) {
    return { resourcesFound: 0, resourcesCreated: 0, resourcesUpdated: 0, resourcesSkipped: 0, edgesCreated: 0, warnings }
  }

  const now = new Date().toISOString()
  let edgesCreated = 0
  let edgesUpdated = 0
  const byEdge = { CONNECTS_TO: [], DEPLOYED_ON: [] }
  for (const r of normalized.rels) byEdge[r.edge].push(r)

  for (const [edgeLabel, group] of Object.entries(byEdge)) {
    if (!group.length) continue
    // Count existing edges with this source tag so we can split created/updated.
    let existingCount = 0
    try {
      const rows = await ctx.neo4j.query(
        `UNWIND $rels AS r
         MATCH (p:CmdbCi { sys_id: r.parent })-[e:${edgeLabel}]->(c:CmdbCi { sys_id: r.child })
         WHERE e.source = 'servicenow-cmdb-rel' AND e.relSysId = r.rel_sys_id
         RETURN count(e) AS n`,
        { rels: group },
      )
      existingCount = rows[0]?.get?.('n')?.toNumber?.() ?? Number(rows[0]?.get?.('n') ?? 0)
    } catch (err) {
      warnings.push(`rel pre-count (${edgeLabel}) failed: ${err.message}`)
    }

    try {
      await ctx.neo4j.write(
        `UNWIND $rels AS r
         MERGE (p:CmdbCi { sys_id: r.parent })
         MERGE (c:CmdbCi { sys_id: r.child })
         MERGE (p)-[e:${edgeLabel} { relSysId: r.rel_sys_id }]->(c)
         ON CREATE SET
           e.source     = 'servicenow-cmdb-rel',
           e.relType    = r.relType,
           e.relTypeRaw = r.relTypeRaw,
           e.confidence = 85,
           e.evidence   = 'ServiceNow cmdb_rel_ci ' + r.rel_sys_id + ': ' + r.relType,
           e.createdAt  = $now
         SET
           e.relType    = r.relType,
           e.relTypeRaw = r.relTypeRaw,
           e.lastSeenAt = $now,
           e.snUpdatedOn = r.updatedOn`,
        { rels: group, now },
      )
    } catch (err) {
      warnings.push(`rel ingest (${edgeLabel}) failed: ${err.message}`)
      continue
    }

    edgesCreated += Math.max(0, group.length - existingCount)
    edgesUpdated += existingCount
  }

  return {
    resourcesFound:   0,
    resourcesCreated: 0,
    resourcesUpdated: 0,
    resourcesSkipped: 0,
    edgesCreated,
    edgesUpdated,
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
    'cmdb_rel_ci → :CONNECTS_TO / :DEPLOYED_ON',
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
    { key: 'pullRelations', label: 'INGEST CMDB RELATIONSHIPS', type: 'boolean',
      help: 'Pull cmdb_rel_ci rows as graph edges between :CmdbCi nodes.' },
    { key: 'maxPerTable',  label: 'MAX ROWS PER TABLE',     type: 'number',
      placeholder: String(DEFAULT_MAX_PER_TABLE) },
    { key: 'maxRelations', label: 'MAX RELATIONSHIP ROWS',  type: 'number',
      placeholder: String(DEFAULT_MAX_RELATIONS) },
    { key: 'pageSize',     label: 'PAGE SIZE',              type: 'number',
      placeholder: String(DEFAULT_PAGE_SIZE) },
  ],
}

/** @type {import('../types.js').ConnectorSpec} */
const spec = {
  id:          'servicenow',
  category:    'cmdb',
  displayName: 'ServiceNow CMDB',
  description: 'Pulls Configuration Items from ServiceNow CMDB tables (default: cmdb_ci_server, cmdb_ci_database, cmdb_ci_cloud_resource_base, cmdb_ci_business_app) into Neo4j as :CmdbCi nodes keyed on sys_id, and cmdb_rel_ci rows as :CONNECTS_TO / :DEPLOYED_ON edges between those nodes (source=servicenow-cmdb-rel, confidence=85). Correlation to :Infra is done by /cmdb/assessment.',
  authSchema,
  uiMetadata,
  healthCheck,
  fetch,
  normalize,
  ingest,
}

export default spec
