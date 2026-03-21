#!/bin/bash
# integration_tests/seed.sh
# Creates AWS resources in LocalStack Community Edition (free tier).
#
# Confirmed free services:
#   S3, SQS, SNS, DynamoDB, Lambda, EC2 (metadata/mock only),
#   IAM, SSM, CloudWatch, Kinesis
#
# Pro only (skipped):
#   ECS, EKS, RDS, ElastiCache, ELBv2/ALB, MSK, OpenSearch

set -euo pipefail

EP="--endpoint-url $AWS_ENDPOINT_URL"
R="--region us-east-1"
OUT="--output text"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  AppCloud LocalStack Seed (Community Free Tier)      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Disable chunked transfer encoding — LocalStack community doesn't support
# the x-amz-trailer header that AWS CLI v2 sends with chunked uploads
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

log()  { echo "  ▶  $*"; }
ok()   { echo "  ✓  $*"; }
skip() { echo "  –  $* (Pro only — skipped)"; }

# ── S3 buckets ────────────────────────────────────────────────────────────────
log "Creating S3 buckets..."
for bucket in appcloud-test-assets appcloud-test-backups appcloud-test-logs; do
  aws s3 mb $EP "s3://$bucket" > /dev/null
  ok "S3: $bucket"
done

# Put a test object so the bucket isn't empty
echo '{"service":"payments","version":"1.0"}' > /tmp/manifest.json
aws s3api put-object $EP $R $OUT \
  --bucket appcloud-test-assets \
  --key manifest.json \
  --body /tmp/manifest.json \
  --no-cli-pager > /dev/null
ok "S3: uploaded test object to appcloud-test-assets"

# ── SQS queues ────────────────────────────────────────────────────────────────
log "Creating SQS queues..."
aws sqs create-queue $EP $R $OUT \
  --queue-name payments-events \
  --query 'QueueUrl' > /dev/null
ok "SQS: payments-events"

aws sqs create-queue $EP $R $OUT \
  --queue-name notification-queue \
  --query 'QueueUrl' > /dev/null
ok "SQS: notification-queue"

aws sqs create-queue $EP $R $OUT \
  --queue-name data-ingestion-dlq \
  --attributes '{"MessageRetentionPeriod":"1209600"}' \
  --query 'QueueUrl' > /dev/null
ok "SQS: data-ingestion-dlq (dead letter, 14-day retention)"

# ── SNS topics ────────────────────────────────────────────────────────────────
log "Creating SNS topics..."
aws sns create-topic $EP $R $OUT \
  --name payment-alerts \
  --query 'TopicArn' > /dev/null
ok "SNS: payment-alerts"

aws sns create-topic $EP $R $OUT \
  --name system-notifications \
  --query 'TopicArn' > /dev/null
ok "SNS: system-notifications"

aws sns create-topic $EP $R $OUT \
  --name infra-drift-alerts \
  --query 'TopicArn' > /dev/null
ok "SNS: infra-drift-alerts"

# ── DynamoDB tables ───────────────────────────────────────────────────────────
log "Creating DynamoDB tables..."
aws dynamodb create-table $EP $R $OUT \
  --table-name sessions \
  --attribute-definitions AttributeName=sessionId,AttributeType=S \
  --key-schema AttributeName=sessionId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --query 'TableDescription.TableName' > /dev/null
ok "DynamoDB: sessions"

aws dynamodb create-table $EP $R $OUT \
  --table-name audit-events \
  --attribute-definitions \
    AttributeName=eventId,AttributeType=S \
    AttributeName=ts,AttributeType=N \
  --key-schema \
    AttributeName=eventId,KeyType=HASH \
    AttributeName=ts,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --query 'TableDescription.TableName' > /dev/null
ok "DynamoDB: audit-events"

aws dynamodb create-table $EP $R $OUT \
  --table-name feature-flags \
  --attribute-definitions AttributeName=flagName,AttributeType=S \
  --key-schema AttributeName=flagName,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --query 'TableDescription.TableName' > /dev/null
ok "DynamoDB: feature-flags"

# Seed a test item
aws dynamodb put-item $EP $R $OUT \
  --table-name feature-flags \
  --item '{"flagName":{"S":"payments-v2"},"enabled":{"BOOL":true},"rollout":{"N":"100"}}' \
  > /dev/null
ok "DynamoDB: seeded feature-flags with test item"

# ── Kinesis streams ───────────────────────────────────────────────────────────
log "Creating Kinesis streams..."
aws kinesis create-stream $EP $R $OUT \
  --stream-name payment-events \
  --shard-count 2 > /dev/null
ok "Kinesis: payment-events (2 shards)"

aws kinesis create-stream $EP $R $OUT \
  --stream-name audit-stream \
  --shard-count 1 > /dev/null
ok "Kinesis: audit-stream (1 shard)"

# ── IAM roles ─────────────────────────────────────────────────────────────────
log "Creating IAM roles..."
LAMBDA_ROLE=$(aws iam create-role $EP $R $OUT \
  --role-name appcloud-lambda-role \
  --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query 'Role.Arn')
ok "IAM: appcloud-lambda-role ($LAMBDA_ROLE)"

APP_ROLE=$(aws iam create-role $EP $R $OUT \
  --role-name appcloud-app-role \
  --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query 'Role.Arn')
ok "IAM: appcloud-app-role ($APP_ROLE)"

# ── Lambda functions ──────────────────────────────────────────────────────────
log "Creating Lambda functions..."
echo 'exports.handler = async () => ({ statusCode: 200 })' > /tmp/index.js
zip -q /tmp/function.zip /tmp/index.js
ok "Lambda zip ready"

for fn_name in process-payment send-notification ingest-events; do
  aws lambda create-function $EP $R $OUT \
    --function-name "$fn_name" \
    --runtime nodejs20.x \
    --role "$LAMBDA_ROLE" \
    --handler index.handler \
    --zip-file fileb:///tmp/function.zip \
    --query 'FunctionName' > /dev/null
  ok "Lambda: $fn_name"
done

# ── EC2 (mock metadata only in community) ────────────────────────────────────
log "Creating EC2 instances (mock metadata)..."
AMI_ID=$(aws ec2 describe-images $EP $R $OUT \
  --filters "Name=name,Values=amzn2-ami-hvm*" \
  --query 'Images[0].ImageId' 2>/dev/null || true)
[ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ] && AMI_ID="ami-00000000"

INST_1=$(aws ec2 run-instances $EP $R $OUT \
  --image-id "$AMI_ID" --instance-type t2.micro --count 1 \
  --query 'Instances[0].InstanceId')
aws ec2 create-tags $EP $R $OUT --resources "$INST_1" \
  --tags Key=Name,Value=payments-api-server \
         Key=app,Value=payments Key=env,Value=production > /dev/null
ok "EC2: $INST_1 (payments-api-server)"

INST_2=$(aws ec2 run-instances $EP $R $OUT \
  --image-id "$AMI_ID" --instance-type t3.medium --count 1 \
  --query 'Instances[0].InstanceId')
aws ec2 create-tags $EP $R $OUT --resources "$INST_2" \
  --tags Key=Name,Value=identity-service-server \
         Key=app,Value=identity Key=env,Value=production > /dev/null
ok "EC2: $INST_2 (identity-service-server)"

# ── SSM parameters ────────────────────────────────────────────────────────────
log "Creating SSM parameters..."
aws ssm put-parameter $EP $R $OUT \
  --name "/appcloud/payments/db-url" \
  --value "jdbc:mysql://payments-db.internal:3306/payments" \
  --type SecureString > /dev/null
ok "SSM: /appcloud/payments/db-url"

aws ssm put-parameter $EP $R $OUT \
  --name "/appcloud/payments/api-key" \
  --value "test-api-key-12345" \
  --type SecureString > /dev/null
ok "SSM: /appcloud/payments/api-key"

aws ssm put-parameter $EP $R $OUT \
  --name "/appcloud/shared/jwt-secret" \
  --value "test-jwt-secret-localstack" \
  --type SecureString > /dev/null
ok "SSM: /appcloud/shared/jwt-secret"

# ── CloudWatch log groups ─────────────────────────────────────────────────────
log "Creating CloudWatch log groups..."
aws logs create-log-group $EP $R $OUT \
  --log-group-name "/appcloud/api" > /dev/null
ok "CloudWatch Logs: /appcloud/api"

aws logs create-log-group $EP $R $OUT \
  --log-group-name "/appcloud/payments" > /dev/null
ok "CloudWatch Logs: /appcloud/payments"

# ── Pro-only (skipped) ────────────────────────────────────────────────────────
echo ""
skip "ECS     (Pro)"
skip "EKS     (Pro)"
skip "RDS     (Pro)"
skip "ELBv2   (Pro)"
skip "ElastiCache (Pro)"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Seed complete. Resources in LocalStack:             ║"
echo "║                                                      ║"
echo "║   S3           3 buckets                             ║"
echo "║   SQS          3 queues                              ║"
echo "║   SNS          3 topics                              ║"
echo "║   DynamoDB     3 tables                              ║"
echo "║   Kinesis      2 streams                             ║"
echo "║   Lambda       3 functions                           ║"
echo "║   EC2          2 instances (mock metadata)           ║"
echo "║   IAM          2 roles                               ║"
echo "║   SSM          3 parameters                          ║"
echo "║   CloudWatch   2 log groups                          ║"
echo "║                                                      ║"
echo "║  Trigger AppCloud discovery scan:                    ║"
echo "║  curl -X POST http://localhost:3001/discovery/scan/aws║"
echo "║    -H 'Content-Type: application/json'               ║"
echo "║    -d '{\"regions\":[\"us-east-1\"]}'                    ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""