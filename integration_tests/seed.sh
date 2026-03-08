#!/bin/bash
# integration_tests/seed.sh
# Creates representative AWS resources in LocalStack so the AppCloud
# discovery scanner has something real to find.
#
# Runs inside the `seed` service container (amazon/aws-cli image).
# All calls go to http://localstack:4566 via AWS_ENDPOINT_URL env var.

set -euo pipefail

BASE="--endpoint-url $AWS_ENDPOINT_URL --region us-east-1 --output json"
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     AppCloud LocalStack Seed                         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "  ▶  $*"; }
ok()   { echo "  ✓  $*"; }
skip() { echo "  –  $* (skipped)"; }

# ── VPC + Subnet (needed by EC2, RDS, EKS, ECS) ──────────────────────────────
log "Creating VPC..."
VPC_ID=$(aws ec2 create-vpc $BASE \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=appcloud-test-vpc}]' \
  | jq -r '.Vpc.VpcId')
ok "VPC: $VPC_ID"

log "Creating subnets..."
SUBNET_A=$(aws ec2 create-subnet $BASE \
  --vpc-id "$VPC_ID" --cidr-block 10.0.1.0/24 \
  --availability-zone us-east-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=appcloud-test-subnet-a}]' \
  | jq -r '.Subnet.SubnetId')

SUBNET_B=$(aws ec2 create-subnet $BASE \
  --vpc-id "$VPC_ID" --cidr-block 10.0.2.0/24 \
  --availability-zone us-east-1b \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=appcloud-test-subnet-b}]' \
  | jq -r '.Subnet.SubnetId')
ok "Subnets: $SUBNET_A, $SUBNET_B"

log "Creating security group..."
SG_ID=$(aws ec2 create-security-group $BASE \
  --group-name appcloud-test-sg \
  --description "AppCloud test security group" \
  --vpc-id "$VPC_ID" \
  | jq -r '.GroupId')
ok "Security group: $SG_ID"

# ── EC2 instances ─────────────────────────────────────────────────────────────
log "Creating EC2 instances..."

# Get an AMI ID (LocalStack provides a default)
AMI_ID=$(aws ec2 describe-images $BASE \
  --filters "Name=name,Values=amzn2-ami-hvm*" \
  | jq -r '.Images[0].ImageId // "ami-00000000"')

aws ec2 run-instances $BASE \
  --image-id "$AMI_ID" \
  --instance-type t2.micro \
  --min-count 1 --max-count 1 \
  --subnet-id "$SUBNET_A" \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=payments-api-server},{Key=app,Value=payments},{Key=env,Value=production}]' \
  > /dev/null

aws ec2 run-instances $BASE \
  --image-id "$AMI_ID" \
  --instance-type t3.medium \
  --min-count 1 --max-count 1 \
  --subnet-id "$SUBNET_B" \
  --associate-public-ip-address \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=identity-service-server},{Key=app,Value=identity},{Key=env,Value=production}]' \
  > /dev/null

aws ec2 run-instances $BASE \
  --image-id "$AMI_ID" \
  --instance-type t2.micro \
  --min-count 1 --max-count 1 \
  --subnet-id "$SUBNET_A" \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=data-pipeline-worker},{Key=app,Value=data-platform},{Key=env,Value=staging}]' \
  > /dev/null

ok "3 EC2 instances created"

# ── RDS instances ─────────────────────────────────────────────────────────────
log "Creating RDS subnet group..."
aws rds create-db-subnet-group $BASE \
  --db-subnet-group-name appcloud-test-subnet-group \
  --db-subnet-group-description "AppCloud test" \
  --subnet-ids "$SUBNET_A" "$SUBNET_B" \
  > /dev/null

log "Creating RDS instances..."
aws rds create-db-instance $BASE \
  --db-instance-identifier payments-db \
  --db-instance-class db.t3.micro \
  --engine mysql \
  --engine-version "8.0" \
  --master-username admin \
  --master-user-password testpassword123 \
  --allocated-storage 20 \
  --db-subnet-group-name appcloud-test-subnet-group \
  --no-publicly-accessible \
  --tags Key=app,Value=payments Key=env,Value=production \
  > /dev/null

aws rds create-db-instance $BASE \
  --db-instance-identifier analytics-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version "15.3" \
  --master-username admin \
  --master-user-password testpassword123 \
  --allocated-storage 50 \
  --db-subnet-group-name appcloud-test-subnet-group \
  --publicly-accessible \
  --tags Key=app,Value=analytics Key=env,Value=production \
  > /dev/null

ok "2 RDS instances created"

# ── Lambda functions ──────────────────────────────────────────────────────────
log "Creating IAM role for Lambda..."
ROLE_ARN=$(aws iam create-role $BASE \
  --role-name appcloud-test-lambda-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  | jq -r '.Role.Arn')
ok "IAM role: $ROLE_ARN"

log "Creating Lambda functions..."

# Create minimal zip for LocalStack (it doesn't execute, just needs to exist)
echo 'exports.handler = async () => ({ statusCode: 200 })' > /tmp/index.js
cd /tmp && zip -q function.zip index.js && cd -

aws lambda create-function $BASE \
  --function-name process-payment \
  --runtime nodejs20.x \
  --role "$ROLE_ARN" \
  --handler index.handler \
  --zip-file fileb:///tmp/function.zip \
  --description "Payment processing handler" \
  --memory-size 256 \
  --timeout 30 \
  --environment Variables='{ENV=production,APP=payments}' \
  > /dev/null

aws lambda create-function $BASE \
  --function-name send-notification \
  --runtime python3.11 \
  --role "$ROLE_ARN" \
  --handler index.handler \
  --zip-file fileb:///tmp/function.zip \
  --description "Notification dispatch function" \
  --memory-size 128 \
  --timeout 15 \
  > /dev/null

aws lambda create-function $BASE \
  --function-name ingest-events \
  --runtime nodejs20.x \
  --role "$ROLE_ARN" \
  --handler index.handler \
  --zip-file fileb:///tmp/function.zip \
  --description "Event ingestion from Kinesis" \
  --memory-size 512 \
  --timeout 60 \
  > /dev/null

ok "3 Lambda functions created"

# ── ECS clusters ──────────────────────────────────────────────────────────────
log "Creating ECS clusters..."
aws ecs create-cluster $BASE \
  --cluster-name payments-cluster \
  --tags key=app,value=payments key=env,value=production \
  > /dev/null

aws ecs create-cluster $BASE \
  --cluster-name data-platform-cluster \
  --tags key=app,value=data-platform key=env,value=production \
  > /dev/null
ok "2 ECS clusters created"

# ── EKS clusters ──────────────────────────────────────────────────────────────
# LocalStack community supports EKS cluster creation (control plane only)
log "Creating EKS cluster..."
aws eks create-cluster $BASE \
  --name appcloud-test-eks \
  --role-arn "$ROLE_ARN" \
  --resources-vpc-config \
    subnetIds="$SUBNET_A","$SUBNET_B",securityGroupIds="$SG_ID",endpointPublicAccess=true,endpointPrivateAccess=false \
  --kubernetes-version "1.29" \
  > /dev/null || skip "EKS (may not be available in LocalStack community)"
ok "EKS cluster created (or skipped)"

# ── Application Load Balancer ─────────────────────────────────────────────────
log "Creating Application Load Balancer..."
aws elbv2 create-load-balancer $BASE \
  --name payments-alb \
  --subnets "$SUBNET_A" "$SUBNET_B" \
  --security-groups "$SG_ID" \
  --scheme internet-facing \
  --type application \
  --tags Key=app,Value=payments Key=env,Value=production \
  > /dev/null

aws elbv2 create-load-balancer $BASE \
  --name internal-api-nlb \
  --subnets "$SUBNET_A" "$SUBNET_B" \
  --scheme internal \
  --type network \
  --tags Key=app,Value=internal-api Key=env,Value=production \
  > /dev/null
ok "2 load balancers created"

# ── ElastiCache clusters ──────────────────────────────────────────────────────
log "Creating ElastiCache clusters..."
aws elasticache create-cache-cluster $BASE \
  --cache-cluster-id payments-cache \
  --cache-node-type cache.t3.micro \
  --engine redis \
  --engine-version "7.0" \
  --num-cache-nodes 1 \
  > /dev/null

aws elasticache create-cache-cluster $BASE \
  --cache-cluster-id session-store \
  --cache-node-type cache.t3.micro \
  --engine memcached \
  --engine-version "1.6" \
  --num-cache-nodes 1 \
  > /dev/null
ok "2 ElastiCache clusters created"

# ── S3 buckets ────────────────────────────────────────────────────────────────
log "Creating S3 buckets..."
aws s3 mb $BASE s3://appcloud-test-assets > /dev/null
aws s3 mb $BASE s3://appcloud-test-backups > /dev/null
aws s3 mb $BASE s3://appcloud-test-logs > /dev/null
ok "3 S3 buckets created"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Seed complete. Resources created in LocalStack:     ║"
echo "║                                                      ║"
echo "║   EC2          3 instances                           ║"
echo "║   RDS          2 instances                           ║"
echo "║   Lambda       3 functions                           ║"
echo "║   ECS          2 clusters                            ║"
echo "║   EKS          1 cluster                             ║"
echo "║   ALB/NLB      2 load balancers                      ║"
echo "║   ElastiCache  2 clusters                            ║"
echo "║   S3           3 buckets                             ║"
echo "║                                                      ║"
echo "║  Run discovery scan:                                 ║"
echo "║  curl -X POST http://localhost:3001/discovery/scan/aws║"
echo "║    -H 'Content-Type: application/json'               ║"
echo "║    -d '{"regions":["us-east-1"]}'                    ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""