// api/src/routes/discovery.metadata.js
//
// Read-only metadata endpoints that let the UI drop its hardcoded
// PROVIDER_META and RESOURCE_ICONS maps. When we add a new cloud provider
// or resource type, updating the source of truth here (or in
// discovery.schema.js) auto-reflects in every UI consumer.
//
// Mounted under /discovery so the URLs read naturally:
//   GET /discovery/providers       — provider catalogue
//   GET /discovery/resource-types  — typed-label + icon map per provider:type
//
// The UI is expected to treat the endpoint as authoritative but keep a
// small offline fallback so hydration failure doesn't break rendering.

import { RESOURCE_TYPE_LABELS } from './discovery.schema.js'

// Provider catalogue — one source of truth for label/colour/icon/capabilities.
// UI pages previously held three divergent copies (infra, discovery, graph).
const PROVIDERS = [
  { id: 'aws',
    label: 'AWS',
    color: '#f59e0b',
    icon:  '☁',
    capabilities: 'EC2 · RDS · Lambda · EKS · ECS · ALB · ElastiCache',
  },
  { id: 'azure',
    label: 'Azure',
    color: '#38bdf8',
    icon:  '◈',
    capabilities: 'VMs · AKS · SQL · App Services · Redis · VNets',
  },
  { id: 'gcp',
    label: 'GCP',
    color: '#22c55e',
    icon:  '◎',
    capabilities: 'Compute · GKE · Cloud SQL · Cloud Run',
  },
  { id: 'onprem',
    label: 'On-Prem',
    color: '#a78bfa',
    icon:  '⊞',
    capabilities: 'vSphere · Bare metal',
  },
]

// Per-resource-type icon — the UI's RESOURCE_ICONS map, merged here so
// downstream consumers don't each carry a copy. Keyed by resource_type
// (not the composite provider:resource_type) because the UI typically
// renders a type badge without provider context at hand.
//
// Unknowns fall back to the default icon UI-side.
const RESOURCE_TYPE_ICONS = {
  // Compute
  ec2_instance: '⬢', vm: '⬢', compute_instance: '⬢', arc_server: '⬢',
  function: 'ƒ',    function_app: 'ƒ',  cloud_function: 'ƒ',
  cloud_run: 'ƒ',   logic_app: 'ƒ',
  // Containers
  aks_cluster: '◉', eks_cluster: '◉', ecs_cluster: '◉',
  gke_cluster: '◉', arc_kubernetes: '◉', container_app: '◉',
  container_registry: '◉',
  // Databases
  sql_server: '▤', sql_database: '▤', rds_instance: '▤', rds_cluster: '▤',
  postgresql: '▤', postgres_server: '▤', mysql_server: '▤',
  cosmosdb: '▤',   cosmos_db: '▤',   dynamodb: '▤',
  cloud_sql: '▤',  bigtable: '▤',    spanner: '▤',
  arc_sql: '▤',    arc_postgres: '▤',
  // Caching
  redis: '⚡', elasticache: '⚡',
  // Web / app
  app_service: '◐', app_service_plan: '◐', static_web_app: '◐',
  // Networking
  vnet: '◇', vpc: '◇', subnet: '◇', security_group: '◇', nsg: '◇',
  load_balancer: '⇄', application_gateway: '⇄', front_door: '⇄',
  cdn: '⇄', api_gateway: '⇄', api_management: '⇄',
  private_dns: '⊙',
  // Storage / messaging
  s3_bucket: '◱', storage_account: '◱', gcs_bucket: '◱',
  sqs_queue: '≡', sns_topic: '≡', pubsub: '≡',
  service_bus: '≡', event_hub: '≡', event_grid: '≡',
  kinesis: '≡', kafka: '≡',
  // Observability / security
  app_insights: '◬', log_analytics: '◬',
  key_vault: '⊛',
}

function buildResourceTypeCatalogue() {
  // One row per entry in RESOURCE_TYPE_LABELS, with icon lookup by bare type.
  const out = []
  for (const [compositeKey, labels] of Object.entries(RESOURCE_TYPE_LABELS)) {
    const [provider, resourceType] = compositeKey.split(':')
    out.push({
      provider,
      resourceType,
      providerLabel: labels[0],       // e.g. 'AzureVM'
      ontologyLabel: labels[1],       // e.g. 'ComputeInstance'
      icon: RESOURCE_TYPE_ICONS[resourceType] || null,
    })
  }
  return out
}

export default async function discoveryMetadataRoutes(fastify) {
  fastify.get('/providers', {
    schema: {
      summary:     'Catalogue of supported cloud providers',
      description: 'Returns the static list of providers AppCloud can scan (aws / azure / gcp) with display metadata. UI uses this to render the provider picker.',
      response:    { 200: { type: 'object', properties: { providers: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async () => ({
    providers: PROVIDERS,
  }))

  fastify.get('/resource-types', {
    schema: {
      summary:     'Catalogue of recognised resource types',
      description: 'Returns the per-provider, typed-label catalogue derived from `discovery.schema.js`. Includes the cross-cloud ontology label (e.g. `ComputeInstance` covers Azure VM, EC2, GCE) and an icon hint.',
      response:    { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => ({
    resourceTypes: buildResourceTypeCatalogue(),
    icons: RESOURCE_TYPE_ICONS,
  }))
}
