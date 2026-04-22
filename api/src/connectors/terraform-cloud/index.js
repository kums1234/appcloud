// api/src/connectors/terraform-cloud/index.js
//
// Connector: pulls state from Terraform Cloud (app.terraform.io) or a
// self-hosted Terraform Enterprise (TFE) install. Both speak the same API.
// OpenTofu does not (yet) ship an equivalent orchestrator; this connector
// is Terraform-only.
//
// Config shape:
//   {
//     hostname:      'app.terraform.io' | 'tfe.example.com',   // default: app.terraform.io
//     organization:  'my-org',
//     // ── Workspace selection — mutually exclusive, first non-empty wins ──
//     workspaceIds:        ['ws-aBc…'],      // explicit ids
//     workspaceTags:       ['prod', 'web'],  // tag filter
//     workspaceNamePrefix: 'prod-',          // name prefix
//     // ── Auth ──
//     apiToken:      '…',                    // encrypted at rest (SECRET_FIELDS)
//     // ── Scan scope ──
//     maxWorkspaces: 200,                    // safety cap when listing
//   }

import { parseTerraformState } from '../../utils/terraform-state-parser.js'
import { ingestIacResources }  from '../../utils/iac-ingest.js'
import { TfcClient, extractRemoteStateRefs } from './api.js'

const DEFAULT_HOSTNAME   = 'app.terraform.io'
const DEFAULT_MAX_WS     = 200

// ── JSON Schema ─────────────────────────────────────────────────────────────
const authSchema = {
  type: 'object',
  required: ['organization', 'apiToken'],
  properties: {
    hostname:            { type: 'string', default: DEFAULT_HOSTNAME },
    organization:        { type: 'string' },
    apiToken:            { type: 'string' },
    workspaceIds:        { type: 'array',  items: { type: 'string' } },
    workspaceTags:       { type: 'array',  items: { type: 'string' } },
    workspaceNamePrefix: { type: 'string' },
    maxWorkspaces:       { type: 'integer', minimum: 1, maximum: 2000, default: DEFAULT_MAX_WS },
  },
}

// ── Workspace resolution ────────────────────────────────────────────────────
async function resolveWorkspaces(client, cfg, ctx) {
  if (cfg.workspaceIds?.length) {
    return client.getWorkspacesById(cfg.workspaceIds)
  }
  const filter = {
    tags:       cfg.workspaceTags,
    namePrefix: cfg.workspaceNamePrefix,
  }
  const out = []
  const cap = Math.max(1, Math.min(cfg.maxWorkspaces ?? DEFAULT_MAX_WS, 2000))
  for await (const ws of client.listWorkspaces({ organization: cfg.organization, filter })) {
    if (ctx?.signal?.aborted) break
    out.push(ws)
    if (out.length >= cap) break
  }
  return out
}

// ── Connector hooks ─────────────────────────────────────────────────────────
async function healthCheck(cfg) {
  try {
    const client = new TfcClient({ hostname: cfg.hostname, apiToken: cfg.apiToken })
    await client.ping(cfg.organization)
    return { ok: true, detail: `org ${cfg.organization} reachable at ${cfg.hostname || DEFAULT_HOSTNAME}` }
  } catch (err) {
    return { ok: false, detail: err.message }
  }
}

/**
 * Yields one batch per workspace. Each batch carries the workspace metadata
 * and the downloaded state JSON (or a fetch error if the download failed).
 */
async function* fetch(cfg, ctx) {
  const client = new TfcClient({
    hostname: cfg.hostname,
    apiToken: cfg.apiToken,
    signal:   ctx?.signal,
  })

  const workspaces = await resolveWorkspaces(client, cfg, ctx)
  ctx?.log?.info?.(`[terraform-cloud] ${workspaces.length} workspace(s) to scan in ${cfg.organization}`)

  for (const ws of workspaces) {
    if (ctx?.signal?.aborted) return

    let sv, stateJson, runs, fetchError
    try {
      sv = await client.getCurrentStateVersion(ws.id)
      if (!sv.downloadUrl) {
        fetchError = 'workspace has no current state version'
      } else {
        stateJson = await client.downloadStateJson(sv.downloadUrl)
      }
      // Best-effort — attribution metadata, not critical
      runs = await client.getRecentRuns(ws.id, { limit: 3 }).catch(() => [])
    } catch (err) {
      fetchError = err.message
    }

    yield { cfg, ws, sv, stateJson, runs, fetchError }
  }
}

function normalize(raw, cfg) {
  const source = {
    connectorId: 'terraform-cloud',
    fetchedAt:   new Date().toISOString(),
    scope:       { type: 'tfc-workspace', id: `${cfg.organization}/${raw.ws.name}` },
  }

  if (raw.fetchError || !raw.stateJson) {
    return {
      kind: 'iac',
      source,
      resources: [],
      workspace: raw.ws,
      crossWorkspaceRefs: [],
      parsed: { errors: [raw.fetchError || 'no state'] },
    }
  }

  const { resources, errors, version } = parseTerraformState(raw.stateJson, {
    iacEngine:   'terraform',
    workspaceId: raw.ws.name,   // human-readable rather than the ws-XXXX id
  })

  const crossRefs = extractRemoteStateRefs(raw.stateJson).map(ref => ({
    fromWorkspaceName: raw.ws.name,
    ...ref,
  }))

  return {
    kind: 'iac',
    source,
    resources,
    workspace: raw.ws,
    crossWorkspaceRefs: crossRefs,
    parsed: { version, errors },
  }
}

async function ingest(normalized, ctx) {
  const result = await ingestIacResources(ctx.neo4j, normalized.resources, {
    source:        `terraform-cloud:${normalized.source.scope.id}`,
    integrationId: ctx.integrationId,
    log:           ctx.log,
  })

  // Surface cross-workspace refs as warnings for now. Commit 6 will upgrade
  // these into graph edges once the Component-boundary mapping lands.
  if (normalized.crossWorkspaceRefs?.length) {
    result.warnings.push(
      ...normalized.crossWorkspaceRefs.map(r =>
        `cross-workspace ref: ${r.fromWorkspaceName} → ${r.toWorkspaceName || r.toWorkspacePrefix || '?'} (${r.backend})`,
      ),
    )
  }
  if (normalized.parsed?.errors?.length) {
    result.warnings.push(
      ...normalized.parsed.errors.map(e => `parse (${normalized.source.scope.id}): ${e}`),
    )
  }
  return result
}

/** @type {import('../types.js').UiMetadata} */
const uiMetadata = {
  vendor:         'HashiCorp',
  tagline:        'Poll state versions from Terraform Cloud or Enterprise, scoped by workspace IDs, tags, or name prefix.',
  logo:           'TFC',
  color:          '#5C4EE5',
  secondaryColor: '#7B70F0',
  badge:          'Discovery',
  capabilities: [
    'Workspace state import',
    'Tag / prefix filters',
    'Cross-workspace refs',
    'Recent runs',
  ],
  fields: [
    { key: 'hostname',            label: 'HOSTNAME',               type: 'text',
      placeholder: 'app.terraform.io',
      help: 'For Terraform Enterprise self-hosted, e.g. tfe.example.com.' },
    { key: 'organization',        label: 'ORGANIZATION',           type: 'text',
      placeholder: 'my-org' },
    { key: 'apiToken',            label: 'API TOKEN',              type: 'password',
      placeholder: 'xxxxxx.atlasv1.yyyyyy' },
    { key: 'workspaceNamePrefix', label: 'WORKSPACE NAME PREFIX',  type: 'text',
      placeholder: 'prod-',
      help: 'Scope scan to workspaces whose names start with this prefix (optional).' },
    { key: 'workspaceTags',       label: 'WORKSPACE TAGS (comma-separated)', type: 'text',
      placeholder: 'prod, web',
      help: 'Scope scan to workspaces with all listed tags (optional).' },
    { key: 'maxWorkspaces',       label: 'MAX WORKSPACES TO SCAN', type: 'number',
      placeholder: '200' },
  ],
}

/** @type {import('../types.js').ConnectorSpec} */
const spec = {
  id:          'terraform-cloud',
  category:    'iac',
  displayName: 'Terraform Cloud / Enterprise',
  description: 'Polls state versions from Terraform Cloud (app.terraform.io) or a self-hosted Terraform Enterprise. Supports explicit workspace IDs, tag filters, or name-prefix filters; extracts cross-workspace terraform_remote_state references as provenance.',
  authSchema,
  uiMetadata,
  healthCheck,
  fetch,
  normalize,
  ingest,
}

export default spec
