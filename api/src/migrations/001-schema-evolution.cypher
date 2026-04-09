// ═══════════════════════════════════════════════════════════════════════════
// Migration 001: Schema Evolution — typed labels, timestamps, promoted fields
// ═══════════════════════════════════════════════════════════════════════════
//
// Run this ONCE against existing Neo4j databases to backfill:
//   1. firstseen / lastupdated timestamps on all Infra nodes
//   2. Typed node labels (AzureVM, EC2Instance, etc.)
//   3. Promoted raw fields to top-level properties
//   4. Typed relationship labels (dual-write alongside CONNECTED_TO)
//
// Safe to re-run — all operations are idempotent.
// Execute via Neo4j Browser, cypher-shell, or the API migration endpoint.

// ── 1. Backfill firstseen / lastupdated ──────────────────────────────────────
MATCH (i:Infra) WHERE i.firstseen IS NULL
SET i.firstseen   = COALESCE(i.discovered_at, datetime()).epochMillis,
    i.lastupdated = COALESCE(i.discovered_at, datetime()).epochMillis;

// ── 2. Typed labels — Azure ──────────────────────────────────────────────────
MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'vm'
SET i:AzureVM:ComputeInstance;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'aks_cluster'
SET i:AzureAKS:ContainerCluster;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'sql_server'
SET i:AzureSQLServer:DatabaseInstance;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'app_service'
SET i:AzureAppService:WebService;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'redis'
SET i:AzureRedis:CacheInstance;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'vnet'
SET i:AzureVNet:VirtualNetwork;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'app_service_plan'
SET i:AzureAppServicePlan:HostingPlan;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'app_insights'
SET i:AzureAppInsights:MonitoringService;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'storage_account'
SET i:AzureStorage:ObjectStorage;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'service_bus'
SET i:AzureServiceBus:MessageBroker;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'key_vault'
SET i:AzureKeyVault:SecretsManager;

MATCH (i:Infra) WHERE i.provider = 'azure' AND i.resource_type = 'load_balancer'
SET i:AzureLoadBalancer:NetworkDevice;

// ── 2b. Typed labels — AWS ───────────────────────────────────────────────────
MATCH (i:Infra) WHERE i.provider = 'aws' AND i.resource_type = 'ec2_instance'
SET i:EC2Instance:ComputeInstance;

MATCH (i:Infra) WHERE i.provider = 'aws' AND i.resource_type = 'rds_instance'
SET i:RDSInstance:DatabaseInstance;

MATCH (i:Infra) WHERE i.provider = 'aws' AND i.resource_type = 'function'
SET i:LambdaFunction:ServerlessFunction;

MATCH (i:Infra) WHERE i.provider = 'aws' AND i.resource_type = 'eks_cluster'
SET i:EKSCluster:ContainerCluster;

MATCH (i:Infra) WHERE i.provider = 'aws' AND i.resource_type = 'ecs_cluster'
SET i:ECSCluster:ContainerCluster;

MATCH (i:Infra) WHERE i.provider = 'aws' AND i.resource_type = 'load_balancer'
SET i:AWSLoadBalancer:NetworkDevice;

MATCH (i:Infra) WHERE i.provider = 'aws' AND i.resource_type = 'elasticache'
SET i:ElastiCache:CacheInstance;

MATCH (i:Infra) WHERE i.provider = 'aws' AND i.resource_type = 's3_bucket'
SET i:S3Bucket:ObjectStorage;

// ── 2c. Typed labels — GCP ───────────────────────────────────────────────────
MATCH (i:Infra) WHERE i.provider = 'gcp' AND i.resource_type = 'compute_instance'
SET i:GCPComputeInstance:ComputeInstance;

MATCH (i:Infra) WHERE i.provider = 'gcp' AND i.resource_type = 'gke_cluster'
SET i:GKECluster:ContainerCluster;

MATCH (i:Infra) WHERE i.provider = 'gcp' AND i.resource_type = 'cloud_sql'
SET i:GCPCloudSQL:DatabaseInstance;

MATCH (i:Infra) WHERE i.provider = 'gcp' AND i.resource_type = 'cloud_run'
SET i:GCPCloudRun:ServerlessFunction;

// ── 3. Promote raw fields to top-level properties ────────────────────────────
// Azure
MATCH (i:Infra) WHERE i.provider = 'azure' AND i.raw IS NOT NULL AND i.resource_group IS NULL
WITH i, apoc.convert.fromJsonMap(i.raw) AS r
SET i.resource_group = r.resourceGroup,
    i.server_farm_id = r.serverFarmId,
    i.vnet_subnet_id = r.vnetSubnetId,
    i.vm_size        = r.vmSize,
    i.subnet_id      = r.subnetId,
    i.service_kind   = r.kind;

// AWS
MATCH (i:Infra) WHERE i.provider = 'aws' AND i.raw IS NOT NULL AND i.instance_type IS NULL
WITH i, apoc.convert.fromJsonMap(i.raw) AS r
SET i.instance_type  = r.instanceType,
    i.vpc_id         = r.vpcId,
    i.subnet_id      = r.subnetId,
    i.private_ip     = r.privateIp,
    i.public_ip      = r.publicIp;

// GCP
MATCH (i:Infra) WHERE i.provider = 'gcp' AND i.raw IS NOT NULL AND i.machine_type IS NULL
WITH i, apoc.convert.fromJsonMap(i.raw) AS r
SET i.machine_type   = r.machineType,
    i.gcp_zone       = r.zone,
    i.network         = r.network,
    i.subnetwork      = r.subnetwork,
    i.private_ip      = r.internalIp,
    i.public_ip       = r.externalIp;

// ── 4. Typed relationships (dual-write alongside existing CONNECTED_TO) ──────
MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'nic'
MERGE (a)-[t:NETWORK_INTERFACE {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'disk'
MERGE (a)-[t:ATTACHED_DISK {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'subnet'
MERGE (a)-[t:PART_OF_SUBNET {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'vnet'
MERGE (a)-[t:MEMBER_OF_VNET {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'nsg'
MERGE (a)-[t:SECURED_BY {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'app-service-plan'
MERGE (a)-[t:HOSTED_ON_PLAN {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'sql-server'
MERGE (a)-[t:CHILD_OF_SERVER {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'vnet-integration'
MERGE (a)-[t:VNET_INTEGRATED {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'observed-tcp'
MERGE (a)-[t:OBSERVED_CONNECTION {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen,
              t.connection_count = r.connection_count, t.ports = r.ports, t.process = r.process;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'monitors'
MERGE (a)-[t:MONITORS {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'public-ip'
MERGE (a)-[t:HAS_PUBLIC_IP {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'private-endpoint'
MERGE (a)-[t:PRIVATE_ENDPOINT {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'lb-backend-nic'
MERGE (a)-[t:LB_BACKEND {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'contains'
MERGE (a)-[t:TOPOLOGY_CONTAINS {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;

MATCH (a:Infra)-[r:CONNECTED_TO]->(b:Infra) WHERE r.via = 'associated'
MERGE (a)-[t:TOPOLOGY_ASSOCIATED {via: r.via}]->(b)
ON CREATE SET t.discovered_at = r.discovered_at, t.source = r.source, t.last_seen = r.last_seen;
