#!/usr/bin/env bash
# deploy-openshift.sh — Build and deploy AppCloud on OpenShift
# Prerequisites: oc CLI, kubectl, docker
#
# Usage:
#   export OC_PROJECT=appcloud
#   export OC_REGISTRY=image-registry.openshift-image-registry.svc:5000
#   ./k8s/scripts/deploy-openshift.sh [--skip-build]
set -euo pipefail

SKIP_BUILD=false
for arg in "$@"; do [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=true; done

: "${OC_PROJECT:=appcloud}"
: "${OC_REGISTRY:=image-registry.openshift-image-registry.svc:5000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
K8S_DIR="$ROOT_DIR/k8s"
SECRETS_DIR="$ROOT_DIR/secrets"
REGISTRY_PATH="$OC_REGISTRY/$OC_PROJECT"

echo "══════════════════════════════════════════════════"
echo "  AppCloud → OpenShift Deploy"
echo "  Project: $OC_PROJECT"
echo "══════════════════════════════════════════════════"

for cmd in oc kubectl docker; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd not found"; exit 1; }
done

# ── Login check ────────────────────────────────────────────────────────────────
oc whoami &>/dev/null || { echo "ERROR: Not logged in to OpenShift. Run: oc login"; exit 1; }

# ── Create/switch project ──────────────────────────────────────────────────────
oc get project "$OC_PROJECT" &>/dev/null || oc new-project "$OC_PROJECT"
oc project "$OC_PROJECT"

# ── SCC — allow Neo4j and Postgres to run as specific UIDs ────────────────────
echo "► Granting anyuid SCC to default service account..."
oc adm policy add-scc-to-serviceaccount anyuid -z default -n "$OC_PROJECT" 2>/dev/null || \
  echo "  (anyuid already granted or insufficient permissions — continuing)"

# ── Build and push to OpenShift internal registry ─────────────────────────────
if [[ "$SKIP_BUILD" == "false" ]]; then
  # Login to internal registry via oc token
  oc registry login 2>/dev/null || \
    docker login -u "$(oc whoami)" -p "$(oc whoami -t)" "$OC_REGISTRY"

  for svc in api ui; do
    echo "► Building and pushing appcloud-$svc..."
    docker build -t "$REGISTRY_PATH/appcloud-$svc:latest" "$ROOT_DIR/$svc"
    docker push "$REGISTRY_PATH/appcloud-$svc:latest"
  done
fi

# ── Secrets ────────────────────────────────────────────────────────────────────
echo "► Creating secrets..."
oc -n "$OC_PROJECT" delete secret appcloud-db-credentials 2>/dev/null || true
oc -n "$OC_PROJECT" create secret generic appcloud-db-credentials \
  --from-file=db_username="$SECRETS_DIR/db_username.txt" \
  --from-file=db_password="$SECRETS_DIR/db_password.txt"

oc -n "$OC_PROJECT" delete secret appcloud-pg-credentials 2>/dev/null || true
oc -n "$OC_PROJECT" create secret generic appcloud-pg-credentials \
  --from-file=pg_username="$SECRETS_DIR/pg_username.txt" \
  --from-file=pg_password="$SECRETS_DIR/pg_password.txt"

oc -n "$OC_PROJECT" delete secret appcloud-jwt-secret 2>/dev/null || true
oc -n "$OC_PROJECT" create secret generic appcloud-jwt-secret \
  --from-file=jwt_secret="$SECRETS_DIR/jwt_secret.txt"

# ── Deploy ─────────────────────────────────────────────────────────────────────
echo "► Applying kustomize overlay (openshift)..."
kubectl apply -k "$K8S_DIR/overlays/openshift"

echo "► Waiting for rollouts..."
kubectl -n "$OC_PROJECT" rollout status deployment/neo4j    --timeout=300s
kubectl -n "$OC_PROJECT" rollout status deployment/postgres --timeout=180s
kubectl -n "$OC_PROJECT" rollout status deployment/api      --timeout=180s
kubectl -n "$OC_PROJECT" rollout status deployment/ui       --timeout=180s

echo ""
ROUTE=$(oc -n "$OC_PROJECT" get route appcloud-ui -o jsonpath='{.spec.host}' 2>/dev/null || echo "pending...")
echo "══════════════════════════════════════════════════"
echo "  ✓  AppCloud is running on OpenShift!"
echo "══════════════════════════════════════════════════"
echo ""
echo "  UI Route:  https://$ROUTE"
echo "  API Route: $(oc -n $OC_PROJECT get route appcloud-api -o jsonpath='{.spec.host}' 2>/dev/null)"
echo ""
echo "  Logs:     oc -n $OC_PROJECT logs -f deploy/api"
echo "  All pods: oc -n $OC_PROJECT get pods"
echo ""
