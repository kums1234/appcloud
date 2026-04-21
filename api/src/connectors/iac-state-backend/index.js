// api/src/connectors/iac-state-backend/index.js
//
// Connector: pulls Terraform / OpenTofu state files from a remote backend
// (S3, Azure Blob, GCS, or Consul) and ingests the resources via the shared
// IaC ingester.
//
// Terraform and OpenTofu share the wire format for state; the `engine`
// config field is metadata-only and is propagated onto the :Infra nodes via
// parseTerraformState's iacEngine option.
//
// Backend-specific SDK packages are imported lazily so the API still boots
// when they aren't installed — the connector just fails at fetch time with a
// clear error.

import { parseTerraformState } from '../../utils/terraform-state-parser.js'
import { ingestIacResources }  from '../../utils/iac-ingest.js'

import * as s3Backend        from './backends/s3.js'
import * as azureBlobBackend from './backends/azure-blob.js'
import * as gcsBackend       from './backends/gcs.js'
import * as consulBackend    from './backends/consul.js'

const BACKENDS = {
  's3':          s3Backend,
  'azure-blob':  azureBlobBackend,
  'gcs':         gcsBackend,
  'consul':      consulBackend,
}

function pickBackend(cfg) {
  const impl = BACKENDS[cfg?.backend]
  if (!impl) {
    const known = Object.keys(BACKENDS).join(', ')
    throw new Error(`unknown backend: ${cfg?.backend} (supported: ${known})`)
  }
  return impl
}

// ── JSON Schemas ────────────────────────────────────────────────────────────
// Expressed permissively — the ConnectorSpec only enforces `required`. Per-
// backend uniqueness is enforced at fetch time (listStateFiles throws).

const authSchema = {
  type: 'object',
  required: ['backend', 'engine'],
  properties: {
    backend: { type: 'string', enum: ['s3', 'azure-blob', 'gcs', 'consul'] },
    engine:  { type: 'string', enum: ['terraform', 'opentofu'], default: 'terraform' },
    // S3
    region:          { type: 'string' },
    bucket:          { type: 'string' },
    prefix:          { type: 'string' },
    key:             { type: 'string' },
    awsAccessKeyId:  { type: 'string' },
    secretAccessKey: { type: 'string' },
    roleArn:         { type: 'string' },
    // Azure Blob
    accountName:       { type: 'string' },
    container:         { type: 'string' },
    blob:              { type: 'string' },
    storageAccountKey: { type: 'string' },
    sasToken:          { type: 'string' },
    // GCS
    object:             { type: 'string' },
    serviceAccountJson: { type: 'string' },
    projectId:          { type: 'string' },
    // Consul
    address:     { type: 'string' },
    path:        { type: 'string' },
    recurse:     { type: 'boolean' },
    consulToken: { type: 'string' },
    scheme:      { type: 'string' },
    datacenter:  { type: 'string' },
  },
}

// ── Connector hooks ─────────────────────────────────────────────────────────
async function healthCheck(cfg) {
  const backend = pickBackend(cfg)
  return backend.healthCheck(cfg)
}

/**
 * Yields one batch per state file. Framework's runPullScan iterates these
 * and calls normalize + ingest per batch, so partial failures (one broken
 * state file) don't stop the rest.
 */
async function* fetch(cfg, ctx) {
  const backend = pickBackend(cfg)

  for await (const ref of backend.listStateFiles(cfg)) {
    if (ctx?.signal?.aborted) return
    try {
      const stateJson = await backend.fetchStateFile(cfg, ref.key)
      yield { cfg, ref, stateJson }
    } catch (err) {
      ctx?.log?.warn?.(`[iac-state-backend] fetch ${ref.key}: ${err.message}`)
      yield { cfg, ref, fetchError: err.message }
    }
  }
}

function normalize(raw, cfg) {
  if (raw.fetchError) {
    return {
      kind: 'iac',
      source: makeSource(raw),
      resources: [],
      parsed: { version: null, workspace: raw.ref.workspaceId, errors: [`fetch: ${raw.fetchError}`] },
    }
  }

  const { resources, errors, version, workspace } = parseTerraformState(raw.stateJson, {
    iacEngine:   cfg.engine || 'terraform',
    workspaceId: raw.ref.workspaceId,
  })

  return {
    kind: 'iac',
    source: makeSource(raw),
    resources,
    parsed: { version, workspace, errors },
  }
}

async function ingest(normalized, ctx) {
  const source = `iac-state-backend:${normalized.source.scope.type}`
  const result = await ingestIacResources(ctx.neo4j, normalized.resources, {
    source,
    integrationId: ctx.integrationId,
    log:           ctx.log,
  })

  // Merge parse-time errors into the framework-level warning stream so the
  // /scan response surfaces them without mutating the ingest helper.
  if (normalized.parsed?.errors?.length) {
    result.warnings.push(
      ...normalized.parsed.errors.map(e => `parse (${normalized.source.scope.id}): ${e}`),
    )
  }
  return result
}

function makeSource(raw) {
  return {
    connectorId: 'iac-state-backend',
    fetchedAt:   new Date().toISOString(),
    scope:       { type: raw.cfg.backend, id: raw.ref.key },
  }
}

/** @type {import('../types.js').ConnectorSpec} */
const spec = {
  id:          'iac-state-backend',
  category:    'iac',
  displayName: 'Terraform / OpenTofu — Remote State',
  description: 'Polls state files from a remote backend (S3, Azure Blob, GCS, Consul) and ingests resources into the AppCloud graph. Works with both Terraform and OpenTofu — state format is wire-compatible.',
  authSchema,
  healthCheck,
  fetch,
  normalize,
  ingest,
}

export default spec
