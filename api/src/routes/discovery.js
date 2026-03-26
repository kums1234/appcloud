// routes/discovery.js
// Live cloud discovery for AWS, Azure and GCP.
// Each scanner authenticates using credentials stored per-cloud-account in
// environment variables (or passed per-request for multi-account setups),
// calls the real provider APIs, and MERGE-writes results into Neo4j.
//
// Supported resources:
//   AWS  : EC2, RDS, Lambda, EKS, ECS, ALB/NLB, S3, ElastiCache
//   Azure: VMs, AKS, SQL Servers, App Services, Redis Cache, VNets
//   GCP  : Compute Instances, GKE Clusters, Cloud SQL, Cloud Run
//
// All scanners are lazy-imported so the API starts cleanly even when
// cloud SDKs are not installed (useful during development / local runs).

import { props, serialize } from '../utils/serialize.js'
import { encryptConfig, decryptConfig } from '../utils/encrypt.js'
import { bootstrapDiscovery } from './discovery.bootstrap.js'
import { bootstrapSuggestFallback } from './discovery.suggest.patch.js'
import { runAutoCreateIfEnabled } from '../plugins/scheduler.auto-create.patch.js'

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Flatten AWS tags array [{Key,Value}] → plain object */
function awsTags(tags = []) {
  return tags.reduce((o, t) => { o[t.Key] = t.Value; return o }, {})
}

/** Normalise a name: try Name tag, fall back to id */
function awsName(tags = [], fallback = '') {
  return awsTags(tags)['Name'] || fallback
}

/** Pull all pages from an AWS paginator */
async function awsPages(paginator) {
  const all = []
  for await (const page of paginator) all.push(page)
  return all
}

/** Pull all items from an Azure PagedAsyncIterableIterator */
async function azureList(iter) {
  const all = []
  for await (const item of iter) all.push(item)
  return all
}

/** Upsert an Infra node into Neo4j — returns the node id */
async function upsertInfra(write, fields) {
  // Merge incoming tags with any existing tags on the node.
  // This preserves tags that were manually added in the cloud console
  // or directly on the Neo4j node after the last scan.
  const incomingTagsStr = JSON.stringify(fields.tags || {})

  const records = await write(`
    MERGE (i:Infra { cloud_id: $cloudId })
    SET i.id            = COALESCE(i.id, randomUUID()),
        i.name          = $name,
        i.provider      = $provider,
        i.resource_type = $resourceType,
        i.region        = $region,
        i.status        = $status,
        i.public        = $public,
        i.source        = 'discovery',
        i.raw           = $raw,
        i.discovered_at = datetime(),
        i.tags          = CASE
          WHEN i.tags IS NULL OR i.tags = '{}'
          THEN $tags
          ELSE apoc.convert.toJson(
            apoc.map.merge(
              apoc.convert.fromJsonMap(COALESCE(i.tags, '{}')),
              apoc.convert.fromJsonMap($tags)
            )
          )
        END
    RETURN i.id AS nodeId
  `, {
    cloudId:      fields.cloudId,
    name:         fields.name        || fields.cloudId,
    provider:     fields.provider,
    resourceType: fields.resourceType,
    region:       fields.region      || '',
    status:       fields.status      || 'unknown',
    public:       fields.public      ?? false,
    tags:         incomingTagsStr,
    raw:          JSON.stringify(fields.raw  || {}),
  }).catch(async () => {
    // Fallback if APOC not available — overwrite tags (original behaviour)
    return write(`
      MERGE (i:Infra { cloud_id: $cloudId })
      SET i.id            = COALESCE(i.id, randomUUID()),
          i.name          = $name,
          i.provider      = $provider,
          i.resource_type = $resourceType,
          i.region        = $region,
          i.status        = $status,
          i.public        = $public,
          i.source        = 'discovery',
          i.tags          = $tags,
          i.raw           = $raw,
          i.discovered_at = datetime()
      RETURN i.id AS nodeId
    `, {
      cloudId:      fields.cloudId,
      name:         fields.name        || fields.cloudId,
      provider:     fields.provider,
      resourceType: fields.resourceType,
      region:       fields.region      || '',
      status:       fields.status      || 'unknown',
      public:       fields.public      ?? false,
      tags:         incomingTagsStr,
      raw:          JSON.stringify(fields.raw  || {}),
    })
  })
  return records[0]?.get('nodeId')
}

// ─── AWS Scanner ──────────────────────────────────────────────────────────────

async function scanAWS({ credentials, regions, write, log }) {
  const {
    EC2Client, DescribeInstancesCommand,
    paginateDescribeInstances,
  } = await import('@aws-sdk/client-ec2')
  const {
    RDSClient, paginateDescribeDBInstances,
  } = await import('@aws-sdk/client-rds')
  const {
    LambdaClient, paginateListFunctions,
  } = await import('@aws-sdk/client-lambda')
  const {
    EKSClient, ListClustersCommand, DescribeClusterCommand,
  } = await import('@aws-sdk/client-eks')
  const {
    ECSClient, ListClustersCommand: ECSListClusters,
    DescribeClustersCommand: ECSDescribeClusters,
  } = await import('@aws-sdk/client-ecs')
  const {
    ElasticLoadBalancingV2Client, paginateDescribeLoadBalancers,
  } = await import('@aws-sdk/client-elastic-load-balancing-v2')
  const {
    ElastiCacheClient, paginateDescribeCacheClusters,
  } = await import('@aws-sdk/client-elasticache')

  const stats = {
    ec2: 0, rds: 0, lambda: 0, eks: 0,
    ecs: 0, alb: 0, elasticache: 0, errors: [], skipped: [],
  }

  // Classify LocalStack Pro-gate errors as skipped rather than errors
  const isProError = (e) =>
    e.message?.includes('not yet implemented or pro feature') ||
    e.message?.includes('InternalFailure') && e.message?.includes('pro feature')

  const handleScanError = (label, e) => {
    if (isProError(e)) {
      stats.skipped.push(`${label}: not available (LocalStack Pro required)`)
    } else {
      stats.errors.push(`${label}: ${e.message}`)
    }
  }
  const creds = credentials ? {
    accessKeyId:     credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken:    credentials.sessionToken,
  } : undefined  // falls back to env / instance profile / ~/.aws

  // endpoint override — used for LocalStack and other AWS-compatible APIs
  const endpointOverride = process.env.AWS_ENDPOINT_URL || undefined

  for (const region of regions) {
    const cfg = {
      region,
      ...(creds          ? { credentials: creds }              : {}),
      ...(endpointOverride ? { endpoint: endpointOverride,
                               forcePathStyle: true }           : {}),
    }
    log.info(`[AWS] scanning region ${region}`)

    // ── EC2 instances ─────────────────────────────────────────────────────
    try {
      const ec2 = new EC2Client(cfg)
      for await (const page of paginateDescribeInstances({ client: ec2 }, {})) {
        for (const reservation of page.Reservations || []) {
          for (const inst of reservation.Instances || []) {
            if (inst.State?.Name === 'terminated') continue
            const name = awsName(inst.Tags, inst.InstanceId)
            await upsertInfra(write, {
              cloudId:      inst.InstanceId,
              name,
              provider:     'aws',
              resourceType: 'ec2_instance',
              region,
              status:       inst.State?.Name || 'unknown',
              public:       !!inst.PublicIpAddress,
              tags:         awsTags(inst.Tags),
              raw: {
                instanceType:    inst.InstanceType,
                imageId:         inst.ImageId,
                launchTime:      inst.LaunchTime,
                privateIp:       inst.PrivateIpAddress,
                publicIp:        inst.PublicIpAddress,
                vpcId:           inst.VpcId,
                subnetId:        inst.SubnetId,
                availabilityZone: inst.Placement?.AvailabilityZone,
                platform:        inst.Platform || 'linux',
                architecture:    inst.Architecture,
                iamProfile:      inst.IamInstanceProfile?.Arn,
              },
            })
            stats.ec2++
          }
        }
      }
    } catch (e) { handleScanError("EC2/${region}", e) }

    // ── RDS instances ─────────────────────────────────────────────────────
    try {
      const rds = new RDSClient(cfg)
      for await (const page of paginateDescribeDBInstances({ client: rds }, {})) {
        for (const db of page.DBInstances || []) {
          await upsertInfra(write, {
            cloudId:      db.DBInstanceArn,
            name:         db.DBInstanceIdentifier,
            provider:     'aws',
            resourceType: 'rds_instance',
            region,
            status:       db.DBInstanceStatus,
            public:       db.PubliclyAccessible,
            tags:         awsTags(db.TagList),
            raw: {
              engine:            db.Engine,
              engineVersion:     db.EngineVersion,
              instanceClass:     db.DBInstanceClass,
              multiAZ:           db.MultiAZ,
              storageType:       db.StorageType,
              allocatedStorage:  db.AllocatedStorage,
              endpoint:          db.Endpoint?.Address,
              port:              db.Endpoint?.Port,
              vpcId:             db.DBSubnetGroup?.VpcId,
              autoMinorVersionUpgrade: db.AutoMinorVersionUpgrade,
            },
          })
          stats.rds++
        }
      }
    } catch (e) { handleScanError("RDS/${region}", e) }

    // ── Lambda functions ──────────────────────────────────────────────────
    try {
      const lambda = new LambdaClient(cfg)
      for await (const page of paginateListFunctions({ client: lambda }, {})) {
        for (const fn of page.Functions || []) {
          await upsertInfra(write, {
            cloudId:      fn.FunctionArn,
            name:         fn.FunctionName,
            provider:     'aws',
            resourceType: 'function',
            region,
            status:       'active',
            public:       false,
            tags:         {},
            raw: {
              runtime:     fn.Runtime,
              handler:     fn.Handler,
              memorySize:  fn.MemorySize,
              timeout:     fn.Timeout,
              codeSize:    fn.CodeSize,
              description: fn.Description,
              lastModified: fn.LastModified,
              role:        fn.Role,
            },
          })
          stats.lambda++
        }
      }
    } catch (e) { handleScanError("Lambda/${region}", e) }

    // ── EKS clusters ─────────────────────────────────────────────────────
    try {
      const eks = new EKSClient(cfg)
      const listRes  = await eks.send(new ListClustersCommand({}))
      for (const clusterName of listRes.clusters || []) {
        const detail = await eks.send(new DescribeClusterCommand({ name: clusterName }))
        const c = detail.cluster
        await upsertInfra(write, {
          cloudId:      c.arn,
          name:         c.name,
          provider:     'aws',
          resourceType: 'eks_cluster',
          region,
          status:       c.status,
          public:       c.resourcesVpcConfig?.endpointPublicAccess ?? false,
          tags:         c.tags || {},
          raw: {
            version:              c.version,
            endpoint:             c.endpoint,
            roleArn:              c.roleArn,
            vpcId:                c.resourcesVpcConfig?.vpcId,
            subnetIds:            c.resourcesVpcConfig?.subnetIds,
            securityGroupIds:     c.resourcesVpcConfig?.clusterSecurityGroupId,
            endpointPublicAccess: c.resourcesVpcConfig?.endpointPublicAccess,
            logging:              c.logging?.clusterLogging?.map(l => l.types).flat(),
          },
        })
        stats.eks++
      }
    } catch (e) { handleScanError("EKS/${region}", e) }

    // ── ECS clusters ─────────────────────────────────────────────────────
    try {
      const ecs  = new ECSClient(cfg)
      const list = await ecs.send(new ECSListClusters({}))
      if (list.clusterArns?.length) {
        const detail = await ecs.send(
          new ECSDescribeClusters({ clusters: list.clusterArns })
        )
        for (const c of detail.clusters || []) {
          await upsertInfra(write, {
            cloudId:      c.clusterArn,
            name:         c.clusterName,
            provider:     'aws',
            resourceType: 'ecs_cluster',
            region,
            status:       c.status,
            public:       false,
            tags:         awsTags(c.tags),
            raw: {
              runningTasksCount:               c.runningTasksCount,
              activeServicesCount:             c.activeServicesCount,
              registeredContainerInstancesCount: c.registeredContainerInstancesCount,
              capacityProviders:               c.capacityProviders,
            },
          })
          stats.ecs++
        }
      }
    } catch (e) { handleScanError("ECS/${region}", e) }

    // ── ALB / NLB ─────────────────────────────────────────────────────────
    try {
      const elb = new ElasticLoadBalancingV2Client(cfg)
      for await (const page of paginateDescribeLoadBalancers({ client: elb }, {})) {
        for (const lb of page.LoadBalancers || []) {
          await upsertInfra(write, {
            cloudId:      lb.LoadBalancerArn,
            name:         lb.LoadBalancerName,
            provider:     'aws',
            resourceType: 'load_balancer',
            region,
            status:       lb.State?.Code || 'unknown',
            public:       lb.Scheme === 'internet-facing',
            tags:         {},
            raw: {
              type:             lb.Type,   // application | network | gateway
              scheme:           lb.Scheme,
              dnsName:          lb.DNSName,
              vpcId:            lb.VpcId,
              ipAddressType:    lb.IpAddressType,
              availabilityZones: lb.AvailabilityZones?.map(z => z.ZoneName),
            },
          })
          stats.alb++
        }
      }
    } catch (e) { handleScanError("ALB/${region}", e) }

    // ── ElastiCache clusters ──────────────────────────────────────────────
    try {
      const ec = new ElastiCacheClient(cfg)
      for await (const page of paginateDescribeCacheClusters({ client: ec }, {})) {
        for (const cluster of page.CacheClusters || []) {
          await upsertInfra(write, {
            cloudId:      cluster.CacheClusterId,
            name:         cluster.CacheClusterId,
            provider:     'aws',
            resourceType: 'elasticache',
            region,
            status:       cluster.CacheClusterStatus,
            public:       false,
            tags:         awsTags(cluster.TagList),
            raw: {
              engine:           cluster.Engine,
              engineVersion:    cluster.EngineVersion,
              cacheNodeType:    cluster.CacheNodeType,
              numCacheNodes:    cluster.NumCacheNodes,
              preferredAZ:      cluster.PreferredAvailabilityZone,
              endpoint:         cluster.ConfigurationEndpoint?.Address,
            },
          })
          stats.elasticache++
        }
      }
    } catch (e) { handleScanError("ElastiCache/${region}", e) }
  }

  return stats
}

// ─── Azure Scanner ────────────────────────────────────────────────────────────

async function scanAzure({ credentials, subscriptionId, write, log }) {
  const { DefaultAzureCredential, ClientSecretCredential } = await import('@azure/identity')
  const { ComputeManagementClient }      = await import('@azure/arm-compute')
  const { ContainerServiceClient }       = await import('@azure/arm-containerservice')
  const { SqlManagementClient }          = await import('@azure/arm-sql')
  const { WebSiteManagementClient }      = await import('@azure/arm-appservice')
  const { NetworkManagementClient }      = await import('@azure/arm-network')
  const { RedisManagementClient }        = await import('@azure/arm-rediscache')


  const subId = subscriptionId || process.env.AZURE_SUBSCRIPTION_ID
  if (!subId) throw new Error('subscriptionId is required for Azure discovery')

  // Build credential.
  // ClientSecretCredential REQUIRES tenantId — 'common' does not work for
  // service principals. If tenantId is missing, resolve it from the subscription
  // by calling the ARM unauthenticated metadata endpoint.
  let cred
  if (credentials?.clientId && credentials?.clientSecret) {
    let tenantId = credentials.tenantId

    if (!tenantId) {
      // Auto-resolve tenantId from subscription metadata (no auth needed)
      try {
        const metaUrl = `https://management.azure.com/subscriptions/${subId}?api-version=2022-12-01`
        const metaRes = await fetch(metaUrl)
        // ARM returns 401 with WWW-Authenticate header containing the tenantId
        const wwwAuth = metaRes.headers.get('www-authenticate') || ''
        const match = wwwAuth.match(/authorization_uri="[^"]*\/([0-9a-f-]{36})/)
        if (match) {
          tenantId = match[1]
          log.info(`[Azure] Resolved tenantId: ${tenantId}`)
        }
      } catch (e) {
        log.warn(`[Azure] Could not auto-resolve tenantId: ${e.message}`)
      }
    }

    if (!tenantId) {
      throw new Error(
        'tenantId is required for Azure service principal authentication. ' +
        'Add it to your Azure account configuration in Integrations.'
      )
    }

    cred = new ClientSecretCredential(tenantId, credentials.clientId, credentials.clientSecret)
  } else {
    cred = new DefaultAzureCredential()
  }

  const stats = { vms: 0, aks: 0, sql: 0, appService: 0, redis: 0, vnet: 0, errors: [], skipped: [] }

  const isProError = (e) =>
    e.message?.includes('not yet implemented or pro feature') ||
    e.code === 'AuthorizationFailed'

  const handleScanError = (label, e) => {
    if (isProError(e)) {
      stats.skipped.push(`${label}: insufficient permissions or not available`)
    } else {
      stats.errors.push(`${label}: ${e.message}`)
    }
  }

  // ── Virtual Machines ──────────────────────────────────────────────────
  try {
    const compute = new ComputeManagementClient(cred, subId)
    for await (const vm of compute.virtualMachines.listAll()) {
      const region = vm.location
      const rg = vm.id?.split('/')[4] || ''
      await upsertInfra(write, {
        cloudId:      vm.id,
        name:         vm.name,
        provider:     'azure',
        resourceType: 'vm',
        region,
        status:       vm.provisioningState || 'unknown',
        public:       false,  // VMs are not directly public by default
        tags:         vm.tags || {},
        raw: {
          vmSize:            vm.hardwareProfile?.vmSize,
          osType:            vm.storageProfile?.osDisk?.osType,
          imagePublisher:    vm.storageProfile?.imageReference?.publisher,
          imageOffer:        vm.storageProfile?.imageReference?.offer,
          imageSku:          vm.storageProfile?.imageReference?.sku,
          resourceGroup:     rg,
          availabilityZones: vm.zones,
          adminUsername:     vm.osProfile?.adminUsername,
        },
      })
      stats.vms++
    }
  } catch (e) { handleScanError("AzureVMs", e) }

  // ── AKS clusters ──────────────────────────────────────────────────────
  try {
    const aks = new ContainerServiceClient(cred, subId)
    for await (const cluster of aks.managedClusters.list()) {
      await upsertInfra(write, {
        cloudId:      cluster.id,
        name:         cluster.name,
        provider:     'azure',
        resourceType: 'aks_cluster',
        region:       cluster.location,
        status:       cluster.provisioningState || 'unknown',
        public:       !cluster.apiServerAccessProfile?.enablePrivateCluster,
        tags:         cluster.tags || {},
        raw: {
          kubernetesVersion:  cluster.kubernetesVersion,
          nodeCount:          cluster.agentPoolProfiles?.reduce((s, p) => s + (p.count || 0), 0),
          nodeVmSize:         cluster.agentPoolProfiles?.[0]?.vmSize,
          dnsPrefix:          cluster.dnsPrefix,
          fqdn:               cluster.fqdn,
          networkPlugin:      cluster.networkProfile?.networkPlugin,
          enableRBAC:         cluster.enableRBAC,
        },
      })
      stats.aks++
    }
  } catch (e) { handleScanError("AzureAKS", e) }

  // ── SQL Servers + Databases ───────────────────────────────────────────
  try {
    const sql = new SqlManagementClient(cred, subId)
    for await (const server of sql.servers.list()) {
      await upsertInfra(write, {
        cloudId:      server.id,
        name:         server.name,
        provider:     'azure',
        resourceType: 'sql_server',
        region:       server.location,
        status:       server.state || 'unknown',
        public:       server.publicNetworkAccess === 'Enabled',
        tags:         server.tags || {},
        raw: {
          version:              server.version,
          administratorLogin:   server.administratorLogin,
          fullyQualifiedDomainName: server.fullyQualifiedDomainName,
          publicNetworkAccess:  server.publicNetworkAccess,
          minimalTlsVersion:    server.minimalTlsVersion,
        },
      })
      stats.sql++
    }
  } catch (e) { handleScanError("AzureSQL", e) }

  // ── App Services ──────────────────────────────────────────────────────
  try {
    const web = new WebSiteManagementClient(cred, subId)
    for await (const app of web.webApps.list()) {
      await upsertInfra(write, {
        cloudId:      app.id,
        name:         app.name,
        provider:     'azure',
        resourceType: 'app_service',
        region:       app.location,
        status:       app.state || 'unknown',
        public:       true,  // App Services are typically internet-facing
        tags:         app.tags || {},
        raw: {
          kind:              app.kind,
          defaultHostName:   app.defaultHostName,
          httpsOnly:         app.httpsOnly,
          serverFarmId:      app.serverFarmId,
          outboundIpAddresses: app.outboundIpAddresses,
          clientAffinityEnabled: app.clientAffinityEnabled,
          enabled:           app.enabled,
        },
      })
      stats.appService++
    }
  } catch (e) { handleScanError("AzureAppService", e) }

  // ── Redis Caches ──────────────────────────────────────────────────────
  // @azure/arm-rediscache v8: no listAll() — iterate per resource group
  try {
    const redis = new RedisManagementClient(cred, subId)
    const { ResourceManagementClient } = await import('@azure/arm-resources')
    const rgClient = new ResourceManagementClient(cred, subId)
    for await (const rg of rgClient.resourceGroups.list()) {
      for await (const cache of redis.redis.listByResourceGroup(rg.name)) {
        await upsertInfra(write, {
          cloudId:      cache.id,
          name:         cache.name,
          provider:     'azure',
          resourceType: 'redis',
          region:       cache.location,
          status:       cache.provisioningState || 'unknown',
          public:       cache.publicNetworkAccess === 'Enabled',
          tags:         cache.tags || {},
          raw: {
            sku:               `${cache.sku?.name} ${cache.sku?.family}${cache.sku?.capacity}`,
            hostName:          cache.hostName,
            port:              cache.port,
            sslPort:           cache.sslPort,
            redisVersion:      cache.redisVersion,
            minimumTlsVersion: cache.minimumTlsVersion,
            enableNonSslPort:  cache.enableNonSslPort,
          },
        })
        stats.redis++
      }
    }
  } catch (e) { handleScanError("AzureRedis", e) }

  // ── Virtual Networks ──────────────────────────────────────────────────
  try {
    const network = new NetworkManagementClient(cred, subId)
    for await (const vnet of network.virtualNetworks.listAll()) {
      await upsertInfra(write, {
        cloudId:      vnet.id,
        name:         vnet.name,
        provider:     'azure',
        resourceType: 'vnet',
        region:       vnet.location,
        status:       vnet.provisioningState || 'unknown',
        public:       false,
        tags:         vnet.tags || {},
        raw: {
          addressSpace:    vnet.addressSpace?.addressPrefixes,
          subnetCount:     vnet.subnets?.length || 0,
          dnsServers:      vnet.dhcpOptions?.dnsServers,
          enableDdosProtection: vnet.enableDdosProtection,
        },
      })
      stats.vnet++
    }
  } catch (e) { handleScanError("AzureVNet", e) }


  // ── Generic ARM resource scanner ─────────────────────────────────────
  // Uses @azure/arm-resources (already a dependency) to list ALL resource
  // types in the subscription. This picks up Application Insights, Storage
  // Accounts, Service Bus, Key Vaults and anything else — with full tags.
  // This avoids needing separate SDK packages for each resource type.
  try {
    const { ResourceManagementClient: GenericRMC } = await import('@azure/arm-resources')
    const genericClient = new GenericRMC(cred, subId)

    // Resource type → AppCloud resourceType mapping
    const ARM_TYPE_MAP = {
      'microsoft.insights/components':              'app_insights',
      'microsoft.storage/storageaccounts':          'storage_account',
      'microsoft.servicebus/namespaces':            'service_bus',
      'microsoft.keyvault/vaults':                  'key_vault',
      'microsoft.web/sites':                        'app_service',
      'microsoft.web/serverfarms':                  'app_service_plan',
      'microsoft.containerservice/managedclusters': 'aks_cluster',
      'microsoft.sql/servers':                      'sql_server',
      'microsoft.dbforpostgresql/servers':          'postgresql',
      'microsoft.dbformysql/servers':               'mysql',
      'microsoft.cache/redis':                      'redis',
      'microsoft.network/virtualnetworks':          'vnet',
      'microsoft.compute/virtualmachines':          'vm',
      'microsoft.logic/workflows':                  'logic_app',
      'microsoft.eventgrid/topics':                 'event_grid',
      'microsoft.eventhub/namespaces':              'event_hub',
      'microsoft.cdn/profiles':                     'cdn',
      'microsoft.apimanagement/service':            'api_management',
    }

    for await (const resource of genericClient.resources.list()) {
      const armType = resource.type?.toLowerCase() || ''
      const resourceType = ARM_TYPE_MAP[armType]

      // Skip types we handle with dedicated scanners (VMs, AKS, SQL already scanned above)
      // and types we don't recognise
      const alreadyScanned = [
        'microsoft.compute/virtualmachines',
        'microsoft.containerservice/managedclusters',
        'microsoft.sql/servers',
        'microsoft.web/sites',
        'microsoft.cache/redis',
        'microsoft.network/virtualnetworks',
      ]
      if (!resourceType || alreadyScanned.includes(armType)) continue

      await upsertInfra(write, {
        cloudId:      resource.id,
        name:         resource.name,
        provider:     'azure',
        resourceType,
        region:       resource.location || 'global',
        status:       resource.provisioningState || 'unknown',
        public:       false,
        tags:         resource.tags || {},
        raw: {
          type:     resource.type,
          kind:     resource.kind,
          sku:      resource.sku?.name,
          identity: resource.identity?.type,
        },
      })

      // Count by type
      const countKey = resourceType.replace(/_/g, '') + 'Count'
      stats[countKey] = (stats[countKey] || 0) + 1
    }
    log.info(`[Azure] Generic ARM scan complete`)
  } catch (e) { handleScanError('AzureGenericResources', e) }

  return stats
}

// ─── GCP Scanner ──────────────────────────────────────────────────────────────

async function scanGCP({ credentials, projectId, write, log }) {
  const { InstancesClient, ZonesClient } = await import('@google-cloud/compute')
  const { ClusterManagerClient }         = await import('@google-cloud/container')
  const { google }                       = await import('googleapis')

  const project = projectId || process.env.GCP_PROJECT_ID
  if (!project) throw new Error('GCP_PROJECT_ID is required for GCP discovery')

  // GCP auth: use credentials JSON if provided, else Application Default Credentials
  const authOpts = credentials?.client_email
    ? { credentials }
    : {}

  const stats = { instances: 0, gke: 0, sql: 0, cloudRun: 0, errors: [] }

  // ── Compute Engine instances — aggregatedList across all zones ────────
  try {
    const instancesClient = new InstancesClient(authOpts)
    // aggregatedList returns {zoneName: {instances: []}} across all zones
    const aggReq = instancesClient.aggregatedListAsync({ project })
    for await (const [zone, zoneData] of aggReq) {
      for (const inst of zoneData.instances || []) {
        if (inst.status === 'TERMINATED') continue
        const region = zone.replace('zones/', '').replace(/-[a-z]$/, '')  // us-central1-a → us-central1
        const externalIp = inst.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP
        await upsertInfra(write, {
          cloudId:      inst.selfLink,
          name:         inst.name,
          provider:     'gcp',
          resourceType: 'compute_instance',
          region,
          status:       inst.status?.toLowerCase() || 'unknown',
          public:       !!externalIp,
          tags:         inst.labels || {},
          raw: {
            machineType:  inst.machineType?.split('/').pop(),
            zone:         zone.replace('zones/', ''),
            internalIp:   inst.networkInterfaces?.[0]?.networkIP,
            externalIp,
            diskCount:    inst.disks?.length || 0,
            serviceAccount: inst.serviceAccounts?.[0]?.email,
            preemptible:  inst.scheduling?.preemptible,
            creationTimestamp: inst.creationTimestamp,
          },
        })
        stats.instances++
      }
    }
  } catch (e) { stats.errors.push(`GCPCompute: ${e.message}`) }

  // ── GKE clusters ─────────────────────────────────────────────────────
  try {
    const gke = new ClusterManagerClient(authOpts)
    // listClusters for all zones: parent = 'projects/{project}/locations/-'
    const [response] = await gke.listClusters({ parent: `projects/${project}/locations/-` })
    for (const cluster of response.clusters || []) {
      await upsertInfra(write, {
        cloudId:      cluster.selfLink || `gke/${project}/${cluster.name}`,
        name:         cluster.name,
        provider:     'gcp',
        resourceType: 'gke_cluster',
        region:       cluster.location,
        status:       cluster.status?.toString().toLowerCase() || 'unknown',
        public:       !cluster.privateClusterConfig?.enablePrivateEndpoint,
        tags:         cluster.resourceLabels || {},
        raw: {
          initialClusterVersion: cluster.initialClusterVersion,
          currentMasterVersion:  cluster.currentMasterVersion,
          nodeCount:             cluster.currentNodeCount,
          endpoint:              cluster.endpoint,
          network:               cluster.network,
          subnetwork:            cluster.subnetwork,
          loggingService:        cluster.loggingService,
          monitoringService:     cluster.monitoringService,
          autopilot:             !!cluster.autopilot?.enabled,
        },
      })
      stats.gke++
    }
  } catch (e) { stats.errors.push(`GCPGKE: ${e.message}`) }

  // ── Cloud SQL instances — via googleapis (sqladmin v1) ────────────────
  // @google-cloud/sql doesn't exist as a standalone client; use googleapis
  try {
    const auth = new google.auth.GoogleAuth({
      ...(credentials?.client_email ? { credentials } : {}),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const sqladmin = google.sqladmin({ version: 'v1', auth })
    const res = await sqladmin.instances.list({ project })
    for (const db of res.data.items || []) {
      const region = db.region || db.gceZone?.replace(/-[a-z]$/, '') || ''
      await upsertInfra(write, {
        cloudId:      db.selfLink || `cloudsql/${project}/${db.name}`,
        name:         db.name,
        provider:     'gcp',
        resourceType: 'cloud_sql',
        region,
        status:       db.state?.toLowerCase() || 'unknown',
        public:       (db.ipAddresses || []).some(ip => ip.type === 'PRIMARY'),
        tags:         db.userLabels || {},
        raw: {
          databaseVersion:  db.databaseVersion,
          tier:             db.settings?.tier,
          dataDiskSizeGb:   db.settings?.dataDiskSizeGb,
          backupEnabled:    db.settings?.backupConfiguration?.enabled,
          maintenanceWindow: db.settings?.maintenanceWindow,
          ipAddress:        db.ipAddresses?.find(ip => ip.type === 'PRIMARY')?.ipAddress,
          availabilityType: db.settings?.availabilityType,
        },
      })
      stats.sql++
    }
  } catch (e) { stats.errors.push(`GCPCloudSQL: ${e.message}`) }

  // ── Cloud Run services — via googleapis (run v2) ───────────────────────
  try {
    const auth = new google.auth.GoogleAuth({
      ...(credentials?.client_email ? { credentials } : {}),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const run = google.run({ version: 'v2', auth })
    // list across all locations
    const locRes = await run.projects.locations.list({ name: `projects/${project}` })
    for (const loc of locRes.data.locations || []) {
      try {
        const svcRes = await run.projects.locations.services.list({
          parent: `projects/${project}/locations/${loc.locationId}`,
        })
        for (const svc of svcRes.data.services || []) {
          await upsertInfra(write, {
            cloudId:      svc.name,
            name:         svc.name?.split('/').pop(),
            provider:     'gcp',
            resourceType: 'cloud_run',
            region:       loc.locationId,
            status:       svc.terminalCondition?.state?.toLowerCase() || 'unknown',
            public:       svc.ingress === 'INGRESS_TRAFFIC_ALL',
            tags:         svc.labels || {},
            raw: {
              uri:            svc.uri,
              creator:        svc.creator,
              lastModifier:   svc.lastModifier,
              containers:     svc.template?.containers?.map(c => c.image),
              minInstances:   svc.template?.scaling?.minInstanceCount,
              maxInstances:   svc.template?.scaling?.maxInstanceCount,
              ingress:        svc.ingress,
            },
          })
          stats.cloudRun++
        }
      } catch (_) { /* skip inaccessible locations */ }
    }
  } catch (e) { stats.errors.push(`GCPCloudRun: ${e.message}`) }

  return stats
}

// ─── Route handlers ───────────────────────────────────────────────────────────

export default async function discoveryRoutes(fastify) {
  const { write, query } = fastify.neo4j
  const audit = (...a) => fastify.pg.audit(...a).catch(() => {})
  const actor = (req) => req.user?.name || req.user?.id || 'system'

  // ── GET /discovery/accounts — proxy to Postgres cloud accounts ────────
  // Kept for backwards compatibility — returns same shape as before
  fastify.get('/accounts', async (req, reply) => {
    if (!fastify.pg.pool) return []
    const rows = await fastify.pg.query(
      `SELECT id, provider, name, config, enabled,
              last_scan_at, last_scan_status, last_scan_total
       FROM cloud_accounts WHERE enabled = true ORDER BY provider, name`
    )
    return rows.map(row => ({
      id:       row.id,
      provider: row.provider,
      name:     row.name,
      enabled:  row.enabled,
      config:   decryptConfig(row.config || {}),
      last_scan_at:     row.last_scan_at,
      last_scan_status: row.last_scan_status,
    }))
  })

  // ── POST /discovery/accounts — save cloud account to Postgres ──────────
  // Backwards-compatible shim — delegates to the cloud accounts table
  fastify.post('/accounts', async (req, reply) => {
    const { name, provider, config = {} } = req.body
    if (!name || !provider) return reply.badRequest('name and provider are required')
    if (!['aws','azure','gcp'].includes(provider))
      return reply.badRequest('provider must be aws, azure, or gcp')

    const encryptedConfig = encryptConfig({ ...config })

    if (fastify.pg.pool) {
      const rows = await fastify.pg.query(
        `INSERT INTO cloud_accounts (provider, name, config, enabled)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (provider, name) DO UPDATE
           SET config = EXCLUDED.config, updated_at = now()
         RETURNING id, provider, name, enabled, created_at`,
        [provider, name, JSON.stringify(encryptedConfig)]
      )
      const row = rows[0]
      audit(actor(req), 'create', 'CloudAccount', row.id, `${provider}:${name}`, { provider })
      reply.code(201)
      return { ...row, config: decryptConfig(encryptedConfig) }
    }

    // Fallback to Neo4j if Postgres unavailable
    const records = await write(`
      MERGE (a:CloudAccount { id: $id })
      SET a.name = $name, a.provider = $provider,
          a.config = $config, a.updatedAt = datetime()
      RETURN a
    `, { id: `${provider}:${name}`, name, provider, config: JSON.stringify(encryptedConfig) })
    const acct = props(records[0].get('a'))
    reply.code(201)
    return acct
  })

  // ── DELETE /discovery/accounts/:id ────────────────────────────────────
  fastify.delete('/accounts/:id', async (req, reply) => {
    if (fastify.pg.pool) {
      const rows = await fastify.pg.query(
        `SELECT provider, name FROM cloud_accounts WHERE id = $1`, [req.params.id]
      )
      if (!rows.length) return reply.notFound('Account not found')
      await fastify.pg.query(`DELETE FROM cloud_accounts WHERE id = $1`, [req.params.id])
      audit(actor(req), 'delete', 'CloudAccount', req.params.id,
        `${rows[0].provider}:${rows[0].name}`, {})
    } else {
      await write(`MATCH (a:CloudAccount {id:$id}) DELETE a`, { id: req.params.id })
    }
    reply.code(204)
  })


  // ── Helper: load all enabled accounts for a provider from Postgres ──────
  const loadAccounts = async (provider) => {
    if (!fastify.pg.pool) return []
    const rows = await fastify.pg.query(
      `SELECT id, name, config FROM cloud_accounts
       WHERE provider = $1 AND enabled = true ORDER BY name`,
      [provider]
    )
    return rows.map(r => ({ id: r.id, name: r.name, config: decryptConfig(r.config || {}) }))
  }

  // ── Helper: update scan result on account ────────────────────────────────
  const updateScanResult = async (accountId, status, total, error) => {
    if (!fastify.pg.pool || !accountId) return
    await fastify.pg.query(
      `UPDATE cloud_accounts
       SET last_scan_at = now(), last_scan_status = $1,
           last_scan_total = $2, last_scan_error = $3
       WHERE id = $4`,
      [status, total || 0, error || null, accountId]
    ).catch(() => {})
  }

  // ── POST /discovery/scan/aws ──────────────────────────────────────────────
  // Scans all configured AWS accounts from Postgres, or uses credentials
  // from the request body for a one-off scan.
  fastify.post('/scan/aws', async (req, reply) => {
    const { regions = ['us-east-1'], credentials, accountId } = req.body || {}
    const startedAt = Date.now()

    // Load all configured AWS accounts from Postgres
    const accounts = await loadAccounts('aws')

    // If credentials passed directly — one-off scan, not tied to a saved account
    if (credentials || !accounts.length) {
      fastify.log.info(`[Discovery] AWS one-off scan for regions: ${regions.join(', ')}`)
      let stats
      try {
        stats = await scanAWS({ credentials, regions, write, log: fastify.log })
      } catch (err) {
        return reply.internalServerError(`AWS scan failed: ${err.message}`)
      }
      const duration = Date.now() - startedAt
      const total = Object.entries(stats).filter(([k]) => !['errors','skipped'].includes(k)).reduce((s,[,v])=>s+v,0)
      audit(actor(req), 'scan', 'CloudAccount', 'aws', 'AWS', { regions, total, duration, breakdown: stats })
      return { provider: 'aws', accounts: 1, regions, duration, total, breakdown: stats, completedAt: new Date().toISOString() }
    }

    // Scan all configured accounts (or a specific one if accountId provided)
    const toScan = accountId ? accounts.filter(a => a.id === accountId || a.name === accountId) : accounts
    fastify.log.info(`[Discovery] AWS scan: ${toScan.length} account(s)`)

    const allResults = []
    for (const account of toScan) {
      const cfg = account.config || {}
      const creds = cfg.accessKeyId
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey || cfg.secretKey }
        : null
      const scanRegions = cfg.regions ? cfg.regions.split(',').map(r => r.trim()) : regions
      try {
        const stats = await scanAWS({ credentials: creds, regions: scanRegions, write, log: fastify.log })
        const total = Object.entries(stats).filter(([k]) => !['errors','skipped'].includes(k)).reduce((s,[,v])=>s+v,0)
        await updateScanResult(account.id, 'success', total, null)
        allResults.push({ account: account.name, regions: scanRegions, total, breakdown: stats })
      } catch (err) {
        await updateScanResult(account.id, 'error', 0, err.message)
        allResults.push({ account: account.name, error: err.message })
      }
    }

    const duration = Date.now() - startedAt
    const grandTotal = allResults.reduce((s, r) => s + (r.total || 0), 0)
    audit(actor(req), 'scan', 'CloudAccount', 'aws', 'AWS', { accounts: toScan.length, grandTotal, duration })
    return { provider: 'aws', accounts: toScan.length, duration, total: grandTotal, results: allResults, completedAt: new Date().toISOString() }
  })

  // ── POST /discovery/scan/azure ────────────────────────────────────────
  // Scans all configured Azure subscriptions from Postgres, or uses
  // credentials from the request body for a one-off scan.
  fastify.post('/scan/azure', async (req, reply) => {
    const { subscriptionId, credentials, accountId } = req.body || {}
    const startedAt = Date.now()

    // Load all configured Azure accounts from Postgres
    const accounts = await loadAccounts('azure')

    // One-off scan with credentials passed directly
    if (credentials || !accounts.length) {
      fastify.log.info(`[Discovery] Azure one-off scan: ${subscriptionId}`)
      let stats
      try {
        stats = await scanAzure({ credentials, subscriptionId, write, log: fastify.log })
      } catch (err) {
        return reply.internalServerError(`Azure scan failed: ${err.message}`)
      }
      const duration = Date.now() - startedAt
      const total = Object.entries(stats).filter(([k]) => !['errors','skipped'].includes(k)).reduce((s,[,v])=>s+v,0)
      audit(actor(req), 'scan', 'CloudAccount', 'azure', 'Azure', { subscriptionId, total, duration, breakdown: stats })
      return { provider: 'azure', accounts: 1, subscriptionId, duration, total, breakdown: stats, completedAt: new Date().toISOString() }
    }

    // Scan all configured subscriptions (or a specific one if accountId provided)
    const toScan = accountId ? accounts.filter(a => a.id === accountId || a.name === accountId) : accounts
    fastify.log.info(`[Discovery] Azure scan: ${toScan.length} subscription(s)`)

    const allResults = []
    for (const account of toScan) {
      const cfg = account.config || {}
      const creds = cfg.clientId
        ? { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret }
        : null
      const subId = cfg.subscriptionId || subscriptionId
      try {
        const stats = await scanAzure({ credentials: creds, subscriptionId: subId, write, log: fastify.log })
        const total = Object.entries(stats).filter(([k]) => !['errors','skipped'].includes(k)).reduce((s,[,v])=>s+v,0)
        await updateScanResult(account.id, 'success', total, null)
        allResults.push({ account: account.name, subscriptionId: subId, total, breakdown: stats })
      } catch (err) {
        await updateScanResult(account.id, 'error', 0, err.message)
        allResults.push({ account: account.name, subscriptionId: subId, error: err.message })
      }
    }

    const duration = Date.now() - startedAt
    const grandTotal = allResults.reduce((s, r) => s + (r.total || 0), 0)
    audit(actor(req), 'scan', 'CloudAccount', 'azure', 'Azure', { accounts: toScan.length, grandTotal, duration })
    return { provider: 'azure', accounts: toScan.length, duration, total: grandTotal, results: allResults, completedAt: new Date().toISOString() }
  })

  // ── POST /discovery/scan/gcp ──────────────────────────────────────────
  // Scans all configured GCP projects from Postgres, or uses credentials
  // from the request body for a one-off scan.
  fastify.post('/scan/gcp', async (req, reply) => {
    const { projectId, credentials, accountId } = req.body || {}
    const startedAt = Date.now()

    const accounts = await loadAccounts('gcp')

    // One-off scan with credentials passed directly
    if (credentials || !accounts.length) {
      fastify.log.info(`[Discovery] GCP one-off scan: ${projectId}`)
      let stats
      try {
        stats = await scanGCP({ credentials, projectId, write, log: fastify.log })
      } catch (err) {
        return reply.internalServerError(`GCP scan failed: ${err.message}`)
      }
      const duration = Date.now() - startedAt
      const total = Object.entries(stats).filter(([k]) => k !== 'errors').reduce((s,[,v])=>s+v,0)
      audit(actor(req), 'scan', 'CloudAccount', 'gcp', 'GCP', { projectId, total, duration, breakdown: stats })
      return { provider: 'gcp', accounts: 1, projectId, duration, total, breakdown: stats, completedAt: new Date().toISOString() }
    }

    // Scan all configured projects
    const toScan = accountId ? accounts.filter(a => a.id === accountId || a.name === accountId) : accounts
    fastify.log.info(`[Discovery] GCP scan: ${toScan.length} project(s)`)

    const allResults = []
    for (const account of toScan) {
      const cfg = account.config || {}
      let creds = null
      if (cfg.serviceAccount) {
        try { creds = JSON.parse(cfg.serviceAccount) } catch {}
      }
      const proj = cfg.projectId || projectId
      try {
        const stats = await scanGCP({ credentials: creds, projectId: proj, write, log: fastify.log })
        const total = Object.entries(stats).filter(([k]) => k !== 'errors').reduce((s,[,v])=>s+v,0)
        await updateScanResult(account.id, 'success', total, null)
        allResults.push({ account: account.name, projectId: proj, total, breakdown: stats })
      } catch (err) {
        await updateScanResult(account.id, 'error', 0, err.message)
        allResults.push({ account: account.name, projectId: proj, error: err.message })
      }
    }

    const duration = Date.now() - startedAt
    const grandTotal = allResults.reduce((s, r) => s + (r.total || 0), 0)
    audit(actor(req), 'scan', 'CloudAccount', 'gcp', 'GCP', { accounts: toScan.length, grandTotal, duration })
    return { provider: 'gcp', accounts: toScan.length, duration, total: grandTotal, results: allResults, completedAt: new Date().toISOString() }
  })

  // ── POST /discovery/scan/all — run all configured providers in parallel
  fastify.post('/scan/all', async (req, reply) => {
    const { aws, azure, gcp } = req.body || {}
    const results = {}
    const errors  = {}

    await Promise.allSettled([
      aws && scanAWS({ ...aws, write, log: fastify.log })
        .then(s => { results.aws = s }).catch(e => { errors.aws = e.message }),
      azure && scanAzure({ ...azure, write, log: fastify.log })
        .then(s => { results.azure = s }).catch(e => { errors.azure = e.message }),
      gcp && scanGCP({ ...gcp, write, log: fastify.log })
        .then(s => { results.gcp = s }).catch(e => { errors.gcp = e.message }),
    ])

    const providers = Object.keys(results)
    audit(actor(req), 'scan', 'CloudAccount', 'all', 'All Providers',
      { providers, results, errors })
    await runAutoCreateIfEnabled(fastify)
    return { results, errors, completedAt: new Date().toISOString() }
  })

  // ── GET /discovery/schedule ─────────────────────────────────────────────
  // Returns the current auto-discovery schedule configuration
  fastify.get('/schedule', async (req, reply) => {
    if (!fastify.pg?.pool) return {
      scope: 'global', enabled: false, interval_mins: 15,
      last_run_at: null, last_run_status: null, last_run_total: 0, next_run_at: null
    }
    try {
      await fastify.pg.query(`
        CREATE TABLE IF NOT EXISTS discovery_schedule (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          scope TEXT NOT NULL DEFAULT 'global',
          enabled BOOLEAN NOT NULL DEFAULT true,
          interval_mins INTEGER NOT NULL DEFAULT 15,
          auto_create BOOLEAN NOT NULL DEFAULT false,
          auto_create_min_score INTEGER NOT NULL DEFAULT 70,
          last_run_at TIMESTAMPTZ, last_run_status TEXT,
          last_run_total INTEGER DEFAULT 0,
          last_auto_create_total INTEGER DEFAULT 0,
          next_run_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (scope)
        );
        ALTER TABLE discovery_schedule
          ADD COLUMN IF NOT EXISTS auto_create BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS auto_create_min_score INTEGER NOT NULL DEFAULT 70,
          ADD COLUMN IF NOT EXISTS last_auto_create_total INTEGER DEFAULT 0;
        INSERT INTO discovery_schedule (scope, enabled, interval_mins, auto_create, auto_create_min_score)
        VALUES ('global', false, 15, false, 70) ON CONFLICT (scope) DO NOTHING;
      `).catch(() => {})
      const rows = await fastify.pg.query(
        `SELECT * FROM discovery_schedule WHERE scope = 'global' LIMIT 1`
      )
      return rows[0] || {
        scope: 'global', enabled: false, interval_mins: 15,
        auto_create: false, auto_create_min_score: 70
      }
    } catch (err) {
      return {
        scope: 'global', enabled: false, interval_mins: 15,
        auto_create: false, auto_create_min_score: 70, error: err.message
      }
    }
  })

  // ── PUT /discovery/schedule ──────────────────────────────────────────────
  // Update schedule config — enabled flag and/or interval_mins
  // interval_mins: minimum 5 (5 minutes), maximum 1440 (24 hours)
  fastify.put('/schedule', async (req, reply) => {
    const { enabled, interval_mins, hours, minutes, auto_create, auto_create_min_score } = req.body || {}

    // Accept either interval_mins directly or hours+minutes breakdown
    let intervalMins = interval_mins
    if (intervalMins === undefined && (hours !== undefined || minutes !== undefined)) {
      intervalMins = (parseInt(hours) || 0) * 60 + (parseInt(minutes) || 0)
    }

    // Validate
    if (intervalMins !== undefined) {
      if (intervalMins < 5)    return reply.badRequest('Minimum interval is 5 minutes')
      if (intervalMins > 1440) return reply.badRequest('Maximum interval is 1440 minutes (24 hours)')
    }

    if (!fastify.pg?.pool) return reply.serviceUnavailable('Database not available')

    try {
      const fields = {}
      if (enabled !== undefined)               fields.enabled                = enabled
      if (intervalMins !== undefined)          fields.interval_mins          = intervalMins
      if (auto_create !== undefined)           fields.auto_create            = auto_create
      if (auto_create_min_score !== undefined) fields.auto_create_min_score  =
        Math.max(0, Math.min(100, parseInt(auto_create_min_score) || 70))

      // Compute next_run_at based on new interval
      if (intervalMins !== undefined && enabled !== false) {
        fields.next_run_at = new Date(Date.now() + intervalMins * 60 * 1000)
      }

      const setClauses = Object.keys(fields).map((k, i) => `${k} = $${i + 1}`)
      setClauses.push('updated_at = now()')
      const values = [...Object.values(fields), 'global']

      const rows = await fastify.pg.query(
        `INSERT INTO discovery_schedule (scope, enabled, interval_mins)
         VALUES ('global', $1, $2)
         ON CONFLICT (scope) DO UPDATE SET ${setClauses.join(', ')}
         WHERE discovery_schedule.scope = $${values.length}
         RETURNING *`,
        [enabled ?? false, intervalMins ?? 15, ...values]
      ).catch(async () => {
        // Simpler upsert fallback
        await fastify.pg.query(
          `INSERT INTO discovery_schedule (scope, enabled, interval_mins, auto_create, auto_create_min_score)
           VALUES ('global', COALESCE($1, false), COALESCE($2, 15), COALESCE($3, false), COALESCE($4, 70))
           ON CONFLICT (scope) DO UPDATE
             SET enabled               = COALESCE($1, discovery_schedule.enabled),
                 interval_mins         = COALESCE($2, discovery_schedule.interval_mins),
                 auto_create           = COALESCE($3, discovery_schedule.auto_create),
                 auto_create_min_score = COALESCE($4, discovery_schedule.auto_create_min_score),
                 next_run_at = $5, updated_at = now()`,
          [enabled ?? null, intervalMins ?? null,
           auto_create ?? null, auto_create_min_score ?? null,
           fields.next_run_at ?? null]
        )
        const r = await fastify.pg.query(
          `SELECT * FROM discovery_schedule WHERE scope = 'global' LIMIT 1`
        )
        return r
      })

      const schedule = Array.isArray(rows) ? rows[0] : rows?.rows?.[0]

      // Restart the timer if scheduler plugin is available
      if (fastify.scheduler?.restart) {
        await fastify.scheduler.restart()
      }

      audit(actor(req), 'update', 'DiscoverySchedule', 'global', 'Discovery Schedule',
        { enabled, interval_mins: intervalMins })

      return schedule || { scope: 'global', enabled: enabled ?? false, interval_mins: intervalMins ?? 15 }
    } catch (err) {
      fastify.log.error(`[Schedule] PUT error: ${err.message}`)
      return reply.internalServerError(`Failed to update schedule: ${err.message}`)
    }
  })

  // ── POST /discovery/schedule/run-now ────────────────────────────────────
  // Manually trigger an immediate scan outside the schedule
  fastify.post('/schedule/run-now', async (req, reply) => {
    if (fastify.scheduler?.runNow) {
      // Fire and forget — don't await so the response returns immediately
      fastify.scheduler.runNow().catch(err =>
        fastify.log.error(`[Scheduler] Manual run error: ${err.message}`)
      )
      return { triggered: true, message: 'Scan started — check /discovery/schedule for status' }
    }
    // Fallback: call scan/all directly
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/scan/all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })
    const data = await res.json()
    return { triggered: true, ...data }
  })




  // ── GET /discovery/debug/:id — inspect raw Neo4j data for a resource ──
  // Use this to verify tags and raw are being stored correctly.
  // curl http://localhost:3000/discovery/debug/INFRA_ID
  fastify.get('/debug/:id', async (req, reply) => {
    const records = await query(
      `MATCH (i:Infra) WHERE i.id = $id OR i.cloud_id = $id RETURN i LIMIT 1`,
      { id: req.params.id }
    )
    if (!records.length) {
      // Return all infra node names so you can find the right ID
      const all = await query(
        `MATCH (i:Infra {source:'discovery'})
         RETURN i.id AS id, i.name AS name, i.provider AS provider,
                i.resource_type AS type,
                i.tags IS NOT NULL AS hasTags,
                i.raw  IS NOT NULL AS hasRaw,
                COALESCE(i.tags, '{}') AS tags
         ORDER BY i.provider, i.name LIMIT 50`
      )
      return {
        error: 'Infra node not found for id: ' + req.params.id,
        availableResources: all.map(r => ({
          id:       r.get('id'),
          name:     r.get('name'),
          provider: r.get('provider'),
          type:     r.get('type'),
          hasTags:  r.get('hasTags'),
          hasRaw:   r.get('hasRaw'),
          tagsRaw:  r.get('tags'),  // show raw string value from Neo4j
        }))
      }
    }
    const node = records[0].get('i')
    const raw = node.properties
    return {
      id:               raw.id,
      name:             raw.name,
      provider:         raw.provider,
      resource_type:    raw.resource_type,
      // Show the raw string values as stored in Neo4j
      tags_type:        typeof raw.tags,
      tags_raw:         raw.tags,       // raw string from Neo4j
      raw_type:         typeof raw.raw,
      raw_truncated:    typeof raw.raw === 'string' ? raw.raw.slice(0, 200) : raw.raw,
      // Show parsed values
      tags_parsed:      (() => { try { return typeof raw.tags === 'string' ? JSON.parse(raw.tags) : raw.tags } catch(e) { return { parseError: e.message } } })(),
      discovered_at:    raw.discovered_at?.toString(),
    }
  })

  // ── GET /discovery/suggest ────────────────────────────────────────────────
  // Analyses tags, metadata and name of every unmapped Infra node and returns
  // ranked mapping suggestions against existing Applications and Components.
  //
  // Scoring (0-100):
  //   appcloud:app tag matches Application.name exactly   → +40
  //   appcloud:app tag matches Application.name fuzzy     → +25
  //   appcloud:component tag matches Component.name       → +30
  //   appcloud:owner / team tag matches Application.owner → +15
  //   appcloud:env / environment matches                  → +10
  //   appcloud:tier matches Application.tier              → +5
  //   resource name contains component/app name          → +10
  //   resource type matches component type               → +5
  //
  //   Threshold for "high confidence" auto-suggest: >= 60
  //   Threshold for "possible match" display:       >= 25

  fastify.get('/suggest', async (req) => {
    const { minScore = 25, limit = 100 } = req.query

    // Load all unmapped Infra nodes
    const infraRecords = await query(`
      MATCH (i:Infra)
      WHERE i.source = 'discovery'
        AND NOT (:Component)-[:DEPLOYED_ON]->(i)
      RETURN i
      ORDER BY i.provider, i.resource_type, i.name
      LIMIT toInteger($limit)
    `, { limit: parseInt(limit) })

    if (!infraRecords.length) return {
      suggestions: [],
      diagnostic: { unmappedInfra: 0, applications: 0, message: 'No unmapped infrastructure resources found' }
    }

    // Load all Applications and their Components
    const appRecords = await query(`
      MATCH (a:Application)
      OPTIONAL MATCH (a)-[:CONTAINS]->(c:Component)
      RETURN a, collect(DISTINCT c) AS components
    `)

    const apps = appRecords.map(r => ({
      ...props(r.get('a')),
      components: r.get('components').map(props)
    }))

    if (!apps.length) {
      const fallback = bootstrapSuggestFallback(infraRecords, props)
      const suggestions = []
      for (const appSuggestion of fallback.suggestions || []) {
        for (const match of appSuggestion.matches || []) {
          const infra = match.infra || {}
          const score = parseInt(match.score || 0)
          const confidence = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low'
          suggestions.push({
            infra,
            suggestions: [{
              infraId: infra.id,
              componentId: null,
              componentName: null,
              applicationId: null,
              applicationName: appSuggestion.application?.name || 'unknown',
              score,
              confidence,
              reasons: match.reasons || [],
              action: 'create_application',
              actionLabel: `Create application "${appSuggestion.application?.name || 'app'}" with component "${infra.name || 'component'}"`,
              newAppName: appSuggestion.application?.name || infra.name || 'default-app',
              newCompName: infra.name || 'component',
            }],
            topScore: score,
            topConfidence: confidence,
          })
        }
      }
      return {
        suggestions,
        diagnostic: fallback.diagnostic || { mode: 'bootstrap', unmappedInfra: infraRecords.length }
      }
    }

    const suggestions = []

    for (const ir of infraRecords) {
      const infra = props(ir.get('i'))

      // tags and raw are stored as JSON strings in Neo4j.
      // props() returns them as strings, but guard against both cases.
      const parseProp = (val) => {
        if (!val) return {}
        if (typeof val === 'object') return val   // already parsed
        if (typeof val === 'string') {
          try { return JSON.parse(val) } catch { return {} }
        }
        return {}
      }
      let tags = parseProp(infra.tags)
      let raw  = parseProp(infra.raw)

      // Normalise tag keys — strip all known prefixes, lowercase everything.
      // Handles: appcloud:app, appcloud-app, app, application, App, APPLICATION
      // and Azure/AWS/GCP conventions.
      const tagNorm = {}
      for (const [k, v] of Object.entries(tags)) {
        const normKey = k.toLowerCase()
          .replace(/^appcloud[:-]/, '')  // strip appcloud: or appcloud-
          .replace(/^app[:-]/, '')       // strip app: or app-
          .replace(/-/g, '_')            // normalise hyphens to underscores
          .trim()
        tagNorm[normKey] = String(v || '').toLowerCase().trim()
      }

      // Also store original casing for display
      const tagRaw = {}
      for (const [k, v] of Object.entries(tags)) {
        tagRaw[k.toLowerCase()] = String(v || '').toLowerCase().trim()
      }

      // Application name — check all common conventions
      const tagApp = (
        tagNorm['app']          ||
        tagNorm['application']  ||
        tagNorm['app_name']     ||
        tagNorm['application_name'] ||
        tagNorm['project']      ||
        tagRaw['appcloud:app']  ||
        tagRaw['appcloud-app']  ||
        ''
      )

      // Component name
      const tagComponent = (
        tagNorm['component']      ||
        tagNorm['service']        ||
        tagNorm['service_name']   ||
        tagNorm['component_name'] ||
        tagNorm['module']         ||
        tagRaw['appcloud:component'] ||
        tagRaw['appcloud-component'] ||
        ''
      )

      // Owner / team
      const tagOwner = (
        tagNorm['owner']          ||
        tagNorm['team']           ||
        tagNorm['managed_by']     ||
        tagNorm['owned_by']       ||
        tagNorm['contact']        ||
        tagNorm['cost_centre']    ||
        tagNorm['costcentre']     ||
        ''
      )

      // Environment
      const tagEnv = (
        tagNorm['env']            ||
        tagNorm['environment']    ||
        tagNorm['stage']          ||
        tagNorm['deployment_env'] ||
        ''
      )

      // Tier
      const tagTier = tagNorm['tier'] || tagNorm['criticality'] || ''
      const infraNameLow = infra.name.toLowerCase()
      const infraType    = infra.resource_type?.toLowerCase() || ''

      // Resource type → likely Component type mapping
      const TYPE_MAP = {
        ec2_instance:    ['api','worker','app','server'],
        function:        ['api','worker','function','lambda'],
        rds_instance:    ['db','database','datastore'],
        app_service:     ['api','web','ui','frontend'],
        vm:              ['api','worker','app','server'],
        compute_instance:['api','worker','app','server'],
        cloud_run:       ['api','worker','service'],
        cloud_function:  ['api','worker','function'],
        app_insights:    ['monitoring','insights','observability','telemetry'],
        storage_account: ['storage','assets','datastore','blob'],
        service_bus:     ['queue','eventbus','messaging','bus'],
        key_vault:       ['secrets','security','vault'],
        s3_bucket:       ['storage','assets','datastore'],
        dynamodb:        ['db','database','datastore'],
        eks_cluster:     ['kubernetes','k8s','cluster'],
        aks_cluster:     ['kubernetes','k8s','cluster'],
        gke_cluster:     ['kubernetes','k8s','cluster'],
      }
      const likelyCompTypes = TYPE_MAP[infraType] || []

      const scored = []

      for (const app of apps) {
        const appNameLow   = app.name.toLowerCase()
        const appOwnerLow  = (app.owner || '').toLowerCase()
        const appEnvLow    = (app.environment || '').toLowerCase()

        // ── Score against the application ──────────────────────────────────
        let appScore = 0
        const appReasons = []

        if (tagApp && tagApp === appNameLow) {
          appScore += 40; appReasons.push(`tag "app" = "${app.name}" (exact)`)
        } else if (tagApp && (appNameLow.includes(tagApp) || tagApp.includes(appNameLow))) {
          appScore += 25; appReasons.push(`tag "app" ≈ "${app.name}" (partial)`)
        } else if (infraNameLow.includes(appNameLow) || appNameLow.split(' ').some(w => infraNameLow.includes(w) && w.length > 3)) {
          appScore += 10; appReasons.push(`name contains "${app.name}"`)
        }

        if (tagOwner && tagOwner === appOwnerLow) {
          appScore += 15; appReasons.push(`tag "owner" = "${app.owner}"`)
        } else if (tagOwner && (appOwnerLow.includes(tagOwner) || tagOwner.includes(appOwnerLow))) {
          appScore += 8; appReasons.push(`tag "owner" ≈ "${app.owner}"`)
        }

        if (tagEnv && appEnvLow && tagEnv === appEnvLow) {
          appScore += 10; appReasons.push(`tag "env" = "${app.environment}"`)
        }

        if (tagTier && app.tier && String(app.tier) === tagTier) {
          appScore += 5; appReasons.push(`tag "tier" = ${app.tier}`)
        }

        if (appScore < 10) continue  // Not related to this app at all

        // ── Score against each component within the app ────────────────────
        for (const comp of app.components) {
          let compScore = appScore
          const compReasons = [...appReasons]
          const compNameLow = comp.name.toLowerCase()
          const compTypeLow = (comp.type || '').toLowerCase()

          if (tagComponent && tagComponent === compNameLow) {
            compScore += 30; compReasons.push(`tag "component" = "${comp.name}" (exact)`)
          } else if (tagComponent && (compNameLow.includes(tagComponent) || tagComponent.includes(compNameLow))) {
            compScore += 20; compReasons.push(`tag "component" ≈ "${comp.name}" (partial)`)
          } else if (infraNameLow.includes(compNameLow) || compNameLow.split('-').some(w => infraNameLow.includes(w) && w.length > 2)) {
            compScore += 10; compReasons.push(`name contains "${comp.name}"`)
          }

          if (likelyCompTypes.includes(compTypeLow)) {
            compScore += 5; compReasons.push(`resource type suits ${comp.type} component`)
          }

          const finalScore = Math.min(100, compScore)
          if (finalScore >= parseInt(minScore)) {
            scored.push({
              infraId:       infra.id,
              componentId:   comp.id,
              componentName: comp.name,
              applicationId: app.id,
              applicationName: app.name,
              score:         finalScore,
              confidence:    finalScore >= 70 ? 'high' : finalScore >= 45 ? 'medium' : 'low',
              reasons:       compReasons,
            })
          }
        }

        // ── App-only suggestion (no component match) — suggest creating one ─
        if (!app.components.length || scored.filter(s => s.applicationId === app.id).length === 0) {
          const finalScore = Math.min(100, appScore)
          if (finalScore >= parseInt(minScore)) {
            scored.push({
              infraId:         infra.id,
              componentId:     null,
              componentName:   null,
              applicationId:   app.id,
              applicationName: app.name,
              score:           finalScore,
              confidence:      finalScore >= 70 ? 'high' : finalScore >= 45 ? 'medium' : 'low',
              reasons:         appReasons,
              noComponent:     true,
            })
          }
        }
      }

      // ── Enrich suggestions with action types ─────────────────────────────
      // action: 'link_component'     — component exists, just link it
      // action: 'create_component'   — app exists, component doesn't; create + link
      // action: 'create_application' — neither app nor component exist; create both

      const enriched = scored.map(s => {
        let action, actionLabel
        if (s.componentId) {
          action = 'link_component'
          actionLabel = `Link to ${s.componentName} in ${s.applicationName}`
        } else if (s.applicationId) {
          action = 'create_component'
          actionLabel = `Create component "${tagComponent || infra.name}" in ${s.applicationName}`
        } else {
          action = 'create_application'
          actionLabel = `Create application "${s.applicationName}" with component "${tagComponent || infra.name}"`
        }
        return { ...s, action, actionLabel }
      })

      // ── If tagApp doesn't match any existing app, suggest creating one ──
      if (tagApp) {
        const appExists = apps.some(a => a.name.toLowerCase() === tagApp)
        if (!appExists && !enriched.some(s => s.action === 'create_application')) {
          const newAppName  = tagApp.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
          const newCompName = tagComponent
            ? tagComponent.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
            : infra.name
          enriched.unshift({
            infraId:         infra.id,
            componentId:     null,
            componentName:   newCompName,
            applicationId:   null,
            applicationName: newAppName,
            score:           85,   // high confidence — exact tag match
            confidence:      'high',
            reasons:         [`tag "application" = "${newAppName}" — not yet in AppCloud`],
            action:          'create_application',
            actionLabel:     `Create application "${newAppName}" with component "${newCompName}"`,
            newAppName,
            newCompName,
            suggestedTier:   tagTier ? parseInt(tagTier) || 1 : 1,
            suggestedEnv:    tagEnv  || 'production',
            suggestedOwner:  tagOwner || '',
          })
        }
      }

      if (enriched.length > 0) {
        enriched.sort((a, b) => b.score - a.score)
        suggestions.push({
          infra: {
            id:           infra.id,
            name:         infra.name,
            provider:     infra.provider,
            resourceType: infra.resource_type,
            region:       infra.region,
            tags,
            raw,
          },
          suggestions:    enriched.slice(0, 4),
          topScore:       enriched[0].score,
          topConfidence:  enriched[0].confidence,
        })
      }
    }

    // Sort by top score descending
    suggestions.sort((a, b) => b.topScore - a.topScore)

    return {
      suggestions,
      diagnostic: {
        unmappedInfra:    infraRecords.length,
        applications:     apps.length,
        withSuggestions:  suggestions.length,
        belowThreshold:   infraRecords.length - suggestions.length,
        minScore:         parseInt(minScore),
        message: suggestions.length === 0
          ? `Found ${infraRecords.length} unmapped resource(s) and ${apps.length} application(s) but no matches above score ${minScore}. Try lowering the minimum score or adding appcloud:app / appcloud-app tags to your cloud resources.`
          : `Found ${suggestions.length} suggestion(s) from ${infraRecords.length} unmapped resource(s)`
      }
    }
  })

  // ── POST /discovery/suggest/apply ────────────────────────────────────────
  // Applies confirmed mapping suggestions — creates DEPLOYED_ON relationships.
  // Body: { mappings: [{ infraId, componentId }] }

  fastify.post('/suggest/apply', async (req, reply) => {
    const { mappings = [] } = req.body || {}
    if (!mappings.length) return reply.badRequest('mappings array is required')

    const results = { applied: 0, skipped: 0, errors: [] }

    for (const { infraId, componentId } of mappings) {
      if (!infraId || !componentId) { results.skipped++; continue }
      try {
        const r = await write(`
          MATCH (c:Component {id: $componentId}), (i:Infra {id: $infraId})
          MERGE (c)-[rel:DEPLOYED_ON]->(i)
          SET rel.source = 'auto-mapped', rel.mappedAt = datetime()
          RETURN c.name AS comp, i.name AS infra
        `, { componentId, infraId })
        if (r.length) {
          results.applied++
          audit(actor(req), 'create', 'Infra', infraId,
            r[0].get('infra'), { componentId, source: 'auto-mapped' })
        } else {
          results.errors.push(`${infraId}: component or infra not found`)
        }
      } catch (err) {
        results.errors.push(`${infraId}: ${err.message}`)
      }
    }

    return results
  })

  // ── POST /discovery/suggest/apply-all ────────────────────────────────────
  // Handles all action types from the suggest engine in a single call:
  //   link_component     — MERGE DEPLOYED_ON between existing component + infra
  //   create_component   — create Component under existing Application + link infra
  //   create_application — create Application + Component + link infra
  //
  // Body: { actions: [{ action, infraId, componentId?, applicationId?,
  //                     newAppName?, newCompName?, suggestedTier?,
  //                     suggestedEnv?, suggestedOwner? }] }

  fastify.post('/suggest/apply-all', async (req, reply) => {
    const { actions = [] } = req.body || {}
    if (!actions.length) return reply.badRequest('actions array is required')

    const results = {
      linked: 0, componentsCreated: 0, applicationsCreated: 0,
      skipped: 0, errors: []
    }

    for (const action of actions) {
      try {
        const { infraId } = action
        if (!infraId) { results.skipped++; continue }

        if (action.action === 'link_component') {
          // ── Link existing component to infra ──────────────────────────
          if (!action.componentId) { results.skipped++; continue }
          const r = await write(`
            MATCH (c:Component {id: $componentId}), (i:Infra {id: $infraId})
            MERGE (c)-[rel:DEPLOYED_ON]->(i)
            SET rel.source = 'auto-mapped', rel.mappedAt = datetime()
            RETURN c.name AS comp, i.name AS infra
          `, { componentId: action.componentId, infraId })
          if (r.length) {
            results.linked++
            audit(actor(req), 'create', 'Infra', infraId, r[0].get('infra'),
              { componentId: action.componentId, source: 'auto-mapped' })
          }

        } else if (action.action === 'create_component') {
          // ── Create component under existing app + link infra ──────────
          if (!action.applicationId || !action.newCompName) { results.skipped++; continue }
          const compName = action.newCompName
          const r = await write(`
            MATCH (a:Application {id: $appId}), (i:Infra {id: $infraId})
            CREATE (c:Component {
              id:          randomUUID(),
              name:        $compName,
              type:        $compType,
              description: $desc,
              createdAt:   datetime()
            })
            MERGE (a)-[:CONTAINS]->(c)
            MERGE (c)-[rel:DEPLOYED_ON]->(i)
            SET rel.source = 'auto-created', rel.mappedAt = datetime()
            RETURN c.id AS compId, c.name AS comp, i.name AS infra, a.name AS app
          `, {
            appId:   action.applicationId,
            infraId,
            compName,
            compType: action.suggestedType || 'service',
            desc:     `Auto-created from discovery: ${infraId}`,
          })
          if (r.length) {
            results.componentsCreated++
            results.linked++
            audit(actor(req), 'create', 'Component', r[0].get('compId'), compName,
              { applicationId: action.applicationId, source: 'auto-created', infraId })
          }

        } else if (action.action === 'create_application') {
          // ── Create app + component + link infra ───────────────────────
          if (!action.newAppName) { results.skipped++; continue }
          const appName  = action.newAppName
          const compName = action.newCompName || action.newAppName
          const r = await write(`
            MATCH (i:Infra {id: $infraId})
            CREATE (a:Application {
              id:           randomUUID(),
              name:         $appName,
              tier:         $tier,
              environment:  $env,
              owner:        $owner,
              createdAt:    datetime()
            })
            CREATE (c:Component {
              id:          randomUUID(),
              name:        $compName,
              type:        $compType,
              description: $desc,
              createdAt:   datetime()
            })
            MERGE (a)-[:CONTAINS]->(c)
            MERGE (c)-[rel:DEPLOYED_ON]->(i)
            SET rel.source = 'auto-created', rel.mappedAt = datetime()
            RETURN a.id AS appId, c.id AS compId,
                   a.name AS app, c.name AS comp, i.name AS infra
          `, {
            infraId,
            appName,
            compName,
            tier:     action.suggestedTier  || 1,
            env:      action.suggestedEnv   || 'production',
            owner:    action.suggestedOwner || '',
            compType: action.suggestedType  || 'service',
            desc:     `Auto-created from discovery: ${infraId}`,
          })
          if (r.length) {
            results.applicationsCreated++
            results.componentsCreated++
            results.linked++
            audit(actor(req), 'create', 'Application', r[0].get('appId'), appName,
              { source: 'auto-created', infraId })
            audit(actor(req), 'create', 'Component', r[0].get('compId'), compName,
              { applicationId: r[0].get('appId'), source: 'auto-created', infraId })
          }
        } else {
          results.skipped++
        }
      } catch (err) {
        results.errors.push(`${action.infraId}: ${err.message}`)
      }
    }

    return results
  })

  // ── GET /discovery/resources/:id/refresh ─────────────────────────────────
  // Re-fetches tags and metadata for a single Infra node from the cloud API.
  // This picks up tags that were added manually after the last scan.

  fastify.get('/resources/:id/refresh', async (req, reply) => {
    const records = await query(
      `MATCH (i:Infra {id: $id}) RETURN i`, { id: req.params.id }
    )
    if (!records.length) return reply.notFound('Infra node not found')
    const infra = props(records[0].get('i'))

    // Re-run a targeted scan for just this resource's cloud account
    // by triggering the appropriate provider scan with the node's cloud_id
    const provider = infra.provider
    const cloudId  = infra.cloud_id

    if (!provider || !cloudId) {
      return reply.badRequest('Cannot refresh — missing provider or cloud_id')
    }

    // Load the matching cloud account credentials
    const accounts = await loadAccounts(provider)
    if (!accounts.length) {
      return { refreshed: false, reason: 'No configured cloud account for ' + provider }
    }

    // For now return the stored data with a note — full per-resource refresh
    // requires provider-specific describe calls (future enhancement)
    return {
      refreshed: false,
      reason: 'Per-resource tag refresh requires a full scan — run discovery scan to pick up new tags',
      infra: {
        ...infra,
        tags: (() => { try { return JSON.parse(infra.tags || '{}') } catch { return {} } })(),
      },
      hint: `Run: POST /discovery/scan/${provider} to refresh all ${provider} resources`
    }
  })

  // ── GET /discovery/resources — all discovered Infra nodes ─────────────
  fastify.get('/resources', async (req) => {
    const { provider, resourceType, limit = 200 } = req.query
    const records = await query(`
      MATCH (i:Infra)
      WHERE i.source = 'discovery'
        ${provider     ? 'AND i.provider      = $provider'     : ''}
        ${resourceType ? 'AND i.resource_type = $resourceType' : ''}
      OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
      OPTIONAL MATCH (a:Application)-[:CONTAINS]->(c)
      RETURN i,
             collect(DISTINCT c.name) AS components,
             collect(DISTINCT a.name) AS applications
      ORDER BY i.provider, i.resource_type, i.name
      LIMIT toInteger($limit)
    `, { provider, resourceType, limit: parseInt(limit) })

    return records.map(r => {
      const node = props(r.get('i'))
      // Parse stored JSON strings so callers get real objects, not strings
      const parseProp = (val) => {
        if (!val) return {}
        if (typeof val === 'object') return val
        try { return JSON.parse(val) } catch { return {} }
      }
      return {
        ...node,
        tags:         parseProp(node.tags),
        raw:          parseProp(node.raw),
        components:   r.get('components').filter(Boolean),
        applications: r.get('applications').filter(Boolean),
        mapped:       r.get('components').filter(Boolean).length > 0,
      }
    })
  })

  // ── GET /discovery/summary — counts by provider + resource type ────────
  fastify.get('/summary', async () => {
    const records = await query(`
      MATCH (i:Infra) WHERE i.source = 'discovery'
      RETURN i.provider AS provider, i.resource_type AS type,
             count(i) AS cnt,
             count(CASE WHEN (:Component)-[:DEPLOYED_ON]->(i) THEN 1 END) AS mapped
      ORDER BY provider, type
    `)
    const byProvider = {}
    let total = 0, totalMapped = 0
    for (const r of records) {
      const p   = r.get('provider')
      const t   = r.get('type')
      const cnt = serialize(r.get('cnt'))
      const mp  = serialize(r.get('mapped'))
      if (!byProvider[p]) byProvider[p] = { total: 0, mapped: 0, types: {} }
      byProvider[p].types[t] = { count: cnt, mapped: mp }
      byProvider[p].total   += cnt
      byProvider[p].mapped  += mp
      total      += cnt
      totalMapped += mp
    }
    return { total, totalMapped, unmapped: total - totalMapped, byProvider }
  })

  // ── POST /discovery/link — link an Infra node to a Component ─────────
  fastify.post('/link', async (req, reply) => {
    const { infraId, componentId } = req.body
    if (!infraId || !componentId) return reply.badRequest('infraId and componentId required')
    await write(`
      MATCH (i:Infra {id: $infraId}), (c:Component {id: $componentId})
      MERGE (c)-[:DEPLOYED_ON]->(i)
    `, { infraId, componentId })
    audit(actor(req), 'link', 'Infra', infraId, infraId, { componentId })
    return { linked: true, infraId, componentId }
  })

  // ── DELETE /discovery/resources/:id — remove a discovered resource ────
  fastify.delete('/resources/:id', async (req, reply) => {
    const pre = await query(
      `MATCH (i:Infra {id:$id}) WHERE i.source = 'discovery'
       OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
       RETURN i.name AS name, i.provider AS provider,
              count(c) AS linkedComponents`,
      { id: req.params.id }
    )
    if (!pre.length) return reply.notFound('Resource not found')

    const linked = pre[0].get('linkedComponents')
    const count  = typeof linked === 'object' ? linked.toNumber?.() ?? 0 : linked ?? 0

    if (count > 0) {
      return reply.conflict(
        `Cannot delete — resource is linked to ${count} component(s). Unlink first.`
      )
    }

    await write(`
      MATCH (i:Infra {id: $id}) WHERE i.source = 'discovery'
      DETACH DELETE i
    `, { id: req.params.id })
    audit(actor(req), 'delete', 'Infra', req.params.id,
      pre[0]?.get('name') || req.params.id,
      { source: 'discovery', provider: pre[0]?.get('provider') })
    reply.code(204)
  })

  // ── DELETE /discovery/resources/bulk ─────────────────────────────────────
  // Delete multiple resources at once.
  // Skips any that are linked to components.
  // Body: { ids: [string] }

  fastify.post('/resources/bulk-delete', async (req, reply) => {
    const { ids = [] } = req.body || {}
    if (!ids.length) return reply.badRequest('ids array is required')

    const results = { deleted: 0, skipped: [], errors: [] }

    for (const id of ids) {
      try {
        const pre = await query(
          `MATCH (i:Infra {id:$id}) WHERE i.source = 'discovery'
           OPTIONAL MATCH (c:Component)-[:DEPLOYED_ON]->(i)
           RETURN i.name AS name, count(c) AS linkedComponents`,
          { id }
        )
        if (!pre.length) { results.skipped.push({ id, reason: 'not found' }); continue }

        const linked = pre[0].get('linkedComponents')
        const count  = typeof linked === 'object' ? linked.toNumber?.() ?? 0 : linked ?? 0

        if (count > 0) {
          results.skipped.push({
            id,
            name:   pre[0].get('name'),
            reason: `linked to ${count} component(s)`
          })
          continue
        }

        await write(
          `MATCH (i:Infra {id: $id}) WHERE i.source = 'discovery' DETACH DELETE i`,
          { id }
        )
        audit(actor(req), 'delete', 'Infra', id, pre[0].get('name'),
          { source: 'bulk-delete' })
        results.deleted++
      } catch (err) {
        results.errors.push({ id, error: err.message })
      }
    }

    return results
  })

  //bootstrap
  fastify.post('/bootstrap', async (req) => bootstrapDiscovery(fastify))
}