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
    ecs: 0, alb: 0, elasticache: 0, errors: [],
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
    } catch (e) { stats.errors.push(`EC2/${region}: ${e.message}`) }

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
    } catch (e) { stats.errors.push(`RDS/${region}: ${e.message}`) }

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
    } catch (e) { stats.errors.push(`Lambda/${region}: ${e.message}`) }

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
    } catch (e) { stats.errors.push(`EKS/${region}: ${e.message}`) }

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
    } catch (e) { stats.errors.push(`ECS/${region}: ${e.message}`) }

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
    } catch (e) { stats.errors.push(`ALB/${region}: ${e.message}`) }

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
    } catch (e) { stats.errors.push(`ElastiCache/${region}: ${e.message}`) }
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

  const cred = credentials?.clientId
    ? new ClientSecretCredential(
        credentials.tenantId,
        credentials.clientId,
        credentials.clientSecret
      )
    : new DefaultAzureCredential()

  const subId = subscriptionId || process.env.AZURE_SUBSCRIPTION_ID
  if (!subId) throw new Error('AZURE_SUBSCRIPTION_ID is required for Azure discovery')

  const stats = { vms: 0, aks: 0, sql: 0, appService: 0, redis: 0, vnet: 0, errors: [] }

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
  } catch (e) { stats.errors.push(`AzureVMs: ${e.message}`) }

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
  } catch (e) { stats.errors.push(`AzureAKS: ${e.message}`) }

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
  } catch (e) { stats.errors.push(`AzureSQL: ${e.message}`) }

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
  } catch (e) { stats.errors.push(`AzureAppService: ${e.message}`) }

  // ── Redis Caches ──────────────────────────────────────────────────────
  try {
    const redis = new RedisManagementClient(cred, subId)
    for await (const cache of redis.redis.list()) {
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
          sku:                 `${cache.sku?.name} ${cache.sku?.family}${cache.sku?.capacity}`,
          hostName:            cache.hostName,
          port:                cache.port,
          sslPort:             cache.sslPort,
          redisVersion:        cache.redisVersion,
          minimumTlsVersion:   cache.minimumTlsVersion,
          enableNonSslPort:    cache.enableNonSslPort,
        },
      })
      stats.redis++
    }
  } catch (e) { stats.errors.push(`AzureRedis: ${e.message}`) }

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
  } catch (e) { stats.errors.push(`AzureVNet: ${e.message}`) }

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

  // ── GET /discovery/accounts — list saved cloud accounts ───────────────
  fastify.get('/accounts', async () => {
    const records = await query(`
      MATCH (a:CloudAccount)
      RETURN a ORDER BY a.provider, a.name
    `)
    return records.map(r => props(r.get('a')))
  })

  // ── POST /discovery/accounts — save a cloud account config ────────────
  fastify.post('/accounts', async (req, reply) => {
    const { name, provider, config = {} } = req.body
    if (!name || !provider) return reply.badRequest('name and provider are required')
    const validProviders = ['aws', 'azure', 'gcp']
    if (!validProviders.includes(provider)) return reply.badRequest(`provider must be one of: ${validProviders.join(', ')}`)

    // Store only non-secret config fields; secrets stay in env vars
    const safeConfig = { ...config }
    delete safeConfig.secretAccessKey
    delete safeConfig.clientSecret
    delete safeConfig.private_key

    const records = await write(`
      MERGE (a:CloudAccount { id: $id })
      SET a.name       = $name,
          a.provider   = $provider,
          a.config     = $config,
          a.updatedAt  = datetime()
      RETURN a
    `, {
      id:       `${provider}:${name}`,
      name,
      provider,
      config:   JSON.stringify(safeConfig),
    })
    reply.code(201)
    return props(records[0].get('a'))
  })

  // ── DELETE /discovery/accounts/:id ────────────────────────────────────
  fastify.delete('/accounts/:id', async (req, reply) => {
    await write(`MATCH (a:CloudAccount {id:$id}) DELETE a`, { id: req.params.id })
    reply.code(204)
  })

  // ── POST /discovery/scan/aws ──────────────────────────────────────────
  fastify.post('/scan/aws', async (req, reply) => {
    const {
      regions = ['us-east-1'],
      credentials,   // { accessKeyId, secretAccessKey, sessionToken? }
    } = req.body || {}

    fastify.log.info(`[Discovery] Starting AWS scan for regions: ${regions.join(', ')}`)
    const startedAt = Date.now()

    let stats
    try {
      stats = await scanAWS({ credentials, regions, write, log: fastify.log })
    } catch (err) {
      fastify.log.error(`[Discovery] AWS scan failed: ${err.message}`)
      return reply.internalServerError(`AWS scan failed: ${err.message}`)
    }

    const duration = Date.now() - startedAt
    const total = Object.entries(stats)
      .filter(([k]) => k !== 'errors')
      .reduce((s, [, v]) => s + v, 0)

    fastify.log.info(`[Discovery] AWS scan complete: ${total} resources in ${duration}ms`)
    return { provider: 'aws', regions, duration, total, breakdown: stats, completedAt: new Date().toISOString() }
  })

  // ── POST /discovery/scan/azure ────────────────────────────────────────
  fastify.post('/scan/azure', async (req, reply) => {
    const {
      subscriptionId,
      credentials,   // { tenantId, clientId, clientSecret } — optional if using env/MSI
    } = req.body || {}

    fastify.log.info('[Discovery] Starting Azure scan')
    const startedAt = Date.now()

    let stats
    try {
      stats = await scanAzure({ credentials, subscriptionId, write, log: fastify.log })
    } catch (err) {
      fastify.log.error(`[Discovery] Azure scan failed: ${err.message}`)
      return reply.internalServerError(`Azure scan failed: ${err.message}`)
    }

    const duration = Date.now() - startedAt
    const total = Object.entries(stats)
      .filter(([k]) => k !== 'errors')
      .reduce((s, [, v]) => s + v, 0)

    return { provider: 'azure', subscriptionId, duration, total, breakdown: stats, completedAt: new Date().toISOString() }
  })

  // ── POST /discovery/scan/gcp ──────────────────────────────────────────
  fastify.post('/scan/gcp', async (req, reply) => {
    const {
      projectId,
      credentials,   // service account JSON object — optional if using ADC
    } = req.body || {}

    fastify.log.info(`[Discovery] Starting GCP scan for project: ${projectId || process.env.GCP_PROJECT_ID}`)
    const startedAt = Date.now()

    let stats
    try {
      stats = await scanGCP({ credentials, projectId, write, log: fastify.log })
    } catch (err) {
      fastify.log.error(`[Discovery] GCP scan failed: ${err.message}`)
      return reply.internalServerError(`GCP scan failed: ${err.message}`)
    }

    const duration = Date.now() - startedAt
    const total = Object.entries(stats)
      .filter(([k]) => k !== 'errors')
      .reduce((s, [, v]) => s + v, 0)

    return { provider: 'gcp', projectId, duration, total, breakdown: stats, completedAt: new Date().toISOString() }
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
    return { linked: true, infraId, componentId }
  })

  // ── DELETE /discovery/resources/:id — remove a discovered resource ────
  fastify.delete('/resources/:id', async (req, reply) => {
    await write(`
      MATCH (i:Infra {id: $id}) WHERE i.source = 'discovery'
      DETACH DELETE i
    `, { id: req.params.id })
    reply.code(204)
  })
}