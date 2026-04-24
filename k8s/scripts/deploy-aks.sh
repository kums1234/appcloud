#!/usr/bin/env bash
# deploy-aks.sh — Push images to ACR and deploy AppCloud on AKS
# Prerequisites: az CLI, kubectl, docker
#
# Usage:
#   export RESOURCE_GROUP=appcloud-rg
#   export ACR_NAME=myregistry
#   export AKS_CLUSTER=appcloud-cluster
#   ./k8s/scripts/deploy-aks.sh [--skip-build]
set -euo pipefail

SKIP_BUILD=false
for arg in "$@"; do [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=true; done

: "${RESOURCE_GROUP:?Set RESOURCE_GROUP}"
: "${ACR_NAME:?Set ACR_NAME}"
: "${AKS_CLUSTER:?Set AKS_CLUSTER}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
K8S_DIR="$ROOT_DIR/k8s"
SECRETS_DIR="$ROOT_DIR/secrets"
ACR_SERVER="$ACR_NAME.azurecr.io"

AKS_NODE_VM_SIZE="${AKS_NODE_VM_SIZE:-standard_b2s_v2}"

echo "══════════════════════════════════════════════════"
echo "  AppCloud → AKS Deploy"
echo "  Cluster: $AKS_CLUSTER  ACR: $ACR_SERVER"
echo "══════════════════════════════════════════════════"

for cmd in az kubectl docker; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd not found"; exit 1; }
done

# ── Check resource group ───────────────────────────────────────────────────────
echo "► Checking resource group..."
if ! az group show --name "$RESOURCE_GROUP" --query "name" -o tsv >/dev/null 2>&1; then
  echo "► Creating resource group '$RESOURCE_GROUP'..."
  az group create --name "$RESOURCE_GROUP" --location "East US"
fi

# ── ACR login ──────────────────────────────────────────────────────────────────
echo "► Checking ACR..."
if ! az acr show --name "$ACR_NAME" --query "name" -o tsv >/dev/null 2>&1; then
  echo "► Creating ACR '$ACR_NAME'..."
  az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --sku Basic
fi

echo "► Logging into ACR..."
az acr login --name "$ACR_NAME"

# ── Build and push ─────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "false" ]]; then
  for svc in api; do
    echo "► Building and pushing appcloud-$svc..."
    docker build --platform linux/amd64 -t "$ACR_SERVER/appcloud-$svc:latest" "$ROOT_DIR/$svc"
    docker push "$ACR_SERVER/appcloud-$svc:latest"
  done
fi

# ── Update kustomization with real ACR ────────────────────────────────────────
sed -i.bak "s|myregistry.azurecr.io|$ACR_SERVER|g" \
  "$K8S_DIR/overlays/aks/kustomization.yaml"

# ── Get AKS credentials ────────────────────────────────────────────────────────
echo "► Checking AKS cluster..."
if ! az aks show --resource-group "$RESOURCE_GROUP" --name "$AKS_CLUSTER" --query "name" -o tsv >/dev/null 2>&1; then
  echo "► Creating AKS cluster '$AKS_CLUSTER' with node size '$AKS_NODE_VM_SIZE'..."
  az aks create --resource-group "$RESOURCE_GROUP" --name "$AKS_CLUSTER" --node-count 2 --node-vm-size "$AKS_NODE_VM_SIZE" --enable-addons monitoring --generate-ssh-keys
fi

echo "► Getting AKS credentials..."
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$AKS_CLUSTER" --overwrite-existing

# Attach ACR to AKS (idempotent)
echo "► Attaching ACR to AKS..."
az aks update --resource-group "$RESOURCE_GROUP" --name "$AKS_CLUSTER" --attach-acr "$ACR_NAME"

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

kubectl -n appcloud delete secret appcloud-jwt-secret 2>/dev/null || true
kubectl -n appcloud create secret generic appcloud-jwt-secret \
  --from-file=jwt_secret="$SECRETS_DIR/jwt_secret.txt"

# ── Deploy ─────────────────────────────────────────────────────────────────────
echo "► Applying kustomize overlay (aks)..."
kubectl apply -k "$K8S_DIR/overlays/aks"

echo "► Waiting for rollouts..."
kubectl -n appcloud rollout status deployment/neo4j    --timeout=300s
kubectl -n appcloud rollout status deployment/postgres --timeout=180s
kubectl -n appcloud rollout status deployment/api      --timeout=180s

echo ""
LB_IP=$(kubectl -n appcloud get ingress appcloud -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "pending...")
echo "══════════════════════════════════════════════════"
echo "  ✓  AppCloud is running on AKS!"
echo "══════════════════════════════════════════════════"
echo ""
echo "  Ingress IP: $LB_IP"
echo "  Point your DNS A record to: $LB_IP"
echo ""
echo "  Logs:     kubectl -n appcloud logs -f deploy/api"
echo "  All pods: kubectl -n appcloud get pods"
echo ""
