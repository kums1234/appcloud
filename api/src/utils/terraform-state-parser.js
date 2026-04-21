// api/src/utils/terraform-state-parser.js
//
// Terraform / OpenTofu state-file parser. Shared by:
//   · routes/integrations.js         — legacy multipart upload endpoint
//   · connectors/iac-state-backend   — remote-state backend polling (S3/Azure/GCS/Consul)
//   · connectors/terraform-cloud     — TFC/TFE state-version download
//
// Terraform state is wire-compatible with OpenTofu state (OpenTofu forked
// pre-BSL). Both v3 (legacy, primary.attributes) and v4 (modern, instances[])
// formats are supported, as is the `terraform show -json` / `tofu show -json`
// plan output (values.root_module.resources).
//
// No framework imports here — deliberately dependency-free so unit tests can
// exercise it without booting Fastify.

// ── Terraform/OpenTofu resource type → AppCloud { provider, resourceType } ──
// Extend cautiously; each new entry surfaces resources in discovery's graph.
export const TF_RESOURCE_MAP = {
  // AWS Compute
  'aws_instance':                      { provider:'aws', resourceType:'ec2_instance' },
  'aws_lambda_function':               { provider:'aws', resourceType:'function' },
  'aws_ecs_service':                   { provider:'aws', resourceType:'ecs_service' },
  'aws_ecs_cluster':                   { provider:'aws', resourceType:'ecs_cluster' },
  'aws_eks_cluster':                   { provider:'aws', resourceType:'eks_cluster' },
  'aws_eks_node_group':                { provider:'aws', resourceType:'eks_node_group' },
  'aws_autoscaling_group':             { provider:'aws', resourceType:'autoscaling_group' },
  // AWS Database
  'aws_db_instance':                   { provider:'aws', resourceType:'rds_instance' },
  'aws_rds_cluster':                   { provider:'aws', resourceType:'rds_cluster' },
  'aws_elasticache_cluster':           { provider:'aws', resourceType:'elasticache' },
  'aws_elasticache_replication_group': { provider:'aws', resourceType:'elasticache' },
  'aws_dynamodb_table':                { provider:'aws', resourceType:'dynamodb' },
  'aws_redshift_cluster':              { provider:'aws', resourceType:'redshift' },
  // AWS Networking
  'aws_vpc':                           { provider:'aws', resourceType:'vpc' },
  'aws_subnet':                        { provider:'aws', resourceType:'subnet' },
  'aws_security_group':                { provider:'aws', resourceType:'security_group' },
  'aws_lb':                            { provider:'aws', resourceType:'load_balancer' },
  'aws_alb':                           { provider:'aws', resourceType:'load_balancer' },
  'aws_cloudfront_distribution':       { provider:'aws', resourceType:'cdn' },
  'aws_api_gateway_rest_api':          { provider:'aws', resourceType:'api_gateway' },
  'aws_api_gateway_v2_api':            { provider:'aws', resourceType:'api_gateway' },
  // AWS Storage & Messaging
  'aws_s3_bucket':                     { provider:'aws', resourceType:'s3_bucket' },
  'aws_sqs_queue':                     { provider:'aws', resourceType:'sqs_queue' },
  'aws_sns_topic':                     { provider:'aws', resourceType:'sns_topic' },
  'aws_kinesis_stream':                { provider:'aws', resourceType:'kinesis' },
  'aws_msk_cluster':                   { provider:'aws', resourceType:'kafka' },
  // Azure Compute
  'azurerm_virtual_machine':           { provider:'azure', resourceType:'vm' },
  'azurerm_linux_virtual_machine':     { provider:'azure', resourceType:'vm' },
  'azurerm_windows_virtual_machine':   { provider:'azure', resourceType:'vm' },
  'azurerm_function_app':              { provider:'azure', resourceType:'function' },
  'azurerm_kubernetes_cluster':        { provider:'azure', resourceType:'aks_cluster' },
  'azurerm_app_service':               { provider:'azure', resourceType:'app_service' },
  // Azure Database
  'azurerm_sql_server':                { provider:'azure', resourceType:'sql_server' },
  'azurerm_mssql_server':              { provider:'azure', resourceType:'sql_server' },
  'azurerm_postgresql_server':         { provider:'azure', resourceType:'postgresql' },
  'azurerm_cosmosdb_account':          { provider:'azure', resourceType:'cosmosdb' },
  'azurerm_redis_cache':               { provider:'azure', resourceType:'redis' },
  // Azure Networking & Storage
  'azurerm_virtual_network':           { provider:'azure', resourceType:'vnet' },
  'azurerm_storage_account':           { provider:'azure', resourceType:'storage_account' },
  'azurerm_servicebus_namespace':      { provider:'azure', resourceType:'service_bus' },
  // GCP Compute
  'google_compute_instance':           { provider:'gcp', resourceType:'compute_instance' },
  'google_container_cluster':          { provider:'gcp', resourceType:'gke_cluster' },
  'google_cloudfunctions_function':    { provider:'gcp', resourceType:'function' },
  'google_cloud_run_service':          { provider:'gcp', resourceType:'cloud_run' },
  // GCP Database
  'google_sql_database_instance':      { provider:'gcp', resourceType:'cloud_sql' },
  'google_bigtable_instance':          { provider:'gcp', resourceType:'bigtable' },
  'google_spanner_instance':           { provider:'gcp', resourceType:'spanner' },
  'google_redis_instance':             { provider:'gcp', resourceType:'redis' },
  // GCP Networking & Storage
  'google_compute_network':            { provider:'gcp', resourceType:'vpc' },
  'google_storage_bucket':             { provider:'gcp', resourceType:'gcs_bucket' },
  'google_pubsub_topic':               { provider:'gcp', resourceType:'pubsub' },
}

// ── Helpers ─────────────────────────────────────────────────────────────────
export function extractName(tfType, tfName, attrs = {}) {
  return attrs.name
    || attrs.cluster_name
    || attrs.db_name
    || attrs.function_name
    || attrs.bucket
    || (tfName || '').replace(/_/g, '-')
}

export function extractRegion(attrs = {}) {
  return attrs.region
    || attrs.location
    || attrs.availability_zone?.replace(/[a-z]$/, '')  // strip AZ suffix → region
    || null
}

export function isPublic(tfType, attrs = {}) {
  if (attrs.publicly_accessible === true)             return true
  if (attrs.public_access_prevention === 'enforced')  return false
  if (tfType === 'aws_s3_bucket' && attrs.acl === 'public-read') return true
  if (attrs.assign_public_ip === true)                return true
  return false
}

/**
 * Parse a Terraform / OpenTofu state JSON into an array of importable
 * resources. Accepts both tfstate v3/v4 and `terraform show -json` output.
 *
 * @param {object} stateJson          parsed JSON (NOT raw text)
 * @param {object} [opts]
 * @param {string} [opts.iacEngine]   'terraform' | 'opentofu' (tag only; parsing is identical)
 * @param {string} [opts.workspaceId] override workspace identifier
 * @returns {{ resources: ParsedResource[], errors: string[], version: string, workspace: string, engine: string }}
 */
export function parseTerraformState(stateJson, opts = {}) {
  const resources = []
  const errors = []
  const engine = opts.iacEngine || 'terraform'

  if (!stateJson || typeof stateJson !== 'object') {
    errors.push('state must be a parsed JSON object')
    return { resources, errors, version: null, workspace: null, engine }
  }
  if (!stateJson.resources && !stateJson.values) {
    errors.push('Not a valid state file — missing "resources" or "values" key')
    return { resources, errors, version: null, workspace: null, engine }
  }

  const version   = stateJson.terraform_version || stateJson.format_version || 'unknown'
  const workspace = opts.workspaceId
    || (stateJson.serial ? `serial-${stateJson.serial}` : 'default')

  // tfstate (v4) keeps resources at the top level; `show -json` puts them
  // under values.root_module.resources. Modules (when present) are walked
  // recursively to capture nested resources too.
  const rawResources = []
  if (Array.isArray(stateJson.resources)) {
    rawResources.push(...stateJson.resources)
  } else if (stateJson.values?.root_module) {
    collectFromModule(stateJson.values.root_module, rawResources)
  }

  for (const res of rawResources) {
    if (res.mode === 'data')          continue
    if (!res.type || !res.name)       continue
    const mapping = TF_RESOURCE_MAP[res.type]
    if (!mapping)                     continue

    const instances = res.instances?.length
      ? res.instances
      : (res.primary ? [{ attributes: res.primary.attributes }] : [{ attributes: {} }])

    for (const inst of instances) {
      const attrs = inst.attributes || {}
      resources.push({
        terraformType: res.type,
        terraformName: res.name,
        terraformId:   attrs.id || `${res.type}.${res.name}`,
        provider:      mapping.provider,
        resourceType:  mapping.resourceType,
        name:          extractName(res.type, res.name, attrs),
        region:        extractRegion(attrs),
        public:        isPublic(res.type, attrs),
        tags:          attrs.tags || attrs.labels || {},
        rawAttrs:      attrs,
        workspaceId:   workspace,
        iacEngine:     engine,
      })
    }
  }

  return { resources, errors, version, workspace, engine }
}

function collectFromModule(mod, out) {
  if (!mod) return
  if (Array.isArray(mod.resources)) out.push(...mod.resources)
  if (Array.isArray(mod.child_modules)) {
    for (const child of mod.child_modules) collectFromModule(child, out)
  }
}

/**
 * @typedef {Object} ParsedResource
 * @property {string} terraformType
 * @property {string} terraformName
 * @property {string} terraformId
 * @property {string} provider
 * @property {string} resourceType
 * @property {string} name
 * @property {string|null} region
 * @property {boolean} public
 * @property {object} tags
 * @property {object} rawAttrs
 * @property {string} workspaceId
 * @property {string} iacEngine
 */
