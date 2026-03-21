#!/usr/bin/env bash
# seed-azure.sh — Create idle Azure resources for AppCloud discovery testing.
#
# VMs are created using the smallest available SKU and DEALLOCATED immediately.
# Deallocated VMs consume ZERO vCPU quota. Only the OS disk is billed (~$1.50/mo
# for all four). Non-VM resources (Function Apps, Storage, Service Bus) are free
# or near-free when idle.
#
# Prerequisites:
#   az login
#   az account set --subscription YOUR_SUBSCRIPTION_ID
#
# Usage:
#   export AZURE_SUBSCRIPTION=your-subscription-id
#   export AZURE_LOCATION=australiaeast
#   chmod +x seed-azure.sh && ./seed-azure.sh
#
# Cleanup:
#   ./seed-azure.sh --destroy

set -euo pipefail

LOCATION="${AZURE_LOCATION:-australiaeast}"
RG="appcloud-test-rg"
PREFIX="appcloud-test"
DESTROY="${1:-}"

# Set subscription explicitly to avoid stale session issues
if [ -n "${AZURE_SUBSCRIPTION:-}" ]; then
  az account set --subscription "$AZURE_SUBSCRIPTION"
fi

SUBSCRIPTION_ID=$(az account show --query 'id' -o tsv)
ACCT_SHORT=$(echo "$SUBSCRIPTION_ID" | tr -d '-' | cut -c1-8)

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  AppCloud Azure Seed                                     ║"
echo "║  Subscription : $SUBSCRIPTION_ID"
echo "║  Location     : $LOCATION"
echo "║  Resource Group: $RG"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

log()  { echo "  ▶  $*"; }
ok()   { echo "  ✓  $*"; }
skip() { echo "  –  $* (skipped)"; }

# ── Destroy ───────────────────────────────────────────────────────────────────
if [ "$DESTROY" = "--destroy" ]; then
  log "Deleting resource group $RG..."
  az group delete --name "$RG" --yes --no-wait
  ok "Deletion initiated"
  exit 0
fi

# ── Register required resource providers ──────────────────────────────────────
log "Registering resource providers..."
for provider in \
  Microsoft.Storage \
  Microsoft.Web \
  Microsoft.ServiceBus \
  Microsoft.KeyVault \
  Microsoft.Compute \
  Microsoft.Network; do
  az provider register --namespace "$provider" --wait --output none 2>/dev/null || true
done
ok "Resource providers registered"

# ── Resource group ────────────────────────────────────────────────────────────
log "Creating resource group..."
az group create \
  --name "$RG" \
  --location "$LOCATION" \
  --tags Project=appcloud-test \
  --output none
ok "Resource group: $RG"

# ── Virtual Network (needed for VMs) ─────────────────────────────────────────
log "Creating Virtual Network..."
az network vnet create \
  --resource-group "$RG" \
  --name "${PREFIX}-vnet" \
  --address-prefix 10.0.0.0/16 \
  --subnet-name "${PREFIX}-subnet" \
  --subnet-prefix 10.0.1.0/24 \
  --tags Project=appcloud-test \
  --output none
ok "VNet: ${PREFIX}-vnet"

# ── Find smallest available VM SKU ───────────────────────────────────────────
log "Finding smallest available VM SKU in $LOCATION..."

# Try SKUs in order of size, use first available one
VM_SIZE=""
for candidate in Standard_B1ls Standard_B1s Standard_B1ms Standard_A1_v2 Standard_D1_v2 Standard_F1s; do
  available=$(az vm list-skus \
    --location "$LOCATION" \
    --size "$candidate" \
    --query "[?restrictions == [] && name == '$candidate'].name" \
    --output tsv 2>/dev/null || true)
  if [ "$available" = "$candidate" ]; then
    VM_SIZE="$candidate"
    ok "VM SKU: $VM_SIZE (smallest available)"
    break
  fi
done

if [ -z "$VM_SIZE" ]; then
  skip "No small VM SKU available — skipping VMs, using Web Apps instead"
  SKIP_VMS=true
else
  SKIP_VMS=false
fi

# ── VMs — created then immediately deallocated ────────────────────────────────
# Deallocated = zero vCPU quota consumed, only OS disk billed (~$0.40/VM/month)
# NOTE: az vm stop ≠ az vm deallocate
#   stop       → OS shuts down, Azure KEEPS compute allocation → quota still used
#   deallocate → Azure releases compute entirely → zero quota

create_vm() {
  local vm_name=$1 app=$2 component=$3 owner=$4 tier=$5

  log "Creating VM: ${PREFIX}-${vm_name} ($VM_SIZE)..."
  az vm create \
    --resource-group "$RG" \
    --name "${PREFIX}-${vm_name}" \
    --image Ubuntu2204 \
    --size "$VM_SIZE" \
    --vnet-name "${PREFIX}-vnet" \
    --subnet "${PREFIX}-subnet" \
    --admin-username azureuser \
    --generate-ssh-keys \
    --public-ip-address "" \
    --no-wait \
    --tags \
      Project=appcloud-test \
      "appcloud-app=${app}" \
      "appcloud-component=${component}" \
      "appcloud-owner=${owner}" \
      "appcloud-tier=${tier}" \
      "appcloud-env=production" \
    --output none
}

if [ "$SKIP_VMS" = "false" ]; then
  # Create all VMs with --no-wait so they provision in parallel
  create_vm "payments-api" "Payments Platform" "API"    "payments-platform-team" "1"
  create_vm "banking-web"  "Online Banking"    "Web"    "online-banking-team"    "1"
  create_vm "data-worker"  "Data Platform"     "Worker" "data-engineering-team"  "3"

  log "Waiting for VMs to finish provisioning..."
  az vm wait \
    --resource-group "$RG" \
    --ids $(az vm list --resource-group "$RG" --query '[].id' -o tsv) \
    --created \
    --output none
  ok "VMs provisioned"

  log "Deallocating all VMs — releases vCPU quota, OS disk only billed..."
  az vm deallocate \
    --resource-group "$RG" \
    --ids $(az vm list --resource-group "$RG" --query '[].id' -o tsv) \
    --output none
  ok "All VMs DEALLOCATED — 0 cores in quota, ~\$1.20/month disk only"
fi

# ── Storage Account for Function Apps ────────────────────────────────────────
log "Creating storage account for Function Apps..."
FN_STORAGE="appcloudfn${ACCT_SHORT}"
az storage account create \
  --resource-group "$RG" \
  --name "$FN_STORAGE" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --allow-blob-public-access false \
  --tags Project=appcloud-test "appcloud-app=Shared Infrastructure" \
  --output none
ok "Storage: $FN_STORAGE"

# ── Function Apps — consumption plan ─────────────────────────────────────────
log "Creating Function Apps..."

create_fn() {
  local name=$1 app=$2 component=$3 owner=$4 tier=$5
  az functionapp create \
    --resource-group "$RG" \
    --name "${PREFIX}-${name}" \
    --storage-account "$FN_STORAGE" \
    --consumption-plan-location "$LOCATION" \
    --runtime node \
    --runtime-version 20 \
    --functions-version 4 \
    --tags \
      Project=appcloud-test \
      "appcloud-app=${app}" \
      "appcloud-component=${component}" \
      "appcloud-owner=${owner}" \
      "appcloud-tier=${tier}" \
      "appcloud-env=production" \
    --output none
  ok "Function App: ${PREFIX}-${name}  →  $app / $component"
}

create_fn "process-payment"   "Payments Platform" "PaymentProcessor" "payments-platform-team" "1"
create_fn "send-notification" "Payments Platform" "Notifier"         "payments-platform-team" "1"
create_fn "ingest-events"     "Data Platform"     "EventIngester"    "data-engineering-team"  "3"
create_fn "identity-auth"     "Online Banking"    "AuthService"      "online-banking-team"    "1"

# ── App Storage Accounts ──────────────────────────────────────────────────────
log "Creating application Storage Accounts..."

create_storage() {
  local suffix=$1 app=$2 component=$3
  local NAME="appcloud${suffix}${ACCT_SHORT}"
  NAME="${NAME:0:24}"
  az storage account create \
    --resource-group "$RG" \
    --name "$NAME" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --allow-blob-public-access false \
    --tags \
      Project=appcloud-test \
      "appcloud-app=${app}" \
      "appcloud-component=${component}" \
      "appcloud-env=production" \
    --output none
  ok "Storage: $NAME  →  $app"
}

create_storage "pay"  "Payments Platform" "AssetStore"
create_storage "bank" "Online Banking"    "StaticAssets"
create_storage "data" "Data Platform"     "DataLake"

# ── Service Bus — Basic tier ──────────────────────────────────────────────────
log "Creating Service Bus..."
az servicebus namespace create \
  --resource-group "$RG" \
  --name "${PREFIX}-servicebus" \
  --location "$LOCATION" \
  --sku Basic \
  --tags \
    Project=appcloud-test \
    "appcloud-app=Payments Platform" \
    "appcloud-component=EventBus" \
    "appcloud-tier=1" \
  --output none

for q in payment-events notification-queue; do
  az servicebus queue create \
    --resource-group "$RG" \
    --namespace-name "${PREFIX}-servicebus" \
    --name "$q" \
    --output none
  ok "Service Bus queue: $q"
done

# ── Key Vault ─────────────────────────────────────────────────────────────────
log "Creating Key Vault..."
az keyvault create \
  --resource-group "$RG" \
  --name "${PREFIX}-kv-${ACCT_SHORT}" \
  --location "$LOCATION" \
  --sku standard \
  --tags \
    Project=appcloud-test \
    "appcloud-app=Shared Infrastructure" \
    "appcloud-component=SecretsManager" \
  --output none
ok "Key Vault: ${PREFIX}-kv-${ACCT_SHORT}"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Azure Seed Complete                                     ║"
echo "║                                                          ║"
if [ "$SKIP_VMS" = "false" ]; then
echo "║  VMs           3 DEALLOCATED ($VM_SIZE)              ║"
echo "║                0 vCPU quota used, ~\$1.20/mo disk         ║"
else
echo "║  VMs           skipped (no SKU available)                ║"
fi
echo "║  Function Apps 4  (consumption — free when idle)         ║"
echo "║  Storage Accts 4  (~\$0.02/mo each, empty)               ║"
echo "║  Service Bus   1  + 2 queues (~\$0.05/mo)                ║"
echo "║  Key Vault     1  (free tier)                            ║"
echo "║                                                          ║"
echo "║  Estimated total: ~\$1.35/month                           ║"
echo "║                                                          ║"
echo "║  Run discovery:                                          ║"
echo "║  curl -X POST http://localhost:3000/discovery/scan/azure ║"
echo "║    -H 'Content-Type: application/json'                   ║"
echo "║    -d '{\"subscriptionId\":\"$SUBSCRIPTION_ID\"}'   ║"
echo "║                                                          ║"
echo "║  Cleanup: ./seed-azure.sh --destroy                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
