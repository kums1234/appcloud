# AWS Config aggregator — coverage audit (slice 3)

This doc is the auditable record of what moves from per-service AWS SDK
calls (`@aws-sdk/client-ec2`, `client-rds`, `client-lambda`,
`client-eks`, `client-ecs`, `client-elastic-load-balancing-v2`,
`client-elasticache`) to a single AWS Config aggregator query, plus the
decisions made for any field Config does not surface directly.

Scope: the AWS scanner block in `api/src/routes/discovery.js` (the
7-product per-region per-SDK loops).

AWS Config aggregator's `SelectAggregateResourceConfig` accepts a
SQL-flavoured query against a configuration aggregator that already
fans out across regions and accounts. Each result row carries the
resource's full Config snapshot under `configuration` — the same shape
the per-service `Describe*` SDK calls return today, just routed through
one aggregator query instead of seven (× regions).

## Prerequisites (documented in slice 4 secrets_setup.md update)

- AWS Config must be **enabled in every account** in scope, with each
  recording configuration items for the resource types we care about.
- A **Configuration Aggregator** must exist (Organization-wide or
  account-list) and its name passed in via `credentials.aggregatorName`
  or `AWS_CONFIG_AGGREGATOR_NAME`.
- The calling principal needs `config:SelectAggregateResourceConfig` on
  that aggregator.
- `credentials.aggregatorRegion` (or `AWS_REGION`) names the region
  where the aggregator lives — Config is region-pinned even though the
  aggregated view is multi-region.

## Resource types scanned today

| Type (AppCloud) | Config resourceType | Source today | Config coverage | Decision |
|---|---|---|---|---|
| `ec2_instance` | `AWS::EC2::Instance` | `@aws-sdk/client-ec2` `paginateDescribeInstances` | full (`configuration.instanceType`, `imageId`, `privateIpAddress`, `publicIpAddress`, `vpcId`, `subnetId`, `placement.availabilityZone`, `platform`, `architecture`, `iamInstanceProfile.arn`, `launchTime`) | replace with Config |
| `rds_instance` | `AWS::RDS::DBInstance` | `@aws-sdk/client-rds` | full (`configuration.engine`, `engineVersion`, `dBInstanceClass`, `multiAZ`, `storageType`, `allocatedStorage`, `endpoint.{address,port}`, `dBSubnetGroup.vpcId`, `publiclyAccessible`, `autoMinorVersionUpgrade`) | replace with Config |
| `function` | `AWS::Lambda::Function` | `@aws-sdk/client-lambda` | full (`configuration.runtime`, `handler`, `memorySize`, `timeout`, `codeSize`, `description`, `lastModified`, `role`, `vpcConfig.{vpcId,subnetIds,securityGroupIds}`) | replace with Config |
| `eks_cluster` | `AWS::EKS::Cluster` | `@aws-sdk/client-eks` (List + Describe) | full (`configuration.version`, `endpoint`, `roleArn`, `resourcesVpcConfig.{vpcId,subnetIds,clusterSecurityGroupId,endpointPublicAccess}`, `logging.clusterLogging[].types`) | replace with Config — also drops the per-cluster Describe round-trip |
| `ecs_cluster` | `AWS::ECS::Cluster` | `@aws-sdk/client-ecs` | full (`configuration.runningTasksCount`, `activeServicesCount`, `registeredContainerInstancesCount`, `capacityProviders`) | replace with Config |
| `load_balancer` | `AWS::ElasticLoadBalancingV2::LoadBalancer` | `@aws-sdk/client-elastic-load-balancing-v2` | full (`configuration.type`, `scheme`, `dNSName`, `vpcId`, `ipAddressType`, `availabilityZones[].zoneName`) | replace with Config |
| `elasticache` | `AWS::ElastiCache::CacheCluster` | `@aws-sdk/client-elasticache` | full (`configuration.engine`, `engineVersion`, `cacheNodeType`, `numCacheNodes`, `preferredAvailabilityZone`, `configurationEndpoint.address`) | replace with Config |

## Resource types Config gives us "for free" (not scanned today)

| AppCloud type | Config resourceType | Why it matters |
|---|---|---|
| `vpc` | `AWS::EC2::VPC` | Edge target for Instance / RDS / EKS / ALB |
| `subnet` | `AWS::EC2::Subnet` | Edge target for Instance / Lambda / RDS / EKS / ALB |
| `security_group` | `AWS::EC2::SecurityGroup` | Edge target — security posture surface |
| `network_interface` | `AWS::EC2::NetworkInterface` | Edge target for Instance → ENI → Subnet/SG |
| `ebs_volume` | `AWS::EC2::Volume` | Edge target for Instance → Volume |
| `internet_gateway` | `AWS::EC2::InternetGateway` | Egress posture |
| `nat_gateway` | `AWS::EC2::NatGateway` | Egress plumbing |
| `route_table` | `AWS::EC2::RouteTable` | Routing posture |
| `s3_bucket` | `AWS::S3::Bucket` | Object storage; previously not discovered |
| `iam_role` | `AWS::IAM::Role` | Edge target for Instance / Lambda → IAM Role |
| `dynamodb` | `AWS::DynamoDB::Table` | Database plane |
| `sns_topic` / `sqs_queue` | `AWS::SNS::Topic` / `AWS::SQS::Queue` | Messaging plane |
| `kms_key` | `AWS::KMS::Key` | Encryption plumbing |
| `api_gateway` | `AWS::ApiGateway::RestApi` | Public surface |
| `cloudfront` | `AWS::CloudFront::Distribution` | Edge / CDN |

## Structural edges emitted by the new scanner

| From type | `via` | Target reference field | Confidence |
|---|---|---|---|
| EC2 Instance | `subnet` | `configuration.subnetId` | 65 |
| EC2 Instance | `vpc` | `configuration.vpcId` | 65 |
| EC2 Instance | `security-group` | `configuration.securityGroups[].groupId` | 55 |
| EC2 Instance | `eni` | `configuration.networkInterfaces[].networkInterfaceId` | 90 |
| EC2 Instance | `disk` | `configuration.blockDeviceMappings[].ebs.volumeId` | 88 |
| EC2 Instance | `iam-role` | `configuration.iamInstanceProfile.arn` (resolved to Role ARN) | 60 |
| ENI | `subnet` | `configuration.subnetId` | 65 |
| ENI | `vpc` | `configuration.vpcId` | 65 |
| ENI | `security-group` | `configuration.groups[].groupId` | 55 |
| Subnet | `vpc` | `configuration.vpcId` | 65 |
| Security Group | `vpc` | `configuration.vpcId` | 65 |
| RDS DBInstance | `vpc` | `configuration.dBSubnetGroup.vpcId` | 65 |
| Lambda Function | `iam-role` | `configuration.role` | 60 |
| Lambda Function | `subnet` | `configuration.vpcConfig.subnetIds[]` | 65 |
| Lambda Function | `security-group` | `configuration.vpcConfig.securityGroupIds[]` | 55 |
| EKS Cluster | `vpc` | `configuration.resourcesVpcConfig.vpcId` | 65 |
| EKS Cluster | `subnet` | `configuration.resourcesVpcConfig.subnetIds[]` | 65 |
| EKS Cluster | `security-group` | `configuration.resourcesVpcConfig.clusterSecurityGroupId` | 55 |
| Load Balancer | `vpc` | `configuration.vpcId` | 65 |
| Load Balancer | `subnet` | `configuration.availabilityZones[].subnetId` | 65 |
| Load Balancer | `security-group` | `configuration.securityGroups[]` | 55 |
| Internet Gateway | `vpc` | derived from attachments | 65 |
| NAT Gateway | `subnet` | `configuration.subnetId` | 65 |

Confidence values reuse the cross-cloud `via→score` table established
by `discovery.autolink.js`. Shared keys (`subnet`, `vpc`, `disk`,
`iam-role`, `security-group`) hold the same score across clouds where
applicable.

## Identity continuity

Per-type `cloud_id` mapping is preserved across the migration:

| Type | Existing scanner cloud_id | New scanner cloud_id |
|---|---|---|
| `ec2_instance` | `inst.InstanceId` (`i-…`) | `row.resourceId` (`i-…`) |
| `rds_instance` | `db.DBInstanceArn` (ARN) | `row.configuration.dBInstanceArn` |
| `function` | `fn.FunctionArn` (ARN) | `row.configuration.functionArn` |
| `eks_cluster` | `c.arn` | `row.configuration.arn` |
| `ecs_cluster` | `c.clusterArn` | `row.configuration.clusterArn` |
| `load_balancer` | `lb.LoadBalancerArn` | `row.configuration.loadBalancerArn` |
| `elasticache` | `cluster.CacheClusterId` (raw id) | `row.resourceId` |
| (new types) | n/a | `row.configuration.arn` if present, else `row.resourceId` |

Edge targets reference resources by raw ID (e.g., `subnetId: subnet-xxx`).
The scanner builds an in-memory lookup keyed on **both** cloud_id and
raw resourceId, so cross-resource references resolve regardless of
which form the source field carries.

## Known Config gaps (deliberately not covered by slice 3)

| Gap | What it means | Future supplement layer |
|---|---|---|
| Resource types not in Config's default coverage | Some types (e.g., AppRunner, ECR repositories) require enabling **advanced resource types** on the recording configuration. Operators do this once per account; the new scanner doesn't try to enable it for them. | Documented as an Operator step in slice 4 |
| VPC flow logs (observed traffic) | Configuration-only view; no runtime traffic surface | Future supplement (`vpc-flow-logs`) reading flow logs from S3/CloudWatch |
| Effective IAM access | Config surfaces stored policies, not effective access | Future supplement using IAM Access Analyzer |

## Fields consciously dropped

None for slice 3 against the 7 legacy types. Lambda's `description` and
EKS's `logging.clusterLogging[].types` are present in
`configuration.*` and preserved.

## Pagination

Config's `SelectAggregateResourceConfig` paginates via `NextToken` with
a max page size of 100. The new scanner iterates until exhausted —
necessary because a single aggregator can hold tens of thousands of
configuration items across accounts and regions.

## Edge-write policy during slice 3 (Option A dual-write)

Same as slices 1 and 2:

- **Structural edges**: `:CONNECTED_TO` (legacy reader-compat) AND
  `:CONNECTS_TO` (new canonical) with traceability properties
  (`source: 'aws-config-aggregator'`, `via`, `confidence`,
  `evidence`).
- **Auto-link edges**: `:DEPLOYED_ON` AND
  `:CONNECTS_TO[via='component-mapping']` via the shared helper in
  `discovery.autolink.js`. AWS co-location bucket is `account-region`
  derived from the ARN.
- Typed relationships are not written.

## SDK churn in slice 3

Removed (no longer imported by `discovery.js`):

- `@aws-sdk/client-ec2`
- `@aws-sdk/client-rds`
- `@aws-sdk/client-lambda`
- `@aws-sdk/client-eks`
- `@aws-sdk/client-ecs`
- `@aws-sdk/client-elastic-load-balancing-v2`
- `@aws-sdk/client-elasticache`

Added:

- `@aws-sdk/client-config-service`

Retained:

- `@aws-sdk/client-s3` — used by `iac-state-backend/backends/s3.js`,
  not discovery.

`api/package.json` pruning of the 7 removed SDKs is deferred to slice 5
along with the rest of the cross-cutting cleanup.
