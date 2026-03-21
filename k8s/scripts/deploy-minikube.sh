#!/usr/bin/env bash
# deploy-minikube.sh — Build, load, and deploy AppCloud on minikube
# Usage: ./k8s/scripts/deploy-minikube.sh [--skip-build]
set -euo pipefail

SKIP_BUILD=false
for arg in "$@"; do [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=true; done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
K8S_DIR="$ROOT_DIR/k8s"
SECRETS_DIR="$ROOT_DIR/secrets"

echo "══════════════════════════════════════════════════"
echo "  AppCloud → Minikube Deploy"
echo "══════════════════════════════════════════════════"

# ── Prerequisites check ────────────────────────────────────────────────────────
for cmd in minikube kubectl docker; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd not found"; exit 1; }
done

# ── Start minikube if not running ──────────────────────────────────────────────
if ! minikube status --profile=appcloud &>/dev/null; then
  echo "► Starting minikube (profile: appcloud)..."
  minikube start \
    --profile=appcloud \
    --driver=docker \
    --cpus=4 \
    --memory=6g \
    --disk-size=30g \
    --container-runtime=containerd
  # No --kubernetes-version pin: let minikube choose a version compatible
  # with the local binaries. Pinning to v1.29.0 caused kubelet flag conflicts.
fi

echo "► Enabling required addons..."
minikube addons enable ingress             --profile=appcloud
minikube addons enable storage-provisioner --profile=appcloud

# ── Build images with local Docker, then load into minikube ───────────────────
# We do NOT use `eval $(minikube docker-env)`.
# On Mac with Docker Desktop the daemon redirect is unreliable — instead we
# build normally against the local daemon and push the resulting image tarballs
# into the minikube node with `minikube image load`.
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo "► Building appcloud-api image..."
  docker build -t appcloud-api:latest "$ROOT_DIR/api"

  echo "► Building appcloud-ui image..."
  docker build -t appcloud-ui:latest "$ROOT_DIR/ui"
else
  echo "► Skipping image build (--skip-build)"
fi

echo "► Loading images into minikube (this may take a minute)..."
minikube image load appcloud-api:latest --profile=appcloud
minikube image load appcloud-ui:latest --profile=appcloud
echo "  ✓ Images loaded"

# ── Secrets ────────────────────────────────────────────────────────────────────
echo "► Creating namespace and secrets..."
kubectl apply -f "$K8S_DIR/base/namespace.yaml" || true

# Idempotent — delete + recreate so re-runs always pick up fresh secret files
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
echo "► Applying kustomize overlay (minikube)..."
kubectl apply -k "$K8S_DIR/overlays/minikube"

# ── Wait for rollout ───────────────────────────────────────────────────────────
echo "► Waiting for Neo4j to be ready (this takes ~60s)..."
kubectl -n appcloud rollout status deployment/neo4j --timeout=180s

echo "► Waiting for Postgres..."
kubectl -n appcloud rollout status deployment/postgres --timeout=120s

echo "► Waiting for API..."
kubectl -n appcloud rollout status deployment/api --timeout=120s

echo "► Waiting for UI..."
kubectl -n appcloud rollout status deployment/ui --timeout=120s

# ── /etc/hosts ────────────────────────────────────────────────────────────────
# On Mac with the Docker driver, minikube tunnel binds to 127.0.0.1 — not the
# minikube node IP. So we always write 127.0.0.1, not $(minikube ip).
if grep -q "appcloud.local" /etc/hosts; then
  echo "► appcloud.local already in /etc/hosts"
else
  echo "► Adding appcloud.local to /etc/hosts (requires sudo)..."
  echo "127.0.0.1  appcloud.local" | sudo tee -a /etc/hosts
fi

echo ""
echo "══════════════════════════════════════════════════"
echo "  ✓  AppCloud is running on Minikube!"
echo "══════════════════════════════════════════════════"
echo ""
echo "  ⚠  On Mac you must run minikube tunnel in a separate terminal:"
echo "     minikube tunnel --profile=appcloud"
echo "     (keep it running — it requires sudo)"
echo ""
echo "  UI:          http://appcloud.local"
echo "  API health:  http://appcloud.local/health"
echo ""
echo "  OR skip tunnel and use port-forward directly:"
echo "     kubectl -n appcloud port-forward svc/ui 4000:4000"
echo "     then open http://localhost:4000"
echo ""
echo "  Neo4j UI:    kubectl -n appcloud port-forward svc/neo4j 7474:7474"
echo "               then open http://localhost:7474"
echo ""
echo "  Logs:        kubectl -n appcloud logs -f deploy/api"
echo "  All pods:    kubectl -n appcloud get pods"
echo "  Teardown:    minikube delete --profile=appcloud"
echo ""
