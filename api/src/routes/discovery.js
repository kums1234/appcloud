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
  const records = await write(`
    MERGE (i:Infra { cloud_id: $cloudId })
    SET i.id           = COALESCE(i.id, randomUUID()),
        i.name         = $name,
        i.provider     = $provider,
        i.resource_type = $resourceType,
        i.region       = $region,
        i.status       = $status,
        i.public       = $public,
        i.source       = 'discovery',
        i.tags         = $tags,
        i.raw          = $raw,
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
    tags:         JSON.stringify(fields.tags || {}),
    raw:          JSON.stringify(fields.raw  || {}),
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
    return { results, errors, completedAt: new Date().toISOString() }
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

    return records.map(r => ({
      ...props(r.get('i')),
      components:   r.get('components').filter(Boolean),
      applications: r.get('applications').filter(Boolean),
      mapped:       r.get('components').filter(Boolean).length > 0,
    }))
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
      `MATCH (i:Infra {id:$id}) WHERE i.source = 'discovery' RETURN i.name AS name, i.provider AS provider`,
      { id: req.params.id }
    )
    await write(`
      MATCH (i:Infra {id: $id}) WHERE i.source = 'discovery'
      DETACH DELETE i
    `, { id: req.params.id })
    audit(actor(req), 'delete', 'Infra', req.params.id,
      pre[0]?.get('name') || req.params.id,
      { source: 'discovery', provider: pre[0]?.get('provider') })
    reply.code(204)
  })
}