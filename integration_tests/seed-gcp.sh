#!/usr/bin/env bash
# seed-gcp.sh — Create stopped/idle GCP resources for AppCloud discovery.
#
# All Compute Engine instances are created then STOPPED immediately.
# Cloud Functions, Cloud Storage, and Pub/Sub are idle — minimal/zero cost.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Project set: gcloud config set project YOUR_PROJECT_ID
#   - APIs enabled: Compute, Cloud Functions, Storage, Pub/Sub, Cloud Run
#
# Usage:
#   export GCP_PROJECT=your-project-id
#   export GCP_REGION=australia-southeast1
#   chmod +x seed-gcp.sh && ./seed-gcp.sh
#
# Cleanup:
#   ./seed-gcp.sh --destroy

set -euo pipefail

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-australia-southeast1}"
ZONE="${GCP_ZONE:-${REGION}-a}"
PREFIX="appcloud-test"
DESTROY="${1:-}"

if [ -z "$PROJECT" ]; then
  echo "ERROR: Set GCP_PROJECT or run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  AppCloud GCP Seed — Stopped/Idle Resources              ║"
echo "║  Project: $PROJECT"
echo "║  Region:  $REGION"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

log()  { echo "  ▶  $*"; }
ok()   { echo "  ✓  $*"; }

# ── Destroy mode ───────────────────────────────────────────────────────────────
if [ "$DESTROY" = "--destroy" ]; then
  echo "  Destroying all AppCloud test resources..."

  # Delete Compute Engine instances
  for vm in payments-api payments-db banking-web data-worker; do
    gcloud compute instances delete "${PREFIX}-${vm}" \
      --zone="$ZONE" --project="$PROJECT" --quiet 2>/dev/null \
      && ok "VM deleted: ${PREFIX}-${vm}" || true
  done

  # Delete Cloud Functions
  for fn in process-payment send-notification ingest-events identity-auth; do
    gcloud functions delete "${PREFIX}-${fn}" \
      --region="$REGION" --project="$PROJECT" --quiet 2>/dev/null \
      && ok "Function deleted: ${PREFIX}-${fn}" || true
  done

  # Delete Cloud Storage buckets
  for bucket in payments-assets banking-static data-lake; do
    gsutil -m rm -r "gs://${PROJECT}-${PREFIX}-${bucket}" 2>/dev/null \
      && ok "Bucket deleted: ${PROJECT}-${PREFIX}-${bucket}" || true
  done

  # Delete Pub/Sub topics
  for topic in payment-events notifications data-ingestion; do
    gcloud pubsub topics delete "${PREFIX}-${topic}" \
      --project="$PROJECT" --quiet 2>/dev/null \
      && ok "Topic deleted: ${PREFIX}-${topic}" || true
  done

  echo ""
  ok "Destroy complete"
  exit 0
fi

# ── Enable required APIs ───────────────────────────────────────────────────────
log "Enabling required APIs..."
gcloud services enable \
  compute.googleapis.com \
  cloudfunctions.googleapis.com \
  storage.googleapis.com \
  pubsub.googleapis.com \
  cloudbuild.googleapis.com \
  --project="$PROJECT" --quiet
ok "APIs enabled"

# ── VPC Network ───────────────────────────────────────────────────────────────
log "Creating VPC network..."
gcloud compute networks create "${PREFIX}-vpc" \
  --project="$PROJECT" \
  --subnet-mode=custom \
  --quiet 2>/dev/null || ok "VPC already exists"

gcloud compute networks subnets create "${PREFIX}-subnet-private" \
  --project="$PROJECT" \
  --network="${PREFIX}-vpc" \
  --region="$REGION" \
  --range=10.0.1.0/24 \
  --quiet 2>/dev/null || ok "Private subnet already exists"

gcloud compute networks subnets create "${PREFIX}-subnet-public" \
  --project="$PROJECT" \
  --network="${PREFIX}-vpc" \
  --region="$REGION" \
  --range=10.0.2.0/24 \
  --quiet 2>/dev/null || ok "Public subnet already exists"
ok "VPC: ${PREFIX}-vpc with 2 subnets"

# ── Firewall rules ────────────────────────────────────────────────────────────
log "Creating firewall rule..."
gcloud compute firewall-rules create "${PREFIX}-allow-internal" \
  --project="$PROJECT" \
  --network="${PREFIX}-vpc" \
  --allow tcp,udp,icmp \
  --source-ranges 10.0.0.0/16 \
  --target-tags appcloud-test \
  --quiet 2>/dev/null || ok "Firewall rule already exists"
ok "Firewall: internal traffic allowed"

# ── Compute Engine Instances — stopped immediately ────────────────────────────
# GCP labels: lowercase, hyphens only, no colons
# AppCloud reads these labels from the GCP API during discovery:
#   appcloud-app       → Application name
#   appcloud-component → Component name
#   appcloud-env       → Environment
#   appcloud-tier      → Tier (1-4)
#   appcloud-owner     → Team owner

log "Creating Compute Engine instances (will be stopped immediately)..."

create_instance() {
  local name=$1 app=$2 component=$3 owner=$4 tier=$5 subnet=$6
  local LABEL_APP=$(echo "$app" | tr '[:upper:] ' '[:lower:]-')
  local LABEL_OWNER=$(echo "$owner" | tr '[:upper:] ' '[:lower:]-')

  gcloud compute instances create "${PREFIX}-${name}" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --machine-type=e2-micro \
    --network="${PREFIX}-vpc" \
    --subnet="${PREFIX}-subnet-${subnet}" \
    --no-address \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size=10GB \
    --boot-disk-type=pd-standard \
    --labels \
      "project=${PREFIX},appcloud-app=${LABEL_APP},appcloud-component=$(echo $component | tr '[:upper:]' '[:lower:]'),appcloud-owner=${LABEL_OWNER},appcloud-tier=${tier},appcloud-env=production,managed-by=appcloud" \
    --metadata \
      "appcloud-app=${app},appcloud-component=${component},appcloud-owner=${owner},appcloud-tier=${tier}" \
    --quiet
  ok "VM created: ${PREFIX}-${name} ($app / $component)"
}

create_instance "payments-api" "Payments Platform" "api"    "payments-platform-team" "1" "private"
create_instance "payments-db"  "Payments Platform" "db"     "payments-platform-team" "1" "private"
create_instance "banking-web"  "Online Banking"    "web"    "online-banking-team"    "1" "public"
create_instance "data-worker"  "Data Platform"     "worker" "data-engineering-team"  "3" "private"

log "Stopping all instances (no compute charges when stopped)..."
gcloud compute instances stop \
  "${PREFIX}-payments-api" \
  "${PREFIX}-payments-db" \
  "${PREFIX}-banking-web" \
  "${PREFIX}-data-worker" \
  --zone="$ZONE" \
  --project="$PROJECT" \
  --quiet
ok "All instances stopped — no compute charges"

# ── Cloud Functions — zero cost until invoked ─────────────────────────────────
log "Creating Cloud Functions..."

# Create a minimal function source
mkdir -p /tmp/appcloud-fn-src
cat > /tmp/appcloud-fn-src/index.js << 'FNEOF'
exports.handler = (req, res) => res.status(200).json({ status: 'ok' })
FNEOF
cat > /tmp/appcloud-fn-src/package.json << 'PKGEOF'
{"name":"appcloud-test-fn","version":"1.0.0","main":"index.js"}
PKGEOF

create_function() {
  local fn_name=$1 app=$2 component=$3 owner=$4 tier=$5
  local LABEL_APP=$(echo "$app" | tr '[:upper:] ' '[:lower:]-')
  gcloud functions deploy "${PREFIX}-${fn_name}" \
    --project="$PROJECT" \
    --region="$REGION" \
    --runtime=nodejs20 \
    --trigger-http \
    --source=/tmp/appcloud-fn-src \
    --entry-point=handler \
    --no-allow-unauthenticated \
    --max-instances=1 \
    --labels \
      "project=${PREFIX},appcloud-app=${LABEL_APP},appcloud-component=$(echo $component | tr '[:upper:]' '[:lower:]'),appcloud-owner=$(echo $owner | tr '[:upper:] ' '[:lower:]-'),appcloud-tier=${tier},appcloud-env=production" \
    --quiet
  ok "Cloud Function: ${PREFIX}-${fn_name} ($app / $component)"
}

create_function "process-payment"   "Payments Platform" "paymentprocessor" "payments-platform-team" "1"
create_function "send-notification" "Payments Platform" "notifier"         "payments-platform-team" "1"
create_function "ingest-events"     "Data Platform"     "eventingester"    "data-engineering-team"  "3"
create_function "identity-auth"     "Online Banking"    "authservice"      "online-banking-team"    "1"

# ── Cloud Storage — zero cost when empty ──────────────────────────────────────
log "Creating Cloud Storage buckets..."

create_bucket() {
  local suffix=$1 app=$2 component=$3
  local BNAME="${PROJECT}-${PREFIX}-${suffix}"
  local LABEL_APP=$(echo "$app" | tr '[:upper:] ' '[:lower:]-')
  gsutil mb -p "$PROJECT" -l "$REGION" -c STANDARD "gs://${BNAME}"
  gsutil label ch \
    -l "project:${PREFIX}" \
    -l "appcloud-app:${LABEL_APP}" \
    -l "appcloud-component:$(echo $component | tr '[:upper:]' '[:lower:]')" \
    -l "appcloud-env:production" \
    "gs://${BNAME}"
  ok "Storage: gs://${BNAME} ($app)"
}

create_bucket "payments-assets" "Payments Platform" "assetstore"
create_bucket "banking-static"  "Online Banking"    "staticassets"
create_bucket "data-lake"       "Data Platform"     "datalake"

# ── Pub/Sub — zero cost with no messages ──────────────────────────────────────
log "Creating Pub/Sub topics..."

create_topic() {
  local name=$1 app=$2 component=$3
  local LABEL_APP=$(echo "$app" | tr '[:upper:] ' '[:lower:]-')
  gcloud pubsub topics create "${PREFIX}-${name}" \
    --project="$PROJECT" \
    --labels \
      "project=${PREFIX},appcloud-app=${LABEL_APP},appcloud-component=$(echo $component | tr '[:upper:]' '[:lower:]')" \
    --quiet
  ok "Pub/Sub: ${PREFIX}-${name} ($app)"
}

create_topic "payment-events"  "Payments Platform" "eventbus"
create_topic "notifications"   "Payments Platform" "notifier"
create_topic "data-ingestion"  "Data Platform"     "eventingester"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  GCP Seed Complete                                       ║"
echo "║                                                          ║"
echo "║  Compute VMs    4 (STOPPED — no compute charge)          ║"
echo "║  Cloud Functions 4 (idle — minimal charge)               ║"
echo "║  Cloud Storage  3 buckets (empty — no charge)            ║"
echo "║  Pub/Sub        3 topics  (no messages — no charge)      ║"
echo "║                                                          ║"
echo "║  Estimated cost: ~\$0.10/month (pd-standard disks only)   ║"
echo "║                                                          ║"
echo "║  AppCloud mapping labels:                                ║"
echo "║    appcloud-app       → Application name                 ║"
echo "║    appcloud-component → Component name                   ║"
echo "║    appcloud-env       → Environment                      ║"
echo "║    appcloud-tier      → Tier (1-4)                       ║"
echo "║    appcloud-owner     → Team owner                       ║"
echo "║                                                          ║"
echo "║  Run discovery:                                          ║"
echo "║  curl -X POST http://localhost:3000/discovery/scan/gcp   ║"
echo "║    -H 'Content-Type: application/json'                   ║"
echo "║    -d '{\"projectId\":\"$PROJECT\"}'  ║"
echo "║                                                          ║"
echo "║  Cleanup: ./seed-gcp.sh --destroy                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
