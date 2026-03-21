#!/usr/bin/env bash
# seed-aws.sh — Create stopped/idle AWS resources for AppCloud discovery testing.
#
# All resources are created in a STOPPED or idle state — no running compute,
# no data transfer. Cost is minimal (EBS volumes at ~$0.10/GB/month, stopped
# EC2 instances have no compute charge, Lambda has no charge until invoked).
#
# Prerequisites:
#   - AWS CLI installed and configured (aws configure)
#   - Sufficient IAM permissions: EC2, Lambda, S3, RDS, SQS, SSM
#
# Usage:
#   export AWS_REGION=ap-southeast-2   # set your preferred region
#   chmod +x seed-aws.sh && ./seed-aws.sh
#
# Cleanup:
#   ./seed-aws.sh --destroy

set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-2}"
PREFIX="appcloud-test"
DESTROY="${1:-}"

EP=""   # empty — real AWS, not LocalStack
R="--region $REGION"
OUT="--output text"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  AppCloud AWS Seed — Stopped/Idle Resources              ║"
echo "║  Region: $REGION"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

log()  { echo "  ▶  $*"; }
ok()   { echo "  ✓  $*"; }

# ── Destroy mode ──────────────────────────────────────────────────────────────
if [ "$DESTROY" = "--destroy" ]; then
  echo "  Destroying all AppCloud test resources in $REGION..."

  # Terminate EC2 instances
  INSTANCE_IDS=$(aws ec2 describe-instances $R $OUT \
    --filters "Name=tag:Project,Values=appcloud-test" \
              "Name=instance-state-name,Values=stopped,running" \
    --query 'Reservations[].Instances[].InstanceId' 2>/dev/null || true)
  if [ -n "$INSTANCE_IDS" ]; then
    aws ec2 terminate-instances $R $OUT \
      --instance-ids $INSTANCE_IDS > /dev/null
    ok "EC2 instances terminated"
  fi

  # Delete Lambda functions
  for fn in process-payment send-notification ingest-events identity-auth; do
    aws lambda delete-function $R \
      --function-name "${PREFIX}-${fn}" 2>/dev/null && ok "Lambda: ${PREFIX}-${fn} deleted" || true
  done

  # Delete RDS snapshots and instances
  aws rds delete-db-instance $R \
    --db-instance-identifier "${PREFIX}-payments-db" \
    --skip-final-snapshot 2>/dev/null && ok "RDS: deleted" || true

  # Empty and delete S3 buckets
  for bucket in assets backups logs; do
    BNAME="${PREFIX}-${bucket}-$$"
    aws s3 rb $R "s3://${BNAME}" --force 2>/dev/null && ok "S3: $BNAME deleted" || true
  done

  # Delete SQS queues
  for q in payments-events notifications data-ingestion-dlq; do
    URL=$(aws sqs get-queue-url $R $OUT \
      --queue-name "${PREFIX}-${q}" \
      --query 'QueueUrl' 2>/dev/null || true)
    [ -n "$URL" ] && aws sqs delete-queue $R --queue-url "$URL" && ok "SQS: $q deleted" || true
  done

  echo ""
  echo "  ✓  Destroy complete"
  exit 0
fi

# ── Tag helper ─────────────────────────────────────────────────────────────────
# Common AppCloud mapping tags on every resource:
#   appcloud:app      — maps to Application.name in AppCloud
#   appcloud:env      — maps to Application.environment
#   appcloud:tier     — maps to Application.tier
#   appcloud:owner    — maps to Application.owner
#   appcloud:component — maps to Component.name

# ── VPC and networking ────────────────────────────────────────────────────────
log "Creating VPC..."
VPC_ID=$(aws ec2 create-vpc $R $OUT \
  --cidr-block 10.0.0.0/16 \
  --query 'Vpc.VpcId')
aws ec2 create-tags $R $OUT \
  --resources "$VPC_ID" \
  --tags Key=Name,Value="${PREFIX}-vpc" \
         Key=Project,Value=appcloud-test > /dev/null
ok "VPC: $VPC_ID"

log "Creating subnets..."
SUBNET_PRIVATE=$(aws ec2 create-subnet $R $OUT \
  --vpc-id "$VPC_ID" --cidr-block 10.0.1.0/24 \
  --query 'Subnet.SubnetId')
SUBNET_PUBLIC=$(aws ec2 create-subnet $R $OUT \
  --vpc-id "$VPC_ID" --cidr-block 10.0.2.0/24 \
  --query 'Subnet.SubnetId')
aws ec2 create-tags $R $OUT \
  --resources "$SUBNET_PRIVATE" \
  --tags Key=Name,Value="${PREFIX}-private" Key=Project,Value=appcloud-test > /dev/null
aws ec2 create-tags $R $OUT \
  --resources "$SUBNET_PUBLIC" \
  --tags Key=Name,Value="${PREFIX}-public" Key=Project,Value=appcloud-test > /dev/null
ok "Subnets: $SUBNET_PRIVATE (private)  $SUBNET_PUBLIC (public)"

log "Creating security group..."
SG_ID=$(aws ec2 create-security-group $R $OUT \
  --group-name "${PREFIX}-sg" \
  --description "AppCloud test security group" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId')
ok "Security group: $SG_ID"

# ── EC2 instances — stopped immediately after creation ────────────────────────
log "Getting AMI..."
# Amazon Linux 2 — latest in this region
AMI_ID=$(aws ec2 describe-images $R $OUT \
  --owners amazon \
  --filters \
    "Name=name,Values=amzn2-ami-hvm-2.0.*-x86_64-gp2" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId')
ok "AMI: $AMI_ID"

log "Creating EC2 instances (will be stopped immediately)..."

# Instance 1 — Payments API server (private subnet)
INST_1=$(aws ec2 run-instances $R $OUT \
  --image-id "$AMI_ID" \
  --instance-type t2.micro \
  --count 1 \
  --subnet-id "$SUBNET_PRIVATE" \
  --no-associate-public-ip-address \
  --query 'Instances[0].InstanceId')
aws ec2 create-tags $R $OUT \
  --resources "$INST_1" \
  --tags \
    Key=Name,Value="${PREFIX}-payments-api" \
    Key=Project,Value=appcloud-test \
    Key="appcloud:app",Value="Payments Platform" \
    Key="appcloud:component",Value="API" \
    Key="appcloud:env",Value=production \
    Key="appcloud:tier",Value=1 \
    Key="appcloud:owner",Value=payments-platform-team \
    Key=CostCentre,Value=payments \
    Key=Environment,Value=production > /dev/null
ok "EC2: $INST_1 (payments-api)"

# Instance 2 — Payments DB server (private subnet)
INST_2=$(aws ec2 run-instances $R $OUT \
  --image-id "$AMI_ID" \
  --instance-type t2.micro \
  --count 1 \
  --subnet-id "$SUBNET_PRIVATE" \
  --no-associate-public-ip-address \
  --query 'Instances[0].InstanceId')
aws ec2 create-tags $R $OUT \
  --resources "$INST_2" \
  --tags \
    Key=Name,Value="${PREFIX}-payments-db" \
    Key=Project,Value=appcloud-test \
    Key="appcloud:app",Value="Payments Platform" \
    Key="appcloud:component",Value="DB" \
    Key="appcloud:env",Value=production \
    Key="appcloud:tier",Value=1 \
    Key="appcloud:owner",Value=payments-platform-team \
    Key=CostCentre,Value=payments \
    Key=Environment,Value=production > /dev/null
ok "EC2: $INST_2 (payments-db)"

# Instance 3 — Online Banking web server (public subnet)
INST_3=$(aws ec2 run-instances $R $OUT \
  --image-id "$AMI_ID" \
  --instance-type t2.micro \
  --count 1 \
  --subnet-id "$SUBNET_PUBLIC" \
  --no-associate-public-ip-address \
  --query 'Instances[0].InstanceId')
aws ec2 create-tags $R $OUT \
  --resources "$INST_3" \
  --tags \
    Key=Name,Value="${PREFIX}-banking-web" \
    Key=Project,Value=appcloud-test \
    Key="appcloud:app",Value="Online Banking" \
    Key="appcloud:component",Value="Web" \
    Key="appcloud:env",Value=production \
    Key="appcloud:tier",Value=1 \
    Key="appcloud:owner",Value=online-banking-team \
    Key=CostCentre,Value=retail-banking \
    Key=Environment,Value=production > /dev/null
ok "EC2: $INST_3 (banking-web)"

# Instance 4 — Data pipeline worker (private subnet, staging)
INST_4=$(aws ec2 run-instances $R $OUT \
  --image-id "$AMI_ID" \
  --instance-type t2.micro \
  --count 1 \
  --subnet-id "$SUBNET_PRIVATE" \
  --no-associate-public-ip-address \
  --query 'Instances[0].InstanceId')
aws ec2 create-tags $R $OUT \
  --resources "$INST_4" \
  --tags \
    Key=Name,Value="${PREFIX}-data-worker" \
    Key=Project,Value=appcloud-test \
    Key="appcloud:app",Value="Data Platform" \
    Key="appcloud:component",Value="Worker" \
    Key="appcloud:env",Value=staging \
    Key="appcloud:tier",Value=3 \
    Key="appcloud:owner",Value=data-engineering-team \
    Key=CostCentre,Value=data \
    Key=Environment,Value=staging > /dev/null
ok "EC2: $INST_4 (data-worker)"

# Stop all instances immediately — no compute charges
log "Stopping all EC2 instances..."
aws ec2 stop-instances $R $OUT \
  --instance-ids "$INST_1" "$INST_2" "$INST_3" "$INST_4" \
  --query 'StoppingInstances[].CurrentState.Name' > /dev/null
ok "All instances stopping (no compute charges)"

# ── Lambda functions — zero cost until invoked ────────────────────────────────
log "Creating IAM role for Lambda..."
ROLE_ARN=$(aws iam create-role $R $OUT \
  --role-name "${PREFIX}-lambda-role" \
  --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query 'Role.Arn' 2>/dev/null || \
  aws iam get-role $R $OUT \
    --role-name "${PREFIX}-lambda-role" \
    --query 'Role.Arn')
ok "IAM role: $ROLE_ARN"

log "Creating Lambda zip..."
echo 'exports.handler = async () => ({ statusCode: 200 })' > /tmp/index.js
zip -q /tmp/appcloud-test-fn.zip /tmp/index.js

log "Creating Lambda functions..."

create_lambda() {
  local fn_name=$1 app=$2 component=$3 owner=$4 tier=$5
  aws lambda create-function $R $OUT \
    --function-name "${PREFIX}-${fn_name}" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file fileb:///tmp/appcloud-test-fn.zip \
    --description "AppCloud test: $app / $component" \
    --query 'FunctionName' > /dev/null
  aws lambda tag-resource $R $OUT \
    --resource "arn:aws:lambda:${REGION}:$(aws sts get-caller-identity $R $OUT --query 'Account'):function:${PREFIX}-${fn_name}" \
    --tags \
      "appcloud:app=${app}" \
      "appcloud:component=${component}" \
      "appcloud:owner=${owner}" \
      "appcloud:tier=${tier}" \
      "appcloud:env=production" \
      "Project=appcloud-test" > /dev/null
  ok "Lambda: ${PREFIX}-${fn_name} ($app / $component)"
}

create_lambda "process-payment"   "Payments Platform" "PaymentProcessor" "payments-platform-team" "1"
create_lambda "send-notification" "Payments Platform" "Notifier"          "payments-platform-team" "1"
create_lambda "ingest-events"     "Data Platform"     "EventIngester"     "data-engineering-team"  "3"
create_lambda "identity-auth"     "Online Banking"    "AuthService"       "online-banking-team"    "1"

# ── S3 buckets — zero cost when empty ─────────────────────────────────────────
log "Creating S3 buckets..."

create_bucket() {
  local suffix=$1 app=$2 component=$3
  # Bucket names must be globally unique — append account ID fragment
  local ACCT=$(aws sts get-caller-identity $R $OUT --query 'Account')
  local BNAME="${PREFIX}-${suffix}-${ACCT:0:8}"
  # us-east-1 doesn't accept LocationConstraint — other regions do
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket $R $OUT \
      --bucket "$BNAME" \
      --query 'Location' > /dev/null
  else
    aws s3api create-bucket $R $OUT \
      --bucket "$BNAME" \
      --create-bucket-configuration "LocationConstraint=$REGION" \
      --query 'Location' > /dev/null
  fi
  aws s3api put-bucket-tagging $R $OUT \
    --bucket "$BNAME" \
    --tagging "TagSet=[
      {Key=Name,Value=$BNAME},
      {Key=Project,Value=appcloud-test},
      {Key=appcloud:app,Value=$app},
      {Key=appcloud:component,Value=$component},
      {Key=appcloud:env,Value=production}
    ]" > /dev/null
  ok "S3: $BNAME ($app)"
}

create_bucket "payments-assets"  "Payments Platform" "AssetStore"
create_bucket "banking-static"   "Online Banking"    "StaticAssets"
create_bucket "data-lake"        "Data Platform"     "DataLake"

# ── SQS queues — zero cost with no messages ───────────────────────────────────
log "Creating SQS queues..."

create_queue() {
  local name=$1 app=$2 component=$3
  local QUEUE_URL=$(aws sqs create-queue $R $OUT \
    --queue-name "${PREFIX}-${name}" \
    --query 'QueueUrl')
  local QUEUE_ARN=$(aws sqs get-queue-attributes $R $OUT \
    --queue-url "$QUEUE_URL" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn')
  aws sqs tag-queue $R $OUT \
    --queue-url "$QUEUE_URL" \
    --tags \
      "appcloud:app=${app}" \
      "appcloud:component=${component}" \
      "appcloud:env=production" \
      "Project=appcloud-test" > /dev/null
  ok "SQS: ${PREFIX}-${name} ($app)"
}

create_queue "payment-events"     "Payments Platform" "EventBus"
create_queue "notification-queue" "Payments Platform" "Notifier"
create_queue "data-ingestion"     "Data Platform"     "EventIngester"

# ── SSM parameters — free tier ────────────────────────────────────────────────
log "Creating SSM parameters..."
for param in \
  "/appcloud-test/payments/db-host:Payments Platform:DB" \
  "/appcloud-test/payments/api-key:Payments Platform:API" \
  "/appcloud-test/banking/jwt-secret:Online Banking:AuthService"; do
  NAME=$(echo $param | cut -d: -f1)
  APP=$(echo $param  | cut -d: -f2)
  COMP=$(echo $param | cut -d: -f3)
  aws ssm put-parameter $R $OUT \
    --name "$NAME" \
    --value "test-value-appcloud" \
    --type SecureString \
    --tags \
      "Key=appcloud:app,Value=$APP" \
      "Key=appcloud:component,Value=$COMP" \
      "Key=Project,Value=appcloud-test" \
    --overwrite > /dev/null
  ok "SSM: $NAME"
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  AWS Seed Complete                                       ║"
echo "║                                                          ║"
echo "║  EC2    4 instances (STOPPED — no compute charge)        ║"
echo "║  Lambda 4 functions (idle — no charge until invoked)     ║"
echo "║  S3     3 buckets   (empty — no storage charge)          ║"
echo "║  SQS    3 queues    (empty — no charge)                  ║"
echo "║  SSM    3 parameters (free tier)                         ║"
echo "║                                                          ║"
echo "║  Estimated cost: ~\$0.20/month (EBS volumes only)         ║"
echo "║                                                          ║"
echo "║  AppCloud mapping tags used:                             ║"
echo "║    appcloud:app       → Application name                 ║"
echo "║    appcloud:component → Component name                   ║"
echo "║    appcloud:env       → Environment                      ║"
echo "║    appcloud:tier      → Tier (1-4)                       ║"
echo "║    appcloud:owner     → Team owner                       ║"
echo "║                                                          ║"
echo "║  Run discovery:                                          ║"
echo "║  curl -X POST http://localhost:3000/discovery/scan/aws   ║"
echo "║    -H 'Content-Type: application/json'                   ║"
echo "║    -d '{\"regions\":[\"$REGION\"]}'                ║"
echo "║                                                          ║"
echo "║  Cleanup: ./seed-aws.sh --destroy                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
