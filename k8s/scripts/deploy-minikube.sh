#!/usr/bin/env bash
# deploy-minikube.sh — Build, load, and deploy AppCloud on minikube
# Usage: ./k8s/scripts/deploy-minikube.sh [--skip-build]
set -euo pipefail

SKIP_BUILD=false
SKIP_IMAGE_LOAD=false
for arg in "$@"; do [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=true; done
for arg in "$@"; do [[ "$arg" == "--skip-image-load" ]] && SKIP_IMAGE_LOAD=true; done

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
if [[ "$SKIP_IMAGE_LOAD" == "false" ]]; then
  echo "► Loading images into minikube (this may take a minute)..."
  minikube image load appcloud-api:latest --profile=appcloud
  minikube image load appcloud-ui:latest --profile=appcloud
  echo "  ✓ Images loaded"
else
  echo "► Skipping image load (--skip-image-load)"
fi

# ── Secrets ────────────────────────────────────────────────────────────────────
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
echo "► Applying kustomize overlay (minikube)..."
kubectl apply -k "$K8S_DIR/overlays/minikube"

# ── Wait for rollout ───────────────────────────────────────────────────────────
# Uses a manual poll instead of `rollout status --timeout` so a slow minikube
# node doesn't cause a false failure. Prints pod state every 10s.

wait_for_deployment() {
  local name=$1
  local timeout=${2:-300}
  local elapsed=0
  echo "► Waiting for $name..."
  while true; do
    local ready
    ready=$(kubectl -n appcloud get deployment "$name" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    local desired
    desired=$(kubectl -n appcloud get deployment "$name" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
    if [[ "${ready:-0}" -ge "${desired:-1}" ]]; then
      echo "  ✓ $name is ready ($ready/$desired)"
      return 0
    fi
    if [[ $elapsed -ge $timeout ]]; then
      echo "  ✗ $name not ready after ${timeout}s — current state:"
      kubectl -n appcloud get pods -l "app=$name"
      kubectl -n appcloud logs -l "app=$name" --tail=20 2>/dev/null || true
      echo ""
      echo "  Continuing anyway — run 'kubectl -n appcloud get pods' to monitor"
      return 0   # don't abort the whole script — partial deploy is still useful
    fi
    echo "  ... $name not ready yet ($ready/$desired) — ${elapsed}s elapsed"
    sleep 10
    elapsed=$((elapsed + 10))
  done
}

wait_for_deployment neo4j    360
wait_for_deployment postgres  180
wait_for_deployment api       240
wait_for_deployment ui        180

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
echo "  Access options:"
echo ""
echo "  OPTION A — Permanent (recommended, run once):"
echo "     ./setup-local-access.sh"
echo "     Then open: http://appcloud.local  (no tunnel terminal needed)"
echo ""
echo "  OPTION B — Quick tunnel (one terminal):"
echo "     minikube tunnel --profile=appcloud"
echo "     Then open: http://appcloud.local"
echo ""
echo "  OPTION C — Port forward (no tunnel):"
echo "     kubectl -n appcloud port-forward svc/ui 4000:4000"
echo "     Then open: http://localhost:4000"
echo ""
echo "  Neo4j UI:    kubectl -n appcloud port-forward svc/neo4j 7474:7474 7687:7687"
echo "               then open http://localhost:7474"
echo ""
echo "  Logs:        kubectl -n appcloud logs -f deploy/api"
echo "  All pods:    kubectl -n appcloud get pods"
echo "  Teardown:    minikube delete --profile=appcloud"
echo ""
