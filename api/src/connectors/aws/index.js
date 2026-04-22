// api/src/connectors/aws/index.js
//
// Connector-framework adapter for AWS. Wraps the existing scanAWS() helper
// in routes/discovery.js so the UI can use the single dynamic card path
// instead of the hardcoded "aws" entry in INTEGRATIONS[].
//
// Storage: config lives in the standard `integrations` table (not the
// legacy `cloud_accounts`). Users with existing `cloud_accounts` rows will
// re-enter credentials via the new card — the legacy UI path + table are
// untouched for backward compat.
//
// The adapter is deliberately thin: scanAWS() already writes to Neo4j
// directly via upsertInfra(), so our `ingest` is a pass-through + return
// translation to the framework's IngestResult shape.

import { scanAWS } from '../../routes/discovery.js'

const authSchema = {
  type: 'object',
  required: ['regions'],
  properties: {
    accountId:       { type: 'string' },
    regions:         { type: 'string' }, // comma-separated; normalised at scan time
    accessKeyId:     { type: 'string' },
    secretAccessKey: { type: 'string' },
    roleArn:         { type: 'string' },
  },
}

/** @type {import('../types.js').UiMetadata} */
const uiMetadata = {
  vendor:         'AWS',
  tagline:        'Discover EC2, RDS, EKS, Lambda, ELB, ElastiCache and other AWS resources.',
  logo:           'AWS',
  color:          '#FF9900',
  secondaryColor: '#FFB347',
  badge:          'Discovery',
  capabilities: [
    'EC2 / RDS / EKS / Lambda',
    'ELB v2 / ElastiCache',
    'Multi-region',
    'Assume-role (optional)',
  ],
  fields: [
    { key: 'accountId',       label: 'ACCOUNT ID (OPTIONAL)',  type: 'text',
      placeholder: '123456789012',
      help: 'Informational; used only for the AppCloud-side label.' },
    { key: 'regions',         label: 'REGIONS (comma-separated)', type: 'text',
      placeholder: 'us-east-1, us-west-2' },
    { key: 'accessKeyId',     label: 'ACCESS KEY ID',          type: 'text',
      placeholder: 'AKIA…',
      help: 'Leave blank to fall back to the API pod\'s default credential chain.' },
    { key: 'secretAccessKey', label: 'SECRET ACCESS KEY',      type: 'password',
      placeholder: '••••••••' },
    { key: 'roleArn',         label: 'IAM ROLE ARN (OPTIONAL — reserved)', type: 'text',
      placeholder: 'arn:aws:iam::…',
      help: 'Not yet wired into scanAWS; reserved for a future assume-role step.' },
  ],
}

async function healthCheck(cfg) {
  if (!cfg.regions || !String(cfg.regions).trim()) {
    return { ok: false, detail: 'at least one region is required' }
  }
  // A dry-run would require booting an SDK client; keep it cheap — the
  // UI's Scan button exercises real creds + reports result.
  return { ok: true, detail: 'config looks valid — use Scan to exercise credentials' }
}

async function* fetch(cfg) {
  yield cfg
}

function normalize(raw) {
  return { kind: 'aws-scan', config: raw }
}

function parseRegions(regions) {
  if (Array.isArray(regions)) return regions
  return String(regions || '').split(',').map(s => s.trim()).filter(Boolean)
}

async function ingest({ config }, ctx) {
  const regions = parseRegions(config.regions)
  if (!regions.length) {
    return { resourcesFound: 0, resourcesCreated: 0, resourcesUpdated: 0, resourcesSkipped: 0,
             warnings: ['no regions specified'] }
  }

  const credentials = config.accessKeyId && config.secretAccessKey
    ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
    : null

  const r = await scanAWS({
    credentials,
    regions,
    write:     ctx.neo4j.write,
    log:       ctx.log,
    scanEpoch: Date.now(),
  })

  // scanAWS returns per-service counts; collapse them into the framework's
  // IngestResult shape. It doesn't distinguish created vs updated so all
  // land under `resourcesFound`.
  const numericTotal =
    (r.ec2 || 0) + (r.rds || 0) + (r.lambda || 0) + (r.eks || 0) +
    (r.ecs || 0) + (r.alb || 0) + (r.elasticache || 0)

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
  id:          'aws',
  category:    'cloud',
  displayName: 'Amazon Web Services',
  description: 'Discovers AWS compute, database, container and load-balancer resources via provider SDKs.',
  authSchema,
  uiMetadata,
  healthCheck,
  fetch,
  normalize,
  ingest,
}

export default spec
