/**
 * discovery.schema.js
 *
 * Central schema constants for the discovery pipeline.
 * Defines typed Neo4j labels, typed relationship names, and promoted
 * properties — shared by discovery.js, discovery.azure.enrich.js,
 * and integrations.js.
 *
 * Design: additive dual-label approach — every node keeps the :Infra
 * label for backward compatibility; typed labels are added alongside it.
 */

// ─── Typed Node Labels ───────────────────────────────────────────────────────
//
// Maps provider:resource_type → [ProviderSpecificLabel, OntologyLabel]
//
// The ProviderSpecific label is unique per cloud resource type.
// The Ontology label is a cross-cloud category for unified queries
// (e.g. MATCH (d:DatabaseInstance) returns Azure SQL, RDS, and Cloud SQL).

export const RESOURCE_TYPE_LABELS = {
  // ── Azure ────────────────────────────────────────────────────────────────
  'azure:vm':                  ['AzureVM',            'ComputeInstance'],
  'azure:aks_cluster':         ['AzureAKS',           'ContainerCluster'],
  'azure:sql_server':          ['AzureSQLServer',     'DatabaseInstance'],
  'azure:sql_database':        ['AzureSQLDatabase',   'DatabaseInstance'],
  'azure:app_service':         ['AzureAppService',    'WebService'],
  'azure:function_app':        ['AzureFunctionApp',   'ServerlessFunction'],
  'azure:redis':               ['AzureRedis',         'CacheInstance'],
  'azure:vnet':                ['AzureVNet',          'VirtualNetwork'],
  'azure:app_service_plan':    ['AzureAppServicePlan','HostingPlan'],
  'azure:app_insights':        ['AzureAppInsights',   'MonitoringService'],
  'azure:storage_account':     ['AzureStorage',       'ObjectStorage'],
  'azure:service_bus':         ['AzureServiceBus',    'MessageBroker'],
  'azure:key_vault':           ['AzureKeyVault',      'SecretsManager'],
  'azure:event_hub':           ['AzureEventHub',      'MessageBroker'],
  'azure:event_grid':          ['AzureEventGrid',     'MessageBroker'],
  'azure:logic_app':           ['AzureLogicApp',      'ServerlessFunction'],
  'azure:load_balancer':       ['AzureLoadBalancer',  'NetworkDevice'],
  'azure:application_gateway': ['AzureAppGateway',    'NetworkDevice'],
  'azure:front_door':          ['AzureFrontDoor',     'NetworkDevice'],
  'azure:cdn':                 ['AzureCDN',           'NetworkDevice'],
  'azure:container_app':       ['AzureContainerApp',  'ContainerService'],
  'azure:api_management':      ['AzureAPIM',          'APIGateway'],
  'azure:cosmos_db':           ['AzureCosmosDB',      'DatabaseInstance'],
  'azure:postgres_server':     ['AzurePostgres',      'DatabaseInstance'],
  'azure:mysql_server':        ['AzureMySQL',         'DatabaseInstance'],
  'azure:container_registry':  ['AzureACR',           'ContainerRegistry'],
  'azure:nsg':                 ['AzureNSG',           'NetworkDevice'],
  'azure:private_dns':         ['AzurePrivateDNS',    'DNSService'],
  'azure:log_analytics':       ['AzureLogAnalytics',  'MonitoringService'],
  'azure:static_web_app':      ['AzureStaticWebApp',  'WebService'],
  // Arc resources
  'azure:arc_server':          ['AzureArcServer',     'ComputeInstance'],
  'azure:arc_kubernetes':      ['AzureArcK8s',        'ContainerCluster'],
  'azure:arc_sql':             ['AzureArcSQL',        'DatabaseInstance'],
  'azure:arc_postgres':        ['AzureArcPostgres',   'DatabaseInstance'],

  // ── AWS ──────────────────────────────────────────────────────────────────
  'aws:ec2_instance':          ['EC2Instance',         'ComputeInstance'],
  'aws:rds_instance':          ['RDSInstance',         'DatabaseInstance'],
  'aws:function':              ['LambdaFunction',      'ServerlessFunction'],
  'aws:eks_cluster':           ['EKSCluster',          'ContainerCluster'],
  'aws:ecs_cluster':           ['ECSCluster',          'ContainerCluster'],
  'aws:load_balancer':         ['AWSLoadBalancer',     'NetworkDevice'],
  'aws:elasticache':           ['ElastiCache',         'CacheInstance'],
  'aws:s3_bucket':             ['S3Bucket',            'ObjectStorage'],
  'aws:dynamodb':              ['DynamoDBTable',       'DatabaseInstance'],
  'aws:cloud_function':        ['LambdaFunction',      'ServerlessFunction'],

  // ── GCP ──────────────────────────────────────────────────────────────────
  'gcp:compute_instance':      ['GCPComputeInstance',  'ComputeInstance'],
  'gcp:gke_cluster':           ['GKECluster',          'ContainerCluster'],
  'gcp:cloud_sql':             ['GCPCloudSQL',         'DatabaseInstance'],
  'gcp:cloud_run':             ['GCPCloudRun',         'ServerlessFunction'],
  'gcp:cloud_function':        ['GCPCloudFunction',    'ServerlessFunction'],
  'gcp:gcs_bucket':            ['GCSBucket',           'ObjectStorage'],
}

// ─── Typed Relationship Labels ───────────────────────────────────────────────
//
// Maps the `via` property on :CONNECTED_TO edges to a typed relationship name.
// Both the typed rel AND the legacy :CONNECTED_TO are written (dual-write)
// so existing queries continue to work.

export const VIA_TO_REL_TYPE = {
  'nic':                  'NETWORK_INTERFACE',
  'disk':                 'ATTACHED_DISK',
  'subnet':               'PART_OF_SUBNET',
  'vnet':                 'MEMBER_OF_VNET',
  'nsg':                  'SECURED_BY',
  'public-ip':            'HAS_PUBLIC_IP',
  'route-table':          'USES_ROUTE_TABLE',
  'app-service-plan':     'HOSTED_ON_PLAN',
  'vnet-integration':     'VNET_INTEGRATED',
  'app-insights':         'MONITORED_BY',
  'aks-node-subnet':      'AKS_NODE_SUBNET',
  'sql-server':           'CHILD_OF_SERVER',
  'redis-vnet-injection': 'VNET_INJECTED',
  'private-endpoint':     'PRIVATE_ENDPOINT',
  'keyvault-vnet-rule':   'KEYVAULT_ACL',
  'lb-backend-nic':       'LB_BACKEND',
  'agw-subnet':           'AGW_SUBNET',
  'observed-tcp':         'OBSERVED_CONNECTION',
  'monitors':             'MONITORS',
  'contains':             'TOPOLOGY_CONTAINS',
  'associated':           'TOPOLOGY_ASSOCIATED',

  // ── Telemetry-derived service-to-service calls ────────────────────────
  // All ride the :CONNECTED_TO edge with a `source` property distinguishing
  // the observability pipeline (otel / datadog / new-relic / mesh / …).
  // Edge properties (rps, error_rate, p50_ms, p95_ms, window_start/end,
  // route, protocol) live on the :CONNECTED_TO relationship itself so
  // queries can MATCH (a)-[r:CONNECTED_TO]-(b) WHERE r.source='otel' …
  'otel-http':            'OBSERVED_HTTP_CALL',
  'otel-rpc':             'OBSERVED_RPC_CALL',
  'otel-messaging':       'OBSERVED_MESSAGING',
  'otel-db':              'OBSERVED_DB_CALL',
  'apm-call':             'OBSERVED_APM_CALL',
  'mesh-call':            'SERVICE_MESH_CALL',

  // ── IaC cross-workspace dependencies ───────────────────────────────────
  // Terraform's `terraform_remote_state` data source, Pulumi's
  // `StackReference`. Promoted to graph edges once a workspace is mapped
  // to a Component/Application; until then the TFC connector surfaces
  // them as scan warnings (see connectors/terraform-cloud/index.js).
  'terraform-remote-state': 'STATE_REFERENCE',
}

// ─── Promoted Raw Fields ─────────────────────────────────────────────────────
//
// Fields promoted from the `raw` JSON blob to top-level node properties.
// These are the fields actively used in Cypher queries, scoring, and display.
// The full `raw` JSON is kept for reference — these are copies for indexing.
//
// Format: { rawKey: neo4jProperty }

export const RAW_PROMOTED_FIELDS = {
  azure: {
    resourceGroup:    'resource_group',
    serverFarmId:     'server_farm_id',
    vnetSubnetId:     'vnet_subnet_id',
    vmSize:           'vm_size',
    subnetId:         'subnet_id',
    kind:             'service_kind',
  },
  aws: {
    instanceType:     'instance_type',
    vpcId:            'vpc_id',
    subnetId:         'subnet_id',
    privateIp:        'private_ip',
    publicIp:         'public_ip',
  },
  gcp: {
    machineType:      'machine_type',
    zone:             'gcp_zone',
    network:          'network',
    subnetwork:       'subnetwork',
    internalIp:       'private_ip',
    externalIp:       'public_ip',
  },
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Get the typed Neo4j labels for a given provider + resource_type.
 * Returns an array of labels to SET on the node (excluding :Infra which is always present).
 *
 *   getLabelsForType('azure', 'vm') → ['AzureVM', 'ComputeInstance']
 *   getLabelsForType('aws', 'ec2_instance') → ['EC2Instance', 'ComputeInstance']
 *   getLabelsForType('unknown', 'foo') → []
 */
export function getLabelsForType(provider, resourceType) {
  const key = `${(provider || '').toLowerCase()}:${(resourceType || '').toLowerCase()}`
  return RESOURCE_TYPE_LABELS[key] || []
}

/**
 * Get the typed relationship name for a given `via` value.
 *
 *   getTypedRel('nic') → 'NETWORK_INTERFACE'
 *   getTypedRel('unknown') → null
 */
export function getTypedRel(via) {
  return VIA_TO_REL_TYPE[(via || '').toLowerCase()] || null
}

/**
 * Extract promoted fields from a raw object for the given provider.
 * Returns a flat { neo4jProperty: value } object with only non-null values.
 *
 *   getPromotedFields('azure', { resourceGroup: 'rg-prod', vmSize: 'Standard_D4s_v3' })
 *   → { resource_group: 'rg-prod', vm_size: 'Standard_D4s_v3' }
 */
export function getPromotedFields(provider, raw = {}) {
  const mapping = RAW_PROMOTED_FIELDS[(provider || '').toLowerCase()]
  if (!mapping) return {}
  const result = {}
  for (const [rawKey, neo4jProp] of Object.entries(mapping)) {
    const val = raw[rawKey]
    if (val != null && val !== '') result[neo4jProp] = String(val)
  }
  return result
}

/**
 * Build the Cypher SET clause fragment for typed labels.
 * Returns a string like "SET i:AzureVM:ComputeInstance" or empty string if no labels.
 */
export function buildLabelSetClause(provider, resourceType, alias = 'i') {
  const labels = getLabelsForType(provider, resourceType)
  if (!labels.length) return ''
  return `SET ${alias}:${labels.join(':')}`
}

// ─── Component Typed Labels (telemetry-derived) ──────────────────────────────
//
// Components created from live telemetry (OTel spans, APM vendor service-maps,
// service-mesh metrics) receive these labels on top of the base :Component.
// Gives queries a clean way to pick workload-flavoured components out:
//
//   MATCH (s:TelemetryService)-[r:CONNECTED_TO]->(t:TelemetryService)
//   WHERE r.source = 'otel' AND r.error_rate > 0.05
//   RETURN s.name, t.name, r.p95_ms
//
// Manually-defined Components (via the UI or IaC mapping) do not get these
// labels — keep the :TelemetryService label as a marker of "observed from
// the outside" rather than "modelled deliberately".

export const TELEMETRY_COMPONENT_LABELS = ['TelemetryService', 'Workload']

/**
 * Build the Cypher SET clause fragment for telemetry-component labels.
 * Returns e.g. "SET c:TelemetryService:Workload".
 */
export function buildTelemetryComponentLabelClause(alias = 'c') {
  return `SET ${alias}:${TELEMETRY_COMPONENT_LABELS.join(':')}`
}

// ─── Resource Classification ─────────────────────────────────────────────────
//
// Controls which resource types are treated as infrastructure plumbing vs
// workloads vs platforms. Used by bootstrap, suggest, and suggest-fallback
// to prevent VNets/subnets/NSGs from becoming standalone applications.

/**
 * Resource types that are pure infrastructure plumbing.
 * These should NEVER create their own Application — they should only be
 * linked as dependencies of existing applications.
 */
export const INFRA_ONLY_TYPES = new Set([
  // Azure network plumbing
  'vnet', 'app_service_plan', 'nsg', 'private_dns',
  // AWS network plumbing
  'vpc', 'subnet', 'security_group',
  // Generic (may arrive via Terraform import)
  'nat_gateway', 'route_table', 'public_ip',
])

/**
 * Resource types that are platforms other apps deploy on.
 * Should NOT create their own Application UNLESS they have explicit app tags.
 * Should be suggested as DEPLOYED_ON targets for co-located workloads.
 */
export const PLATFORM_TYPES = new Set([
  'aks_cluster', 'eks_cluster', 'gke_cluster', 'ecs_cluster',
])

/**
 * Check whether a tags object contains an explicit application assignment tag.
 * When present, the tag overrides heuristic classification — even infra-only
 * or platform resources should respect an explicit app tag.
 *
 *   hasExplicitAppTag({ 'appcloud:app': 'my-app' }) → true
 *   hasExplicitAppTag({ env: 'prod' })               → false
 */
export function hasExplicitAppTag(tags) {
  if (!tags || typeof tags !== 'object') return false
  for (const k of Object.keys(tags)) {
    const norm = k.toLowerCase()
      .replace(/^appcloud[:-]/, '')
      .replace(/^app[:-]/, '')
      .replace(/-/g, '_')
      .trim()
    if (norm === 'app' || norm === 'application' || norm === 'app_name' || norm === 'application_name') {
      return !!tags[k]
    }
  }
  return false
}
