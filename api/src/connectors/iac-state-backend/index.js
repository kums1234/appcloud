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

/** @type {import('../types.js').UiMetadata} */
const uiMetadata = {
  vendor:         'HashiCorp / OpenTofu',
  tagline:        'Poll remote state from S3, Azure Blob, GCS, or Consul and ingest resources into the graph.',
  logo:           'TF/OT',
  color:          '#7B42BC',
  secondaryColor: '#9F68D4',
  badge:          'Discovery',
  capabilities: [
    'Terraform + OpenTofu',
    'S3 / Azure Blob / GCS / Consul',
    'Multi-file scan',
    'Infra MERGE',
  ],
  fields: [
    { key: 'engine',  label: 'ENGINE',  type: 'select',
      options: ['terraform', 'opentofu'],
      help: 'State format is wire-compatible; this is display-only metadata.' },
    { key: 'backend', label: 'BACKEND', type: 'select',
      options: ['s3', 'azure-blob', 'gcs', 'consul'] },

    // ── S3 ──
    { key: 'region',          label: 'AWS REGION',            type: 'text',
      placeholder: 'us-east-1',                        visibleWhen: { backend: 's3' } },
    { key: 'bucket',          label: 'S3 BUCKET',             type: 'text',
      placeholder: 'my-tf-state',                      visibleWhen: { backend: 's3' } },
    { key: 'prefix',          label: 'KEY PREFIX (OPTIONAL)', type: 'text',
      placeholder: 'env/prod/',                        visibleWhen: { backend: 's3' } },
    { key: 'key',             label: 'SPECIFIC KEY (OPTIONAL)', type: 'text',
      placeholder: 'env/prod/terraform.tfstate',       visibleWhen: { backend: 's3' } },
    { key: 'awsAccessKeyId',  label: 'AWS ACCESS KEY ID',     type: 'text',
      placeholder: 'AKIA…',                            visibleWhen: { backend: 's3' } },
    { key: 'secretAccessKey', label: 'AWS SECRET ACCESS KEY', type: 'password',
      placeholder: '••••••••',                         visibleWhen: { backend: 's3' } },
    { key: 'roleArn',         label: 'IAM ROLE ARN (OPTIONAL)', type: 'text',
      placeholder: 'arn:aws:iam::…',                   visibleWhen: { backend: 's3' } },

    // ── Azure Blob ──
    { key: 'accountName',       label: 'STORAGE ACCOUNT NAME',     type: 'text',
      placeholder: 'mystorageacct',                    visibleWhen: { backend: 'azure-blob' } },
    { key: 'container',         label: 'CONTAINER',                type: 'text',
      placeholder: 'tfstate',                          visibleWhen: { backend: 'azure-blob' } },
    { key: 'prefix',            label: 'BLOB PREFIX (OPTIONAL)',   type: 'text',
      placeholder: 'prod/',                            visibleWhen: { backend: 'azure-blob' } },
    { key: 'blob',              label: 'SPECIFIC BLOB (OPTIONAL)', type: 'text',
      placeholder: 'prod/terraform.tfstate',           visibleWhen: { backend: 'azure-blob' } },
    { key: 'storageAccountKey', label: 'STORAGE ACCOUNT KEY',      type: 'password',
      placeholder: '••••••••',                         visibleWhen: { backend: 'azure-blob' } },
    { key: 'sasToken',          label: 'OR SAS TOKEN',             type: 'password',
      placeholder: '?sv=…',                            visibleWhen: { backend: 'azure-blob' } },

    // ── GCS ──
    { key: 'projectId',          label: 'GCP PROJECT ID (OPTIONAL)',  type: 'text',
      placeholder: 'my-project',                       visibleWhen: { backend: 'gcs' } },
    { key: 'bucket',             label: 'GCS BUCKET',                 type: 'text',
      placeholder: 'my-tf-state',                      visibleWhen: { backend: 'gcs' } },
    { key: 'prefix',             label: 'OBJECT PREFIX (OPTIONAL)',   type: 'text',
      placeholder: 'env/prod/',                        visibleWhen: { backend: 'gcs' } },
    { key: 'object',             label: 'SPECIFIC OBJECT (OPTIONAL)', type: 'text',
      placeholder: 'env/prod/default.tfstate',         visibleWhen: { backend: 'gcs' } },
    { key: 'serviceAccountJson', label: 'SERVICE ACCOUNT JSON',       type: 'textarea',
      placeholder: '{ "type": "service_account", … }', visibleWhen: { backend: 'gcs' } },

    // ── Consul ──
    { key: 'address',     label: 'CONSUL ADDRESS',    type: 'text',
      placeholder: 'https://consul.example.com:8500', visibleWhen: { backend: 'consul' } },
    { key: 'path',        label: 'KV PATH',           type: 'text',
      placeholder: 'terraform/prod/state',            visibleWhen: { backend: 'consul' } },
    { key: 'recurse',     label: 'RECURSIVE (prefix scan)', type: 'boolean',
                                                      visibleWhen: { backend: 'consul' } },
    { key: 'datacenter',  label: 'DATACENTER (OPTIONAL)',   type: 'text',
      placeholder: 'dc1',                             visibleWhen: { backend: 'consul' } },
    { key: 'consulToken', label: 'ACL TOKEN',               type: 'password',
      placeholder: '••••••••',                        visibleWhen: { backend: 'consul' } },
  ],
}

/** @type {import('../types.js').ConnectorSpec} */
const spec = {
  id:          'iac-state-backend',
  category:    'iac',
  displayName: 'Terraform / OpenTofu — Remote State',
  description: 'Polls state files from a remote backend (S3, Azure Blob, GCS, Consul) and ingests resources into the AppCloud graph. Works with both Terraform and OpenTofu — state format is wire-compatible.',
  authSchema,
  uiMetadata,
  healthCheck,
  fetch,
  normalize,
  ingest,
}

export default spec
