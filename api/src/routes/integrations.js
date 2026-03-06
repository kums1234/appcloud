// routes/integrations.js — Terraform state file import + integration management
// ── Terraform resource type → AppCloud schema mapping ────────────────────────
// Maps terraform resource types to { provider, resourceType } for Infra nodes,
// or 'component' for things that become Component nodes.
const TF_RESOURCE_MAP = {
  // AWS Compute
  'aws_instance':              { provider:'aws', resourceType:'ec2_instance' },
  'aws_lambda_function':       { provider:'aws', resourceType:'function' },
  'aws_ecs_service':           { provider:'aws', resourceType:'ecs_service' },
  'aws_ecs_cluster':           { provider:'aws', resourceType:'ecs_cluster' },
  'aws_eks_cluster':           { provider:'aws', resourceType:'eks_cluster' },
  'aws_eks_node_group':        { provider:'aws', resourceType:'eks_node_group' },
  'aws_autoscaling_group':     { provider:'aws', resourceType:'autoscaling_group' },
  // AWS Database
  'aws_db_instance':           { provider:'aws', resourceType:'rds_instance' },
  'aws_rds_cluster':           { provider:'aws', resourceType:'rds_cluster' },
  'aws_elasticache_cluster':   { provider:'aws', resourceType:'elasticache' },
  'aws_elasticache_replication_group': { provider:'aws', resourceType:'elasticache' },
  'aws_dynamodb_table':        { provider:'aws', resourceType:'dynamodb' },
  'aws_redshift_cluster':      { provider:'aws', resourceType:'redshift' },
  // AWS Networking
  'aws_vpc':                   { provider:'aws', resourceType:'vpc' },
  'aws_subnet':                { provider:'aws', resourceType:'subnet' },
  'aws_security_group':        { provider:'aws', resourceType:'security_group' },
  'aws_lb':                    { provider:'aws', resourceType:'load_balancer' },
  'aws_alb':                   { provider:'aws', resourceType:'load_balancer' },
  'aws_cloudfront_distribution':{ provider:'aws', resourceType:'cdn' },
  'aws_api_gateway_rest_api':  { provider:'aws', resourceType:'api_gateway' },
  'aws_api_gateway_v2_api':    { provider:'aws', resourceType:'api_gateway' },
  // AWS Storage & Messaging
  'aws_s3_bucket':             { provider:'aws', resourceType:'s3_bucket' },
  'aws_sqs_queue':             { provider:'aws', resourceType:'sqs_queue' },
  'aws_sns_topic':             { provider:'aws', resourceType:'sns_topic' },
  'aws_kinesis_stream':        { provider:'aws', resourceType:'kinesis' },
  'aws_msk_cluster':           { provider:'aws', resourceType:'kafka' },
  // Azure Compute
  'azurerm_virtual_machine':   { provider:'azure', resourceType:'vm' },
  'azurerm_linux_virtual_machine':{ provider:'azure', resourceType:'vm' },
  'azurerm_windows_virtual_machine':{ provider:'azure', resourceType:'vm' },
  'azurerm_function_app':      { provider:'azure', resourceType:'function' },
  'azurerm_kubernetes_cluster':{ provider:'azure', resourceType:'aks_cluster' },
  'azurerm_app_service':       { provider:'azure', resourceType:'app_service' },
  // Azure Database
  'azurerm_sql_server':        { provider:'azure', resourceType:'sql_server' },
  'azurerm_mssql_server':      { provider:'azure', resourceType:'sql_server' },
  'azurerm_postgresql_server': { provider:'azure', resourceType:'postgresql' },
  'azurerm_cosmosdb_account':  { provider:'azure', resourceType:'cosmosdb' },
  'azurerm_redis_cache':       { provider:'azure', resourceType:'redis' },
  // Azure Networking & Storage
  'azurerm_virtual_network':   { provider:'azure', resourceType:'vnet' },
  'azurerm_storage_account':   { provider:'azure', resourceType:'storage_account' },
  'azurerm_servicebus_namespace':{ provider:'azure', resourceType:'service_bus' },
  // GCP Compute
  'google_compute_instance':   { provider:'gcp', resourceType:'compute_instance' },
  'google_container_cluster':  { provider:'gcp', resourceType:'gke_cluster' },
  'google_cloudfunctions_function':{ provider:'gcp', resourceType:'function' },
  'google_cloud_run_service':  { provider:'gcp', resourceType:'cloud_run' },
  // GCP Database
  'google_sql_database_instance':{ provider:'gcp', resourceType:'cloud_sql' },
  'google_bigtable_instance':  { provider:'gcp', resourceType:'bigtable' },
  'google_spanner_instance':   { provider:'gcp', resourceType:'spanner' },
  'google_redis_instance':     { provider:'gcp', resourceType:'redis' },
  // GCP Networking & Storage
  'google_compute_network':    { provider:'gcp', resourceType:'vpc' },
  'google_storage_bucket':     { provider:'gcp', resourceType:'gcs_bucket' },
  'google_pubsub_topic':       { provider:'gcp', resourceType:'pubsub' },
}

// Helper: extract a human-readable name from a Terraform resource
function extractName(tfType, tfName, attrs = {}) {
  return attrs.name
    || attrs.cluster_name
    || attrs.db_name
    || attrs.function_name
    || attrs.bucket
    || tfName.replace(/_/g, '-')
}

// Helper: extract region from attributes
function extractRegion(attrs = {}) {
  return attrs.region
    || attrs.location
    || attrs.availability_zone?.replace(/[a-z]$/, '')  // strip AZ suffix
    || null
}

// Helper: is this resource internet-facing?
function isPublic(tfType, attrs = {}) {
  if (attrs.publicly_accessible === true)  return true
  if (attrs.public_access_prevention === 'enforced') return false
  if (tfType === 'aws_s3_bucket' && attrs.acl === 'public-read') return true
  if (attrs.assign_public_ip === true) return true
  return false
}

// ── Parse a Terraform state JSON into importable resources ──────────────────
function parseTerraformState(stateJson) {
  const resources = []
  const errors = []

  if (!stateJson.resources && !stateJson.values) {
    errors.push('Not a valid Terraform state file — missing "resources" or "values" key')
    return { resources, errors, version: null, workspace: null }
  }

  const version   = stateJson.terraform_version || stateJson.format_version || 'unknown'
  const workspace = stateJson.serial ? `serial-${stateJson.serial}` : 'default'

  // Support both terraform.tfstate format (v4) and `terraform show -json` format
  const rawResources = stateJson.resources
    || stateJson.values?.root_module?.resources
    || []

  for (const res of rawResources) {
    // Skip data sources and terraform meta-resources
    if (res.mode === 'data') continue
    if (!res.type || !res.name) continue

    const mapping = TF_RESOURCE_MAP[res.type]
    if (!mapping) continue  // skip unmapped types silently

    // Handle both v3 (primary.attributes) and v4 (instances[].attributes) formats
    const instances = res.instances?.length
      ? res.instances
      : res.primary ? [{ attributes: res.primary.attributes }] : [{ attributes: {} }]

    for (const inst of instances) {
      const attrs = inst.attributes || {}
      resources.push({
        terraformType: res.type,
        terraformName: res.name,
        terraformId:   inst.attributes?.id || `${res.type}.${res.name}`,
        provider:      mapping.provider,
        resourceType:  mapping.resourceType,
        name:          extractName(res.type, res.name, attrs),
        region:        extractRegion(attrs),
        public:        isPublic(res.type, attrs),
        tags:          attrs.tags || attrs.labels || {},
        rawAttrs:      attrs,
      })
    }
  }

  return { resources, errors, version, workspace }
}

// ── Route handler ────────────────────────────────────────────────────────────
export default async function integrationRoutes(fastify) {
  const { query, write } = fastify.neo4j

  // POST /integrations/terraform/import
  // Accepts multipart form-data with a "statefile" field containing the .tfstate JSON
  fastify.post('/terraform/import', async (req, reply) => {
    // Check multipart is available
    if (typeof req.file !== 'function') {
      return reply.internalServerError(
        '@fastify/multipart is not installed. Run: npm install @fastify/multipart, then rebuild the API container.'
      )
    }
    // Parse multipart
    let stateJson, filename, fileSizeBytes
    try {
      const data = await req.file()
      if (!data) return reply.badRequest('No file uploaded — send as multipart field "statefile"')
      filename = data.filename || 'terraform.tfstate'
      const chunks = []
      for await (const chunk of data.file) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      fileSizeBytes = raw.length
      stateJson = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      return reply.badRequest(`Could not parse state file: ${err.message}`)
    }

    // Create import job record in PostgreSQL
    let jobId = null
    if (fastify.pg?.pool) {
      const [job] = await fastify.pg.query(
        `INSERT INTO terraform_imports (filename, file_size_bytes, status)
         VALUES ($1, $2, 'parsing') RETURNING id`,
        [filename, fileSizeBytes]
      )
      jobId = job?.id
    }

    // Parse the state file
    const { resources, errors, version, workspace } = parseTerraformState(stateJson)

    if (errors.length && !resources.length) {
      if (fastify.pg?.pool && jobId) {
        await fastify.pg.query(
          `UPDATE terraform_imports SET status='error', error_message=$1, finished_at=now()
           WHERE id=$2`, [errors.join('; '), jobId]
        )
      }
      return reply.badRequest(errors.join('; '))
    }

    // Import resources into Neo4j using MERGE (idempotent — re-runs don't duplicate)
    let created = 0, updated = 0, skipped = 0
    const importedNames = []

    for (const res of resources) {
      try {
        const records = await write(`
          MERGE (i:Infra {terraform_id: $terraformId})
          ON CREATE SET
            i.id            = randomUUID(),
            i.name          = $name,
            i.provider      = $provider,
            i.resource_type = $resourceType,
            i.region        = $region,
            i.public        = $public,
            i.terraform_type = $terraformType,
            i.terraform_name = $terraformName,
            i.source        = 'terraform',
            i.imported_at   = datetime()
          ON MATCH SET
            i.name          = $name,
            i.provider      = $provider,
            i.resource_type = $resourceType,
            i.region        = $region,
            i.public        = $public,
            i.updated_at    = datetime()
          RETURN i, i.id AS nodeId,
                 CASE WHEN i.imported_at = i.updated_at THEN 'created' ELSE 'updated' END AS action
        `, {
          terraformId:   res.terraformId,
          name:          res.name,
          provider:      res.provider,
          resourceType:  res.resourceType,
          region:        res.region || '',
          public:        res.public,
          terraformType: res.terraformType,
          terraformName: res.terraformName,
        })

        if (records.length) {
          const action = records[0].get('action')
          if (action === 'created') created++
          else updated++
          importedNames.push(res.name)
        }
      } catch (err) {
        fastify.log.warn(`Failed to import ${res.terraformType}.${res.terraformName}: ${err.message}`)
        skipped++
      }
    }

    // Update job record
    const summary = {
      version, workspace,
      resourceTypeCounts: resources.reduce((acc, r) => {
        acc[r.terraformType] = (acc[r.terraformType] || 0) + 1
        return acc
      }, {}),
      sampleNames: importedNames.slice(0, 10),
      parseErrors: errors,
    }

    if (fastify.pg?.pool && jobId) {
      await fastify.pg.query(
        `UPDATE terraform_imports SET
           status='done', terraform_version=$1, workspace=$2,
           resources_found=$3, resources_imported=$4, resources_skipped=$5,
           raw_summary=$6, finished_at=now()
         WHERE id=$7`,
        [version, workspace, resources.length, created + updated, skipped,
         JSON.stringify(summary), jobId]
      )
      await fastify.pg.audit(
        'system', 'import', 'TerraformImport', jobId, filename,
        { created, updated, skipped, total: resources.length }
      )
    }

    reply.code(200).send({
      jobId,
      filename,
      terraformVersion: version,
      workspace,
      resourcesFound:   resources.length,
      resourcesCreated: created,
      resourcesUpdated: updated,
      resourcesSkipped: skipped,
      parseErrors:      errors,
      summary,
    })
  })

  // GET /integrations/terraform/history — recent import jobs
  fastify.get('/terraform/history', async (req, reply) => {
    if (!fastify.pg?.pool) return []
    const rows = await fastify.pg.query(
      `SELECT id, filename, status, terraform_version, workspace,
              resources_found, resources_imported, resources_skipped,
              error_message, created_at, finished_at,
              EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000 AS duration_ms
       FROM terraform_imports
       ORDER BY created_at DESC LIMIT 20`
    )
    return rows
  })
}