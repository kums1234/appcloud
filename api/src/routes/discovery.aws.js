/**
 * discovery.aws.js
 *
 * Primary AWS discovery via Config aggregator.
 *
 * Replaces the old per-service AWS SDK scanner (EC2, RDS, Lambda, EKS,
 * ECS, ELBv2, ElastiCache — 7 services × N regions) with a single
 * `SelectAggregateResourceConfig` query against a Configuration
 * Aggregator that already fans out across regions and accounts. The
 * scanner:
 *
 *   1. Pages through Config's SQL-flavoured query result
 *      (NextToken-based, max 100 rows per page) until exhausted.
 *   2. Upserts a (:Infra) node per row whose `resourceType` appears in
 *      CONFIG_TYPE_MAP.
 *   3. Emits structural `:CONNECTS_TO` edges for every unambiguous
 *      reference (Instance→Subnet/VPC/SG/ENI/Volume/IAMRole, etc.).
 *
 * Edge-write policy: single `:CONNECTS_TO` edge per logical
 * relationship, carrying `source`, `via`, `confidence`, `evidence`,
 * `discovered_at`, `last_seen`. No typed relationships.
 *
 * Prerequisites (documented in slice 4 secrets_setup.md update):
 *   - AWS Config enabled in every account in scope, recording the
 *     resource types we read.
 *   - A Configuration Aggregator exists; pass its name via
 *     `credentials.aggregatorName` or AWS_CONFIG_AGGREGATOR_NAME.
 *   - Calling principal has `config:SelectAggregateResourceConfig`.
 *
 * See `docs/aws-config-aggregator-coverage.md` for the per-type field
 * audit and edge inventory.
 */

import { upsertInfra } from './discovery.js'
import { parseAndValidateRegions } from '../utils/aws-regions.js'

// ─── Config resourceType → AppCloud resourceType ─────────────────────────────
const CONFIG_TYPE_MAP = {
  // Existing types (preserved with same cloud_id convention as old scanner)
  'AWS::EC2::Instance':                          'ec2_instance',
  'AWS::RDS::DBInstance':                        'rds_instance',
  'AWS::Lambda::Function':                       'function',
  'AWS::EKS::Cluster':                           'eks_cluster',
  'AWS::ECS::Cluster':                           'ecs_cluster',
  'AWS::ElasticLoadBalancingV2::LoadBalancer':   'load_balancer',
  'AWS::ElastiCache::CacheCluster':              'elasticache',
  // New types Config gives us "for free"
  'AWS::EC2::VPC':                               'vpc',
  'AWS::EC2::Subnet':                            'subnet',
  'AWS::EC2::SecurityGroup':                     'security_group',
  'AWS::EC2::NetworkInterface':                  'network_interface',
  'AWS::EC2::Volume':                            'ebs_volume',
  'AWS::EC2::InternetGateway':                   'internet_gateway',
  'AWS::EC2::NatGateway':                        'nat_gateway',
  'AWS::EC2::RouteTable':                        'route_table',
  'AWS::S3::Bucket':                             's3_bucket',
  'AWS::IAM::Role':                              'iam_role',
  'AWS::IAM::User':                              'iam_user',
  'AWS::DynamoDB::Table':                        'dynamodb',
  'AWS::SNS::Topic':                             'sns_topic',
  'AWS::SQS::Queue':                             'sqs_queue',
  'AWS::KMS::Key':                               'kms_key',
  'AWS::ApiGateway::RestApi':                    'api_gateway',
  'AWS::CloudFront::Distribution':               'cloudfront',
}

// ─── Structural via → confidence ─────────────────────────────────────────────
// Shared keys keep the same coupling weight across clouds; see
// VIA_TO_CONFIDENCE in discovery.azure.js / discovery.gcp.js.
const VIA_TO_CONFIDENCE = {
  'subnet':         65,
  'vpc':            65,
  'security-group': 55,
  'eni':            90,
  'disk':           88,
  'iam-role':       60,
}

// Config's per-page max
const CONFIG_PAGE_SIZE = 100

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normId(id = '') {
  return (id || '').toLowerCase().replace(/\/$/, '')
}

function awsTags(tags = []) {
  // Config returns tags either as [{key,value}] or as { key: value }; normalise
  if (Array.isArray(tags)) return tags.reduce((o, t) => { o[t.key || t.Key] = t.value || t.Value; return o }, {})
  if (tags && typeof tags === 'object') return tags
  return {}
}

// Per-type cloudId resolver. Preserves the existing scanner's cloud_id
// convention so MERGE doesn't duplicate nodes across the migration.
function cloudIdFromRow(resourceType, row) {
  const cfg = row.configuration || {}
  switch (resourceType) {
    case 'ec2_instance':  return row.resourceId           // i-xxx
    case 'elasticache':   return row.resourceId           // cluster id
    case 'rds_instance':  return cfg.dBInstanceArn || cfg.arn
    case 'function':      return cfg.functionArn  || cfg.arn
    case 'eks_cluster':   return cfg.arn
    case 'ecs_cluster':   return cfg.clusterArn   || cfg.arn
    case 'load_balancer': return cfg.loadBalancerArn || cfg.arn
    case 's3_bucket':     return cfg.arn || `arn:aws:s3:::${row.resourceName || row.resourceId}`
    case 'iam_role':      return cfg.arn || `arn:aws:iam::${row.accountId || ''}:role/${row.resourceName || row.resourceId}`
    case 'iam_user':      return cfg.arn || `arn:aws:iam::${row.accountId || ''}:user/${row.resourceName || row.resourceId}`
    default:              return cfg.arn || row.resourceId
  }
}

function nameFromRow(resourceType, row) {
  return row.resourceName
    || row.configuration?.functionName
    || row.configuration?.dBInstanceIdentifier
    || row.configuration?.loadBalancerName
    || row.resourceId
}

function statusFromRow(resourceType, cfg = {}) {
  switch (resourceType) {
    case 'ec2_instance':  return (cfg.state?.name || 'unknown').toLowerCase()
    case 'rds_instance':  return (cfg.dBInstanceStatus || 'unknown').toLowerCase()
    case 'function':      return 'active'
    case 'eks_cluster':   return (cfg.status || 'unknown').toLowerCase()
    case 'ecs_cluster':   return (cfg.status || 'unknown').toLowerCase()
    case 'load_balancer': return (cfg.state?.code || 'unknown').toLowerCase()
    case 'elasticache':   return (cfg.cacheClusterStatus || 'unknown').toLowerCase()
    case 'subnet':        return (cfg.state || 'unknown').toLowerCase()
    case 'vpc':           return (cfg.state || 'unknown').toLowerCase()
    default:              return 'unknown'
  }
}

function isPublic(resourceType, cfg = {}) {
  switch (resourceType) {
    case 'ec2_instance':  return !!cfg.publicIpAddress
    case 'rds_instance':  return !!cfg.publiclyAccessible
    case 'eks_cluster':   return !!cfg.resourcesVpcConfig?.endpointPublicAccess
    case 'load_balancer': return cfg.scheme === 'internet-facing'
    case 's3_bucket':
      // True public requires IAM bucket policy / ACL evaluation, which
      // Config provides under separate fields. Default false; revisit
      // in a future supplement layer (analog of GCP iam-policy).
      return false
    default:              return false
  }
}

// Extract the `raw` blob. Shape matches what the old per-SDK scanners
// emitted so promoted fields (discovery.schema.js RAW_PROMOTED_FIELDS.aws)
// keep working.
function extractRaw(resourceType, row) {
  const cfg = row.configuration || {}
  const common = {
    accountId:    row.accountId,
    awsRegion:    row.awsRegion,
    resourceType: row.resourceType,
  }
  switch (resourceType) {
    case 'ec2_instance':
      return {
        ...common,
        instanceType:    cfg.instanceType,
        imageId:         cfg.imageId,
        launchTime:      cfg.launchTime,
        privateIp:       cfg.privateIpAddress,
        publicIp:        cfg.publicIpAddress,
        vpcId:           cfg.vpcId,
        subnetId:        cfg.subnetId,
        availabilityZone: cfg.placement?.availabilityZone,
        platform:        cfg.platform || 'linux',
        architecture:    cfg.architecture,
        iamProfile:      cfg.iamInstanceProfile?.arn,
      }
    case 'rds_instance':
      return {
        ...common,
        engine:                  cfg.engine,
        engineVersion:           cfg.engineVersion,
        instanceClass:           cfg.dBInstanceClass,
        multiAZ:                 cfg.multiAZ,
        storageType:             cfg.storageType,
        allocatedStorage:        cfg.allocatedStorage,
        endpoint:                cfg.endpoint?.address,
        port:                    cfg.endpoint?.port,
        vpcId:                   cfg.dBSubnetGroup?.vpcId,
        autoMinorVersionUpgrade: cfg.autoMinorVersionUpgrade,
      }
    case 'function':
      return {
        ...common,
        runtime:     cfg.runtime,
        handler:     cfg.handler,
        memorySize:  cfg.memorySize,
        timeout:     cfg.timeout,
        codeSize:    cfg.codeSize,
        description: cfg.description,
        lastModified: cfg.lastModified,
        role:        cfg.role,
        vpcId:       cfg.vpcConfig?.vpcId,
        subnetIds:   cfg.vpcConfig?.subnetIds,
      }
    case 'eks_cluster':
      return {
        ...common,
        version:              cfg.version,
        endpoint:             cfg.endpoint,
        roleArn:              cfg.roleArn,
        vpcId:                cfg.resourcesVpcConfig?.vpcId,
        subnetIds:            cfg.resourcesVpcConfig?.subnetIds,
        securityGroupIds:     cfg.resourcesVpcConfig?.clusterSecurityGroupId,
        endpointPublicAccess: cfg.resourcesVpcConfig?.endpointPublicAccess,
        logging:              cfg.logging?.clusterLogging?.map(l => l.types).flat(),
      }
    case 'ecs_cluster':
      return {
        ...common,
        runningTasksCount:                 cfg.runningTasksCount,
        activeServicesCount:               cfg.activeServicesCount,
        registeredContainerInstancesCount: cfg.registeredContainerInstancesCount,
        capacityProviders:                 cfg.capacityProviders,
      }
    case 'load_balancer':
      return {
        ...common,
        type:             cfg.type,
        scheme:           cfg.scheme,
        dnsName:          cfg.dNSName,
        vpcId:            cfg.vpcId,
        ipAddressType:    cfg.ipAddressType,
        availabilityZones: cfg.availabilityZones?.map(z => z.zoneName),
      }
    case 'elasticache':
      return {
        ...common,
        engine:        cfg.engine,
        engineVersion: cfg.engineVersion,
        cacheNodeType: cfg.cacheNodeType,
        numCacheNodes: cfg.numCacheNodes,
        preferredAZ:   cfg.preferredAvailabilityZone,
        endpoint:      cfg.configurationEndpoint?.address,
      }
    case 'vpc':
      return { ...common, cidrBlock: cfg.cidrBlock, isDefault: cfg.isDefault }
    case 'subnet':
      return {
        ...common,
        vpcId:           cfg.vpcId,
        cidrBlock:       cfg.cidrBlock,
        availabilityZone: cfg.availabilityZone,
      }
    case 'security_group':
      return { ...common, vpcId: cfg.vpcId, groupName: cfg.groupName, description: cfg.description }
    case 'network_interface':
      return {
        ...common,
        subnetId:    cfg.subnetId,
        vpcId:       cfg.vpcId,
        privateIp:   cfg.privateIpAddress,
        groups:      cfg.groups?.map(g => g.groupId),
      }
    case 'ebs_volume':
      return { ...common, size: cfg.size, volumeType: cfg.volumeType, state: cfg.state, encrypted: cfg.encrypted }
    default:
      return common
  }
}

// Map AppCloud resourceType → stats counter key. Wire-compatible with
// the old per-service AWS scanner so response totaling keeps working.
function statsKeyFor(resourceType) {
  switch (resourceType) {
    case 'ec2_instance':  return 'ec2'
    case 'rds_instance':  return 'rds'
    case 'function':      return 'lambda'
    case 'eks_cluster':   return 'eks'
    case 'ecs_cluster':   return 'ecs'
    case 'load_balancer': return 'alb'
    case 'elasticache':   return 'elasticache'
    default:              return resourceType.replace(/_/g, '') + 'Count'
  }
}

// ─── Edge writer (single :CONNECTS_TO write per logical edge) ───────────────

async function writeStructuralEdge(write, { from, to, via, source, evidence }) {
  if (!from || !to || from === to) return 0
  const confidence = VIA_TO_CONFIDENCE[via] ?? 60
  const params = { from, to, via, source, confidence, evidence }
  try {
    await write(`
      MATCH (a:Infra {id: $from}), (b:Infra {id: $to})
      MERGE (a)-[r:CONNECTS_TO {via: $via}]->(b)
      ON CREATE SET r.discovered_at = datetime(),
                    r.source        = $source,
                    r.confidence    = $confidence,
                    r.evidence      = $evidence
      ON MATCH  SET r.last_seen     = datetime(),
                    r.source        = $source,
                    r.confidence    = $confidence,
                    r.evidence      = $evidence
    `, params)
    return 1
  } catch {
    return 0
  }
}

// Batched edge writer — one round-trip writes every link extracted
// from a single resource (e.g. an EC2 instance with 5 SGs + 3 ENIs + 4
// disks goes from 12 sequential queries to 1). Identical semantics to
// writeStructuralEdge per row; differs only in how many round-trips
// the driver does. confidence is pre-resolved per-via on the JS side
// so we don't have to push the table into Cypher.
async function writeStructuralEdgesBatch(write, links) {
  if (!links?.length) return 0
  // Drop self-loops + null endpoints so the MATCH below doesn't fail.
  const filtered = links
    .filter(l => l.from && l.to && l.from !== l.to)
    .map(l => ({ ...l, confidence: VIA_TO_CONFIDENCE[l.via] ?? 60 }))
  if (!filtered.length) return 0
  try {
    await write(`
      UNWIND $links AS link
      MATCH (a:Infra {id: link.from}), (b:Infra {id: link.to})
      MERGE (a)-[r:CONNECTS_TO {via: link.via}]->(b)
      ON CREATE SET r.discovered_at = datetime(),
                    r.source        = link.source,
                    r.confidence    = link.confidence,
                    r.evidence      = link.evidence
      ON MATCH  SET r.last_seen     = datetime(),
                    r.source        = link.source,
                    r.confidence    = link.confidence,
                    r.evidence      = link.evidence
    `, { links: filtered })
    return filtered.length
  } catch {
    return 0
  }
}

// EC2 instance profile ARN → IAM role ARN (used by emitStructuralEdges)
function instanceProfileToRoleArn(profileArn) {
  if (!profileArn || typeof profileArn !== 'string') return ''
  // arn:aws:iam::<acct>:instance-profile/<name> — assume role of same name.
  // Not always correct (a profile can wrap a different role name), but a
  // best-effort guess; if it doesn't resolve to an existing Role node the
  // edge is silently skipped, same as any other dangling reference.
  return profileArn.replace(':instance-profile/', ':role/')
}

// ─── Structural edge extraction ──────────────────────────────────────────────

async function emitStructuralEdges({ row, resourceType, resolve, write, stats }) {
  const fromCloudId = cloudIdFromRow(resourceType, row)
  const fromNid = resolve(fromCloudId) || resolve(row.resourceId)
  if (!fromNid) return
  const cfg = row.configuration || {}
  const source = 'aws-config-aggregator'

  // Collect every link emitted from this row's config; resolve cloud
  // refs to internal node ids, drop unresolvables. Then write the
  // whole batch in ONE Cypher round-trip via UNWIND. Previously each
  // link awaited its own MERGE, so a fully-wired EC2 instance (~12
  // edges across SGs / ENIs / disks) cost 12 sequential round-trips
  // per resource — at 100k AWS resources that's 1M+ trips.
  const links = []
  const link = (via, toRef, evidenceDetail) => {
    const toNid = resolve(toRef)
    if (!toNid) return
    const evidence = `Config: ${row.resourceType} ${via}${evidenceDetail ? ` ${evidenceDetail}` : ''}`
    links.push({ from: fromNid, to: toNid, via, source, evidence })
  }

  switch (resourceType) {
    case 'ec2_instance': {
      if (cfg.subnetId) link('subnet', cfg.subnetId)
      if (cfg.vpcId)    link('vpc',    cfg.vpcId)
      for (const sg of cfg.securityGroups || []) {
        if (sg.groupId) link('security-group', sg.groupId)
      }
      for (const eni of cfg.networkInterfaces || []) {
        if (eni.networkInterfaceId) link('eni', eni.networkInterfaceId)
      }
      for (const bdm of cfg.blockDeviceMappings || []) {
        if (bdm.ebs?.volumeId) link('disk', bdm.ebs.volumeId)
      }
      const roleArn = instanceProfileToRoleArn(cfg.iamInstanceProfile?.arn)
      if (roleArn) link('iam-role', roleArn)
      break
    }
    case 'network_interface': {
      if (cfg.subnetId) link('subnet', cfg.subnetId)
      if (cfg.vpcId)    link('vpc',    cfg.vpcId)
      for (const g of cfg.groups || []) {
        if (g.groupId) link('security-group', g.groupId)
      }
      break
    }
    case 'subnet': {
      if (cfg.vpcId) link('vpc', cfg.vpcId)
      break
    }
    case 'security_group': {
      if (cfg.vpcId) link('vpc', cfg.vpcId)
      break
    }
    case 'rds_instance': {
      if (cfg.dBSubnetGroup?.vpcId) link('vpc', cfg.dBSubnetGroup.vpcId)
      for (const sn of cfg.dBSubnetGroup?.subnets || []) {
        if (sn.subnetIdentifier) link('subnet', sn.subnetIdentifier)
      }
      break
    }
    case 'function': {
      if (cfg.role) link('iam-role', cfg.role)
      for (const sn of cfg.vpcConfig?.subnetIds || []) link('subnet', sn)
      for (const sg of cfg.vpcConfig?.securityGroupIds || []) link('security-group', sg)
      break
    }
    case 'eks_cluster': {
      const v = cfg.resourcesVpcConfig || {}
      if (v.vpcId) link('vpc', v.vpcId)
      for (const sn of v.subnetIds || []) link('subnet', sn)
      if (v.clusterSecurityGroupId) link('security-group', v.clusterSecurityGroupId)
      break
    }
    case 'load_balancer': {
      if (cfg.vpcId) link('vpc', cfg.vpcId)
      for (const az of cfg.availabilityZones || []) {
        if (az.subnetId) link('subnet', az.subnetId)
      }
      for (const sg of cfg.securityGroups || []) {
        if (typeof sg === 'string') link('security-group', sg)
        else if (sg?.groupId)        link('security-group', sg.groupId)
      }
      break
    }
    case 'nat_gateway': {
      if (cfg.subnetId) link('subnet', cfg.subnetId)
      if (cfg.vpcId)    link('vpc',    cfg.vpcId)
      break
    }
    case 'internet_gateway': {
      for (const att of cfg.attachments || []) {
        if (att.vpcId) link('vpc', att.vpcId)
      }
      break
    }
    // Other types currently emit no structural edges.
  }

  // One round-trip writes every collected link.
  if (links.length > 0) {
    const written = await writeStructuralEdgesBatch(write, links)
    stats.edges += written
  }
}

// ─── Config aggregator pagination ────────────────────────────────────────────

async function fetchAllAggregatedConfig({ client, aggregatorName, expression, log, stats }) {
  const all = []
  let nextToken
  let page = 0
  const { SelectAggregateResourceConfigCommand } = await import('@aws-sdk/client-config-service')

  // eslint-disable-next-line no-constant-condition
  while (true) {
    page++
    let res
    try {
      res = await client.send(new SelectAggregateResourceConfigCommand({
        Expression:                  expression,
        ConfigurationAggregatorName: aggregatorName,
        Limit:                       CONFIG_PAGE_SIZE,
        NextToken:                   nextToken,
      }))
    } catch (err) {
      stats.errors.push(`Config SelectAggregate page ${page}: ${err.message}`)
      log.warn?.(`[AWS Scanner] Config page ${page} failed: ${err.message}`)
      break
    }
    for (const r of res.Results || []) {
      try {
        all.push(JSON.parse(r))
      } catch (err) {
        stats.errors.push(`parse Config row: ${err.message}`)
      }
    }
    nextToken = res.NextToken
    if (!nextToken) break
  }

  log.info?.(`[AWS Scanner] Config returned ${all.length} resources (pages: ${page})`)
  return all
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * scanAWS({ credentials, regions, write, log, scanEpoch })
 *
 * Drop-in replacement for the old per-service AWS scanner. Returns a
 * stats object whose summable keys match the legacy shape so
 * orchestration response totaling keeps working:
 *   { ec2, rds, lambda, eks, ecs, alb, elasticache, <type>Count…,
 *     edges, errors, skipped, scanEpoch }
 *
 * `credentials.aggregatorName` (or AWS_CONFIG_AGGREGATOR_NAME) names
 * the Configuration Aggregator. `credentials.aggregatorRegion` (or
 * AWS_REGION) is the region the Config service is called in. `regions`
 * is honoured as an `awsRegion IN (…)` filter on the SQL — empty/
 * undefined means "all regions the aggregator covers".
 */
export async function scanAWS({ credentials, regions, write, log, scanEpoch }) {
  scanEpoch = scanEpoch || Date.now()

  const aggregatorName   = credentials?.aggregatorName   || process.env.AWS_CONFIG_AGGREGATOR_NAME
  const aggregatorRegion = credentials?.aggregatorRegion || process.env.AWS_REGION || 'us-east-1'
  if (!aggregatorName) {
    throw new Error(
      'AWS_CONFIG_AGGREGATOR_NAME (or credentials.aggregatorName) is required for AWS discovery via Config aggregator'
    )
  }

  const { ConfigServiceClient } = await import('@aws-sdk/client-config-service')
  const creds = (credentials?.accessKeyId && credentials?.secretAccessKey)
    ? {
        accessKeyId:     credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken:    credentials.sessionToken,
      }
    : undefined  // falls back to default credential chain
  const endpointOverride = process.env.AWS_ENDPOINT_URL || undefined
  const client = new ConfigServiceClient({
    region: aggregatorRegion,
    ...(creds            ? { credentials: creds }                       : {}),
    ...(endpointOverride ? { endpoint: endpointOverride }               : {}),
  })

  const stats = {
    ec2: 0, rds: 0, lambda: 0, eks: 0, ecs: 0, alb: 0, elasticache: 0,
    edges: 0, errors: [], skipped: [], scanEpoch,
  }

  // Build the SQL — region filter (if any) becomes a WHERE clause.
  // parseAndValidateRegions throws if anything fails the AWS region pattern,
  // which closes the (formerly) injection-prone interpolation below: every
  // string we emit between single quotes is now structurally constrained to
  // [a-z0-9-]+ and a digit, so apostrophes / semicolons / newlines can't
  // sneak in via the cloud_accounts.config.regions blob.
  const validatedRegions = parseAndValidateRegions(regions)
  const regionFilter = validatedRegions.length
    ? ` WHERE awsRegion IN (${validatedRegions.map(r => `'${r}'`).join(', ')})`
    : ''
  const expression = `
    SELECT resourceId, resourceName, resourceType, awsRegion, accountId,
           configuration, tags
    ${regionFilter}
  `.trim().replace(/\s+/g, ' ')

  // ── Pass 1: page through the aggregator ──────────────────────────────
  const allRows = await fetchAllAggregatedConfig({ client, aggregatorName, expression, log, stats })

  // ── Pass 2: upsert every recognised row; build cidToNid map keyed on
  //           BOTH cloudId AND raw resourceId so edges resolve regardless
  //           of which form the source field carries. ──
  const cidToNid = {}
  for (const row of allRows) {
    const resourceType = CONFIG_TYPE_MAP[row.resourceType]
    if (!resourceType) {
      stats.skipped.push(`unmapped type: ${row.resourceType}`)
      continue
    }
    const cloudId = cloudIdFromRow(resourceType, row)
    if (!cloudId) {
      stats.skipped.push(`no cloudId for ${row.resourceType} ${row.resourceId}`)
      continue
    }
    try {
      const nodeId = await upsertInfra(write, {
        cloudId,
        name:         nameFromRow(resourceType, row),
        provider:     'aws',
        resourceType,
        region:       row.awsRegion || '',
        status:       statusFromRow(resourceType, row.configuration),
        public:       isPublic(resourceType, row.configuration),
        tags:         awsTags(row.tags),
        raw:          extractRaw(resourceType, row),
        scanEpoch,
      })
      if (nodeId) {
        cidToNid[normId(cloudId)] = nodeId
        if (row.resourceId && normId(row.resourceId) !== normId(cloudId)) {
          cidToNid[normId(row.resourceId)] = nodeId
        }
      }
      const key = statsKeyFor(resourceType)
      stats[key] = (stats[key] || 0) + 1
    } catch (err) {
      stats.errors.push(`upsert ${cloudId}: ${err.message}`)
    }
  }

  // ── Pass 3: emit structural edges ────────────────────────────────────
  const resolve = (ref) => ref ? cidToNid[normId(ref)] : undefined
  for (const row of allRows) {
    const resourceType = CONFIG_TYPE_MAP[row.resourceType]
    if (!resourceType) continue
    try {
      await emitStructuralEdges({ row, resourceType, resolve, write, stats })
    } catch (err) {
      stats.errors.push(`edge ${row.resourceId}: ${err.message}`)
    }
  }

  log.info?.(
    `[AWS Scanner] Complete — nodes: ${
      Object.entries(stats)
        .filter(([k]) => !['edges','errors','skipped','scanEpoch'].includes(k))
        .reduce((s, [,v]) => s + (typeof v === 'number' ? v : 0), 0)
    }, edges: ${stats.edges}, errors: ${stats.errors.length}`
  )

  return stats
}

// Internal exports for tests.
export const __test__ = {
  CONFIG_TYPE_MAP,
  VIA_TO_CONFIDENCE,
  cloudIdFromRow,
  nameFromRow,
  statusFromRow,
  isPublic,
  extractRaw,
  statsKeyFor,
  instanceProfileToRoleArn,
  emitStructuralEdges,
  writeStructuralEdge,
}
