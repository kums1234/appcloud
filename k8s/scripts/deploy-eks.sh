#!/usr/bin/env bash
# deploy-eks.sh — Push images to ECR and deploy AppCloud on EKS
# Prerequisites: aws CLI, eksctl, kubectl, docker, jq
#
# Usage:
#   export AWS_ACCOUNT_ID=123456789012
#   export AWS_REGION=us-east-1
#   export EKS_CLUSTER=appcloud-cluster
#   ./k8s/scripts/deploy-eks.sh [--skip-build]
set -euo pipefail

SKIP_BUILD=false
for arg in "$@"; do [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=true; done

: "${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
: "${AWS_REGION:=${AWS_DEFAULT_REGION:-us-east-1}}"
: "${EKS_CLUSTER:?Set EKS_CLUSTER}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
K8S_DIR="$ROOT_DIR/k8s"
SECRETS_DIR="$ROOT_DIR/secrets"
ECR_BASE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

echo "══════════════════════════════════════════════════"
echo "  AppCloud → EKS Deploy"
echo "  Cluster: $EKS_CLUSTER  Region: $AWS_REGION"
echo "══════════════════════════════════════════════════"

for cmd in aws kubectl docker jq; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd not found"; exit 1; }
done

# ── ECR login ──────────────────────────────────────────────────────────────────
echo "► Authenticating to ECR..."
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$ECR_BASE"

# ── Ensure ECR repos exist ─────────────────────────────────────────────────────
for repo in appcloud-api; do
  aws ecr describe-repositories --repository-names "$repo" --region "$AWS_REGION" &>/dev/null || \
    aws ecr create-repository --repository-name "$repo" --region "$AWS_REGION" | jq -r '.repository.repositoryUri'
  echo "  ✓ ECR repo: $ECR_BASE/$repo"
done

# ── Build and push ─────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "false" ]]; then
  for svc in api; do
    echo "► Building and pushing appcloud-$svc..."
    docker build -t "$ECR_BASE/appcloud-$svc:latest" "$ROOT_DIR/$svc"
    docker push "$ECR_BASE/appcloud-$svc:latest"
  done
fi

# ── Update kubeconfig for EKS ─────────────────────────────────────────────────
echo "► Updating kubeconfig..."
aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "$AWS_REGION"

# ── Update kustomization with real ECR paths ──────────────────────────────────
# Patch the overlay in place (sed on the ECR placeholder)
sed -i.bak "s|123456789012.dkr.ecr.us-east-1.amazonaws.com|$ECR_BASE|g" \
  "$K8S_DIR/overlays/eks/kustomization.yaml"

# ── Namespace + secrets ────────────────────────────────────────────────────────
echo "► Creating namespace and secrets..."
kubectl apply -f "$K8S_DIR/base/namespace.yaml" || true

kubectl -n appcloud delete secret appcloud-db-credentials 2>/dev/null || true
kubectl -n appcloud create secret generic appcloud-db-credentials \
  --from-file=db_username="$SECRETS_DIR/db_username.txt" \
  --from-file=db_password="$SECRETS_DIR/db_password.txt"

kubectl -n appcloud delete secret appcloud-pg-credentials 2>/dev/null || true
kubectl -n appcloud create secret generic appcloud-pg-credentials \
  --from-file=pg_username="$SECRETS_DIR/pg_username.txt" \
  --from-file=pg_password="$SECRETS_DIR/pg_password.txt"

kubectl -n appcloud delete secret appcloud-api-key 2>/dev/null || true
kubectl -n appcloud create secret generic appcloud-api-key \
  --from-file=appcloud_api_key="$SECRETS_DIR/appcloud_api_key.txt"

kubectl -n appcloud delete secret appcloud-encryption-key 2>/dev/null || true
kubectl -n appcloud create secret generic appcloud-encryption-key \
  --from-file=appcloud_encryption_key="$SECRETS_DIR/appcloud_encryption_key.txt"

# ── Deploy ─────────────────────────────────────────────────────────────────────
echo "► Applying kustomize overlay (eks)..."
kubectl apply -k "$K8S_DIR/overlays/eks"

echo "► Waiting for rollouts..."
kubectl -n appcloud rollout status deployment/neo4j   --timeout=300s
kubectl -n appcloud rollout status deployment/postgres --timeout=180s
kubectl -n appcloud rollout status deployment/api      --timeout=180s

# ── Print ALB hostname ─────────────────────────────────────────────────────────
echo ""
sleep 10
ALB=$(kubectl -n appcloud get ingress appcloud -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "pending...")
echo "══════════════════════════════════════════════════"
echo "  ✓  AppCloud is running on EKS!"
echo "══════════════════════════════════════════════════"
echo ""
echo "  ALB hostname: $ALB"
echo "  (DNS may take 2-3 minutes to propagate)"
echo ""
echo "  Create a CNAME in Route 53 pointing your domain to:"
echo "  $ALB"
echo ""
echo "  Logs:     kubectl -n appcloud logs -f deploy/api"
echo "  All pods: kubectl -n appcloud get pods"
echo ""
