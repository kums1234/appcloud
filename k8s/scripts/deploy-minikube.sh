#!/usr/bin/env bash
# deploy-minikube.sh — Smart build, load, and deploy AppCloud on minikube
#
# Usage:
#   ./k8s/scripts/deploy-minikube.sh              # full deploy (build only if changed)
#   ./k8s/scripts/deploy-minikube.sh --force       # force rebuild even if images match
#   ./k8s/scripts/deploy-minikube.sh --skip-build  # skip build + load entirely
#   ./k8s/scripts/deploy-minikube.sh --api-only    # rebuild only the API image
#   ./k8s/scripts/deploy-minikube.sh --ui-only     # rebuild only the UI image
#
# Smart behavior:
#   - Compares local Docker image IDs with minikube's image IDs
#   - Only builds if source files changed (Docker layer cache handles this)
#   - Only loads into minikube if the image ID differs
#   - Only restarts pods that received a new image
set -euo pipefail

SKIP_BUILD=false
FORCE_BUILD=false
API_ONLY=false
UI_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --force)      FORCE_BUILD=true ;;
    --api-only)   API_ONLY=true ;;
    --ui-only)    UI_ONLY=true ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
K8S_DIR="$ROOT_DIR/k8s"
SECRETS_DIR="$ROOT_DIR/secrets"
PROFILE="appcloud"

echo "══════════════════════════════════════════════════"
echo "  AppCloud → Minikube Deploy"
echo "══════════════════════════════════════════════════"

# ── Prerequisites ─────────────────────────────────────────────────────────────
for cmd in minikube kubectl docker; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd not found in PATH"; exit 1; }
done

# ── Start minikube if not running ─────────────────────────────────────────────
if ! minikube status --profile=$PROFILE &>/dev/null; then
  echo "► Starting minikube (profile: $PROFILE)..."
  minikube start \
    --profile=$PROFILE \
    --driver=docker \
    --cpus=4 \
    --memory=6g \
    --disk-size=30g \
    --container-runtime=docker
fi

echo "► Enabling required addons..."
minikube addons enable ingress             --profile=$PROFILE 2>/dev/null || true
minikube addons enable storage-provisioner --profile=$PROFILE 2>/dev/null || true

# ── Helper: get image ID from local Docker ────────────────────────────────────
local_image_id() {
  docker images --format '{{.ID}}' "$1" 2>/dev/null | head -1
}

# ── Helper: get image ID inside minikube ──────────────────────────────────────
minikube_image_id() {
  minikube ssh --profile=$PROFILE -- \
    "docker images --format '{{.ID}}' '$1' 2>/dev/null | head -1" 2>/dev/null || echo ""
}

# ── Smart build + load ────────────────────────────────────────────────────────
NEEDS_RESTART_API=false
NEEDS_RESTART_UI=false

if [[ "$SKIP_BUILD" == "true" ]]; then
  echo "► Skipping build + load (--skip-build)"
else
  build_and_load() {
    local name=$1 context=$2
    local image="${name}:latest"

    echo ""
    echo "── $name ─────────────────────────────────"

    # Step 1: Get current image IDs
    local local_before=$(local_image_id "$image")
    local mk_before=$(minikube_image_id "$image")
    echo "  Local image:    ${local_before:-<none>}"
    echo "  Minikube image: ${mk_before:-<none>}"

    # Step 2: Build (Docker layer cache makes this fast if nothing changed)
    if [[ "$FORCE_BUILD" == "true" ]] || [[ -z "$local_before" ]]; then
      echo "  ► Building (force=$FORCE_BUILD)..."
      docker build -t "$image" "$context" --quiet 2>&1 | tail -1
    else
      echo "  ► Building (cached layers if unchanged)..."
      docker build -t "$image" "$context" --quiet 2>&1 | tail -1
    fi

    local local_after=$(local_image_id "$image")
    echo "  Built image:    $local_after"

    # Step 3: Compare — only load if image actually changed
    if [[ "$local_after" == "$mk_before" ]] && [[ "$FORCE_BUILD" == "false" ]]; then
      echo "  ✓ Image unchanged in minikube — skipping load"
      return 0
    fi

    # Step 4: Load into minikube
    echo "  ► Loading into minikube..."
    minikube image load "$image" --profile=$PROFILE 2>&1

    # Step 5: Verify the loaded image
    local mk_after=$(minikube_image_id "$image")
    if [[ "$mk_after" == "$local_after" ]]; then
      echo "  ✓ Loaded and verified ($mk_after)"
    else
      echo "  ⚠ Image ID mismatch after load (local=$local_after, minikube=$mk_after)"
      echo "    Removing stale image and reloading..."
      minikube ssh --profile=$PROFILE -- "docker rmi '$image' 2>/dev/null" || true
      minikube image load "$image" --profile=$PROFILE 2>&1
      mk_after=$(minikube_image_id "$image")
      echo "  ✓ Reloaded ($mk_after)"
    fi

    # Flag restart needed
    if [[ "$name" == "appcloud-api" ]]; then NEEDS_RESTART_API=true; fi
    if [[ "$name" == "appcloud-ui" ]];  then NEEDS_RESTART_UI=true; fi
  }

  if [[ "$UI_ONLY" == "false" ]]; then
    build_and_load "appcloud-api" "$ROOT_DIR/api"
  fi
  if [[ "$API_ONLY" == "false" ]]; then
    build_and_load "appcloud-ui" "$ROOT_DIR/ui"
  fi
fi

# ── Secrets ───────────────────────────────────────────────────────────────────
echo ""
echo "► Creating namespace and secrets..."
kubectl apply -f "$K8S_DIR/base/namespace.yaml" 2>/dev/null || true

for secret_name in appcloud-db-credentials appcloud-pg-credentials appcloud-jwt-secret; do
  kubectl -n appcloud get secret "$secret_name" &>/dev/null && continue
  case "$secret_name" in
    appcloud-db-credentials)
      kubectl -n appcloud create secret generic "$secret_name" \
        --from-file=db_username="$SECRETS_DIR/db_username.txt" \
        --from-file=db_password="$SECRETS_DIR/db_password.txt" ;;
    appcloud-pg-credentials)
      kubectl -n appcloud create secret generic "$secret_name" \
        --from-file=pg_username="$SECRETS_DIR/pg_username.txt" \
        --from-file=pg_password="$SECRETS_DIR/pg_password.txt" ;;
    appcloud-jwt-secret)
      kubectl -n appcloud create secret generic "$secret_name" \
        --from-file=jwt_secret="$SECRETS_DIR/jwt_secret.txt" ;;
  esac
  echo "  ✓ Created $secret_name"
done

# ── Deploy ────────────────────────────────────────────────────────────────────
echo "► Applying kustomize overlay (minikube)..."
kubectl apply -k "$K8S_DIR/overlays/minikube"

# ── Wait for infra services first ─────────────────────────────────────────────
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
      echo "  ✓ $name ready ($ready/$desired)"
      return 0
    fi
    if [[ $elapsed -ge $timeout ]]; then
      echo "  ✗ $name not ready after ${timeout}s"
      kubectl -n appcloud get pods -l "app=$name" --no-headers 2>/dev/null || true
      return 0
    fi
    sleep 10
    elapsed=$((elapsed + 10))
  done
}

wait_for_deployment neo4j    360
wait_for_deployment postgres  180

# ── Restart only the pods that got new images ─────────────────────────────────
if [[ "$NEEDS_RESTART_API" == "true" ]]; then
  echo "► Restarting API pods (new image loaded)..."
  kubectl -n appcloud delete pod -l app=api --wait=false 2>/dev/null || true
fi
if [[ "$NEEDS_RESTART_UI" == "true" ]]; then
  echo "► Restarting UI pods (new image loaded)..."
  kubectl -n appcloud delete pod -l app=ui --wait=false 2>/dev/null || true
fi

wait_for_deployment api 240
wait_for_deployment ui  180

# ── /etc/hosts ────────────────────────────────────────────────────────────────
if grep -q "appcloud.local" /etc/hosts; then
  echo "► appcloud.local already in /etc/hosts"
else
  echo "► Adding appcloud.local to /etc/hosts (requires sudo)..."
  echo "127.0.0.1  appcloud.local" | sudo tee -a /etc/hosts
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo "  ✓  AppCloud is running on Minikube!"
echo "══════════════════════════════════════════════════"
echo ""
echo "  Image status:"
echo "    API: $(local_image_id appcloud-api:latest) (local) / $(minikube_image_id appcloud-api:latest) (minikube)"
echo "    UI:  $(local_image_id appcloud-ui:latest) (local) / $(minikube_image_id appcloud-ui:latest) (minikube)"
echo ""
echo "  Access:"
echo "    Port forward:  kubectl -n appcloud port-forward svc/ui 4000:4000"
echo "                   then open http://localhost:4000"
echo "    Tunnel:        minikube tunnel --profile=$PROFILE"
echo "                   then open http://appcloud.local"
echo ""
echo "  Quick redeploy (code changes only):"
echo "    ./k8s/scripts/deploy-minikube.sh --api-only    # API changes"
echo "    ./k8s/scripts/deploy-minikube.sh --ui-only     # UI changes"
echo "    ./k8s/scripts/deploy-minikube.sh --force       # force full rebuild"
echo ""
echo "  Logs:      kubectl -n appcloud logs -f deploy/api"
echo "  Pods:      kubectl -n appcloud get pods"
echo "  Neo4j:     kubectl -n appcloud port-forward svc/neo4j 7474:7474 7687:7687"
echo "  Teardown:  minikube delete --profile=$PROFILE"
echo ""
