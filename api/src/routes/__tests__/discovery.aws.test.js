import { describe, test, expect, jest } from '@jest/globals'
import { __test__ } from '../discovery.aws.js'

const {
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
} = __test__

// ─── CONFIG_TYPE_MAP ──────────────────────────────────────────────────────────

describe('CONFIG_TYPE_MAP', () => {
  test('covers all 7 resource types the per-service scanner supported', () => {
    expect(CONFIG_TYPE_MAP['AWS::EC2::Instance']).toBe('ec2_instance')
    expect(CONFIG_TYPE_MAP['AWS::RDS::DBInstance']).toBe('rds_instance')
    expect(CONFIG_TYPE_MAP['AWS::Lambda::Function']).toBe('function')
    expect(CONFIG_TYPE_MAP['AWS::EKS::Cluster']).toBe('eks_cluster')
    expect(CONFIG_TYPE_MAP['AWS::ECS::Cluster']).toBe('ecs_cluster')
    expect(CONFIG_TYPE_MAP['AWS::ElasticLoadBalancingV2::LoadBalancer']).toBe('load_balancer')
    expect(CONFIG_TYPE_MAP['AWS::ElastiCache::CacheCluster']).toBe('elasticache')
  })
  test('expands coverage to types Config gives us for free', () => {
    expect(CONFIG_TYPE_MAP['AWS::EC2::VPC']).toBe('vpc')
    expect(CONFIG_TYPE_MAP['AWS::EC2::Subnet']).toBe('subnet')
    expect(CONFIG_TYPE_MAP['AWS::EC2::SecurityGroup']).toBe('security_group')
    expect(CONFIG_TYPE_MAP['AWS::EC2::NetworkInterface']).toBe('network_interface')
    expect(CONFIG_TYPE_MAP['AWS::EC2::Volume']).toBe('ebs_volume')
    expect(CONFIG_TYPE_MAP['AWS::S3::Bucket']).toBe('s3_bucket')
    expect(CONFIG_TYPE_MAP['AWS::IAM::Role']).toBe('iam_role')
    expect(CONFIG_TYPE_MAP['AWS::DynamoDB::Table']).toBe('dynamodb')
  })
})

// ─── VIA_TO_CONFIDENCE — cross-cloud invariants ──────────────────────────────

describe('VIA_TO_CONFIDENCE', () => {
  test('shared keys hold the same coupling weight across clouds', () => {
    expect(VIA_TO_CONFIDENCE['subnet']).toBe(65)
    expect(VIA_TO_CONFIDENCE['vpc']).toBe(65)
    expect(VIA_TO_CONFIDENCE['disk']).toBe(88)
    expect(VIA_TO_CONFIDENCE['iam-role']).toBe(60)
    expect(VIA_TO_CONFIDENCE['security-group']).toBe(55)
  })
  test('AWS-specific vias have appropriate weights', () => {
    expect(VIA_TO_CONFIDENCE['eni']).toBe(90)
  })
})

// ─── cloudIdFromRow — identity continuity with old scanner ───────────────────

describe('cloudIdFromRow', () => {
  test('ec2_instance: uses raw resourceId (i-xxx) — matches existing scanner cloudId', () => {
    expect(cloudIdFromRow('ec2_instance', { resourceId: 'i-1234abcd' })).toBe('i-1234abcd')
  })
  test('elasticache: uses raw resourceId (cluster id) — matches existing scanner cloudId', () => {
    expect(cloudIdFromRow('elasticache', { resourceId: 'my-redis-cluster' })).toBe('my-redis-cluster')
  })
  test('rds_instance: uses configuration.dBInstanceArn', () => {
    expect(cloudIdFromRow('rds_instance', {
      configuration: { dBInstanceArn: 'arn:aws:rds:us-east-1:111:db:mydb' },
    })).toBe('arn:aws:rds:us-east-1:111:db:mydb')
  })
  test('function: uses configuration.functionArn', () => {
    expect(cloudIdFromRow('function', {
      configuration: { functionArn: 'arn:aws:lambda:us-east-1:111:function:fn1' },
    })).toBe('arn:aws:lambda:us-east-1:111:function:fn1')
  })
  test('eks_cluster: uses configuration.arn', () => {
    expect(cloudIdFromRow('eks_cluster', {
      configuration: { arn: 'arn:aws:eks:us-east-1:111:cluster/c1' },
    })).toBe('arn:aws:eks:us-east-1:111:cluster/c1')
  })
  test('ecs_cluster: uses configuration.clusterArn', () => {
    expect(cloudIdFromRow('ecs_cluster', {
      configuration: { clusterArn: 'arn:aws:ecs:us-east-1:111:cluster/c1' },
    })).toBe('arn:aws:ecs:us-east-1:111:cluster/c1')
  })
  test('load_balancer: uses configuration.loadBalancerArn', () => {
    expect(cloudIdFromRow('load_balancer', {
      configuration: { loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:111:loadbalancer/app/lb/abc' },
    })).toBe('arn:aws:elasticloadbalancing:us-east-1:111:loadbalancer/app/lb/abc')
  })
  test('s3_bucket: builds an arn when absent', () => {
    expect(cloudIdFromRow('s3_bucket', { resourceName: 'my-bucket' })).toBe('arn:aws:s3:::my-bucket')
  })
  test('iam_role: builds arn from accountId + resourceName when absent', () => {
    expect(cloudIdFromRow('iam_role', { accountId: '111', resourceName: 'my-role' }))
      .toBe('arn:aws:iam::111:role/my-role')
  })
  test('unknown / new types fall back to configuration.arn or resourceId', () => {
    expect(cloudIdFromRow('subnet', { resourceId: 'subnet-xxx', configuration: {} })).toBe('subnet-xxx')
    expect(cloudIdFromRow('subnet', { resourceId: 'subnet-xxx', configuration: { arn: 'arn:aws:ec2:us-east-1:111:subnet/subnet-xxx' } }))
      .toBe('arn:aws:ec2:us-east-1:111:subnet/subnet-xxx')
  })
})

// ─── statusFromRow / isPublic ─────────────────────────────────────────────────

describe('statusFromRow', () => {
  test('ec2_instance: lowercases state.name', () => {
    expect(statusFromRow('ec2_instance', { state: { name: 'RUNNING' } })).toBe('running')
  })
  test('rds_instance: dBInstanceStatus → lowercase', () => {
    expect(statusFromRow('rds_instance', { dBInstanceStatus: 'AVAILABLE' })).toBe('available')
  })
  test('function: defaults to "active" (Config does not surface state)', () => {
    expect(statusFromRow('function', {})).toBe('active')
  })
  test('eks_cluster: lowercases status', () => {
    expect(statusFromRow('eks_cluster', { status: 'ACTIVE' })).toBe('active')
  })
  test('load_balancer: lowercases state.code', () => {
    expect(statusFromRow('load_balancer', { state: { code: 'ACTIVE' } })).toBe('active')
  })
})

describe('isPublic', () => {
  test('ec2_instance: gated by publicIpAddress', () => {
    expect(isPublic('ec2_instance', { publicIpAddress: '1.2.3.4' })).toBe(true)
    expect(isPublic('ec2_instance', { publicIpAddress: undefined })).toBe(false)
  })
  test('rds_instance: gated by publiclyAccessible', () => {
    expect(isPublic('rds_instance', { publiclyAccessible: true })).toBe(true)
    expect(isPublic('rds_instance', { publiclyAccessible: false })).toBe(false)
  })
  test('eks_cluster: gated by resourcesVpcConfig.endpointPublicAccess', () => {
    expect(isPublic('eks_cluster', { resourcesVpcConfig: { endpointPublicAccess: true } })).toBe(true)
    expect(isPublic('eks_cluster', { resourcesVpcConfig: { endpointPublicAccess: false } })).toBe(false)
  })
  test('load_balancer: gated by scheme=internet-facing', () => {
    expect(isPublic('load_balancer', { scheme: 'internet-facing' })).toBe(true)
    expect(isPublic('load_balancer', { scheme: 'internal' })).toBe(false)
  })
  test('s3_bucket: stays false until a future IAM-policy supplement runs', () => {
    expect(isPublic('s3_bucket', {})).toBe(false)
  })
})

// ─── extractRaw — promoted-field continuity ──────────────────────────────────

describe('extractRaw', () => {
  test('ec2_instance preserves all promoted fields', () => {
    const row = {
      configuration: {
        instanceType:    't3.medium',
        imageId:         'ami-1',
        privateIpAddress:'10.0.0.5',
        publicIpAddress: '54.1.2.3',
        vpcId:           'vpc-1',
        subnetId:        'subnet-1',
        placement:       { availabilityZone: 'us-east-1a' },
        platform:        'linux',
        architecture:    'x86_64',
        iamInstanceProfile: { arn: 'arn:aws:iam::111:instance-profile/foo' },
        launchTime:      '2024-01-01T00:00:00Z',
      },
    }
    const raw = extractRaw('ec2_instance', row)
    expect(raw.instanceType).toBe('t3.medium')
    expect(raw.privateIp).toBe('10.0.0.5')
    expect(raw.publicIp).toBe('54.1.2.3')
    expect(raw.vpcId).toBe('vpc-1')
    expect(raw.subnetId).toBe('subnet-1')
    expect(raw.iamProfile).toBe('arn:aws:iam::111:instance-profile/foo')
  })
  test('rds_instance preserves vpcId via DBSubnetGroup nesting', () => {
    const raw = extractRaw('rds_instance', { configuration: {
      engine: 'postgres', engineVersion: '14.10', dBInstanceClass: 'db.t3.micro',
      multiAZ: true, storageType: 'gp3', allocatedStorage: 20,
      endpoint: { address: 'db.amazonaws.com', port: 5432 },
      dBSubnetGroup: { vpcId: 'vpc-rds' },
    } })
    expect(raw.engine).toBe('postgres')
    expect(raw.endpoint).toBe('db.amazonaws.com')
    expect(raw.port).toBe(5432)
    expect(raw.vpcId).toBe('vpc-rds')
  })
})

// ─── statsKeyFor — wire-compat with old per-service scanner ──────────────────

describe('statsKeyFor', () => {
  test('legacy types map to legacy stats keys (ec2/rds/lambda/eks/ecs/alb/elasticache)', () => {
    expect(statsKeyFor('ec2_instance')).toBe('ec2')
    expect(statsKeyFor('rds_instance')).toBe('rds')
    expect(statsKeyFor('function')).toBe('lambda')
    expect(statsKeyFor('eks_cluster')).toBe('eks')
    expect(statsKeyFor('ecs_cluster')).toBe('ecs')
    expect(statsKeyFor('load_balancer')).toBe('alb')
    expect(statsKeyFor('elasticache')).toBe('elasticache')
  })
  test('new types use <type>Count pattern', () => {
    expect(statsKeyFor('vpc')).toBe('vpcCount')
    expect(statsKeyFor('subnet')).toBe('subnetCount')
    expect(statsKeyFor('s3_bucket')).toBe('s3bucketCount')
    expect(statsKeyFor('iam_role')).toBe('iamroleCount')
  })
})

// ─── instanceProfileToRoleArn ────────────────────────────────────────────────

describe('instanceProfileToRoleArn', () => {
  test('translates instance-profile arn → role arn (best-effort, same-name assumption)', () => {
    expect(instanceProfileToRoleArn('arn:aws:iam::111:instance-profile/MyAppRole'))
      .toBe('arn:aws:iam::111:role/MyAppRole')
  })
  test('returns empty for invalid input', () => {
    expect(instanceProfileToRoleArn(undefined)).toBe('')
    expect(instanceProfileToRoleArn(null)).toBe('')
    expect(instanceProfileToRoleArn(42)).toBe('')
  })
})

// ─── writeStructuralEdge — single :CONNECTS_TO write ────────────────────────

describe('writeStructuralEdge', () => {
  test('writes a single :CONNECTS_TO edge with traceability properties', async () => {
    const calls = []
    const write = jest.fn(async (cypher, params) => { calls.push({ cypher, params }) })
    const n = await writeStructuralEdge(write, {
      from: 'A', to: 'B', via: 'subnet', source: 'aws-config-aggregator', evidence: 'Config: ... subnet',
    })
    expect(n).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].cypher).toMatch(/:CONNECTS_TO/)
    expect(calls[0].cypher).not.toMatch(/:CONNECTED_TO/)
    expect(calls[0].params.confidence).toBe(65)
  })
  test('skips self-edges and missing endpoints', async () => {
    const write = jest.fn()
    expect(await writeStructuralEdge(write, { from: 'X', to: 'X', via: 'vpc', source: 's' })).toBe(0)
    expect(await writeStructuralEdge(write, { from: '',  to: 'B', via: 'vpc', source: 's' })).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })
})

// ─── emitStructuralEdges ─────────────────────────────────────────────────────

// emitStructuralEdges now writes ALL links from one resource in a
// single batched UNWIND per call (params.links is an array). Tests
// flatten the batch back to per-edge entries so per-via assertions
// stay readable.
function collectBatch(written, _, params) {
  if (Array.isArray(params?.links)) {
    for (const l of params.links) {
      written.push({ via: l.via, source: l.source, evidence: l.evidence })
    }
  } else if (params?.via) {
    written.push({ via: params.via, source: params.source, evidence: params.evidence })
  }
}

describe('emitStructuralEdges — ec2_instance', () => {
  test('emits subnet/vpc/security-group/eni/disk/iam-role with expected vias', async () => {
    const written = []
    const write = jest.fn(async (sql, params) => collectBatch(written, sql, params))
    const stats = { edges: 0, errors: [] }
    const cidToNid = {
      'i-1234':                                                     'nid-vm',
      'subnet-1':                                                   'nid-subnet',
      'vpc-1':                                                      'nid-vpc',
      'sg-1':                                                       'nid-sg',
      'eni-1':                                                      'nid-eni',
      'vol-1':                                                      'nid-vol',
      'arn:aws:iam::111:role/myrole':                               'nid-role',
    }
    const resolve = (ref) => ref ? cidToNid[(ref || '').toLowerCase()] : undefined
    const row = {
      resourceType: 'AWS::EC2::Instance',
      resourceId:   'i-1234',
      configuration: {
        subnetId: 'subnet-1',
        vpcId:    'vpc-1',
        securityGroups: [{ groupId: 'sg-1' }],
        networkInterfaces: [{ networkInterfaceId: 'eni-1' }],
        blockDeviceMappings: [{ ebs: { volumeId: 'vol-1' } }],
        iamInstanceProfile: { arn: 'arn:aws:iam::111:instance-profile/myrole' },
      },
    }
    await emitStructuralEdges({ row, resourceType: 'ec2_instance', resolve, write, stats })
    // 6 logical edges × 1 cypher write each = 6 cypher writes
    expect(written).toHaveLength(6)
    const vias = [...new Set(written.map(w => w.via))].sort()
    expect(vias).toEqual(['disk', 'eni', 'iam-role', 'security-group', 'subnet', 'vpc'])
    expect(written.every(w => w.source === 'aws-config-aggregator')).toBe(true)
    expect(written.every(w => w.evidence.startsWith('Config: AWS::EC2::Instance'))).toBe(true)
    expect(stats.edges).toBe(6)
  })
})

describe('emitStructuralEdges — subnet/security_group → vpc', () => {
  test('subnet emits exactly one vpc edge', async () => {
    const written = []
    const write = jest.fn(async (sql, params) => {
      if (Array.isArray(params?.links)) for (const l of params.links) written.push(l.via)
      else if (params?.via) written.push(params.via)
    })
    const stats = { edges: 0, errors: [] }
    const cidToNid = {
      'arn:aws:ec2:us-east-1:111:subnet/subnet-1': 'nid-subnet',
      'subnet-1':                                  'nid-subnet',
      'vpc-1':                                     'nid-vpc',
    }
    const resolve = (ref) => ref ? cidToNid[(ref || '').toLowerCase()] : undefined
    const row = {
      resourceType: 'AWS::EC2::Subnet',
      resourceId:   'subnet-1',
      configuration: { arn: 'arn:aws:ec2:us-east-1:111:subnet/subnet-1', vpcId: 'vpc-1' },
    }
    await emitStructuralEdges({ row, resourceType: 'subnet', resolve, write, stats })
    expect(stats.edges).toBe(1)
    expect([...new Set(written)]).toEqual(['vpc'])
  })
})

describe('emitStructuralEdges — function (Lambda) — VPC config + role', () => {
  test('emits subnet/security-group/iam-role from vpcConfig and role fields', async () => {
    const written = []
    const write = jest.fn(async (sql, params) => {
      if (Array.isArray(params?.links)) for (const l of params.links) written.push(l.via)
      else if (params?.via) written.push(params.via)
    })
    const stats = { edges: 0, errors: [] }
    const cidToNid = {
      'arn:aws:lambda:us-east-1:111:function:fn1': 'nid-fn',
      'subnet-2':                                  'nid-subnet',
      'sg-2':                                      'nid-sg',
      'arn:aws:iam::111:role/lambdarole':          'nid-role',
    }
    const resolve = (ref) => ref ? cidToNid[(ref || '').toLowerCase()] : undefined
    const row = {
      resourceType: 'AWS::Lambda::Function',
      resourceId:   'fn1',
      configuration: {
        functionArn: 'arn:aws:lambda:us-east-1:111:function:fn1',
        role:        'arn:aws:iam::111:role/lambdarole',
        vpcConfig:   { subnetIds: ['subnet-2'], securityGroupIds: ['sg-2'] },
      },
    }
    await emitStructuralEdges({ row, resourceType: 'function', resolve, write, stats })
    const vias = [...new Set(written)].sort()
    expect(vias).toEqual(['iam-role', 'security-group', 'subnet'])
    expect(stats.edges).toBe(3)
  })
})

describe('emitStructuralEdges — eks_cluster', () => {
  test('emits vpc/subnet/security-group from resourcesVpcConfig', async () => {
    const written = []
    const write = jest.fn(async (_, params) => { written.push(params.via) })
    const stats = { edges: 0, errors: [] }
    const cidToNid = {
      'arn:aws:eks:us-east-1:111:cluster/c1': 'nid-c1',
      'vpc-eks':  'nid-vpc',
      'subnet-a': 'nid-sa',
      'subnet-b': 'nid-sb',
      'sg-eks':   'nid-sg',
    }
    const resolve = (ref) => ref ? cidToNid[(ref || '').toLowerCase()] : undefined
    const row = {
      resourceType: 'AWS::EKS::Cluster',
      resourceId:   'c1',
      configuration: {
        arn: 'arn:aws:eks:us-east-1:111:cluster/c1',
        resourcesVpcConfig: {
          vpcId:                  'vpc-eks',
          subnetIds:              ['subnet-a', 'subnet-b'],
          clusterSecurityGroupId: 'sg-eks',
        },
      },
    }
    await emitStructuralEdges({ row, resourceType: 'eks_cluster', resolve, write, stats })
    expect(stats.edges).toBe(4) // vpc + 2 subnets + sg
  })
})
