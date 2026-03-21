# AppCloud Cloud Seed Scripts

Creates stopped/idle resources across AWS, Azure, and GCP for AppCloud
discovery testing. All compute is stopped/deallocated immediately after
creation — cost is near zero.

## Estimated Cost

| Cloud | Resources | Est. Monthly Cost |
|-------|-----------|-------------------|
| AWS   | 4 stopped EC2 (EBS only), 4 Lambda, 3 S3, 3 SQS | ~$0.20 |
| Azure | 4 deallocated VMs (disk only), 3 Function Apps, 4 Storage, 1 Service Bus | ~$0.30 |
| GCP   | 4 stopped VMs (pd-standard disk only), 4 Cloud Functions, 3 Storage, 3 Pub/Sub | ~$0.10 |

**Total: ~$0.60/month** — run `--destroy` when done to eliminate all costs.

## Prerequisites

### AWS
```bash
aws configure   # or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
```

### Azure
```bash
az login
az account set --subscription YOUR_SUBSCRIPTION_ID
```

### GCP
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud auth application-default login
```

## Usage

```bash
chmod +x seed-aws.sh seed-azure.sh seed-gcp.sh

# AWS — defaults to ap-southeast-2
export AWS_REGION=ap-southeast-2
./seed-aws.sh

# Azure — defaults to australiaeast
export AZURE_LOCATION=australiaeast
./seed-azure.sh

# GCP — defaults to australia-southeast1
export GCP_PROJECT=your-project-id
export GCP_REGION=australia-southeast1
./seed-gcp.sh
```

## AppCloud Mapping Tags

Every resource is tagged/labelled so AppCloud's discovery scanner can
automatically suggest which Application and Component it belongs to.

### AWS (tag keys)
| Tag | Maps to |
|-----|---------|
| `appcloud:app` | Application.name |
| `appcloud:component` | Component.name |
| `appcloud:env` | Application.environment |
| `appcloud:tier` | Application.tier |
| `appcloud:owner` | Application.owner |

### Azure (tag keys — no colons allowed)
| Tag | Maps to |
|-----|---------|
| `appcloud-app` | Application.name |
| `appcloud-component` | Component.name |
| `appcloud-env` | Application.environment |
| `appcloud-tier` | Application.tier |
| `appcloud-owner` | Application.owner |

### GCP (label keys — lowercase, hyphens only)
| Label | Maps to |
|-------|---------|
| `appcloud-app` | Application.name |
| `appcloud-component` | Component.name |
| `appcloud-env` | Application.environment |
| `appcloud-tier` | Application.tier |
| `appcloud-owner` | Application.owner |

## Resources Created (per cloud)

Each script seeds resources representing three fictional applications:
- **Payments Platform** (Tier 1, production)
- **Online Banking** (Tier 1, production)
- **Data Platform** (Tier 3, staging)

### AWS
- 4 EC2 instances (stopped) — 1x payments-api, 1x payments-db, 1x banking-web, 1x data-worker
- 4 Lambda functions — process-payment, send-notification, ingest-events, identity-auth
- 3 S3 buckets (empty) — payments-assets, banking-static, data-lake
- 3 SQS queues (empty) — payment-events, notification-queue, data-ingestion

### Azure
- 4 VMs (deallocated) — same logical mapping as AWS
- 3 Function Apps (consumption plan, idle)
- 4 Storage Accounts (LRS, empty)
- 1 Service Bus namespace (Basic tier) with 2 queues

### GCP
- 4 Compute Engine instances (stopped)
- 4 Cloud Functions (idle)
- 3 Cloud Storage buckets (empty)
- 3 Pub/Sub topics (no messages)

## Triggering Discovery

After seeding, trigger AppCloud's discovery scanner:

```bash
# AWS
curl -X POST http://localhost:3000/discovery/scan/aws \
  -H 'Content-Type: application/json' \
  -d '{"regions": ["ap-southeast-2"]}'

# Azure
curl -X POST http://localhost:3000/discovery/scan/azure \
  -H 'Content-Type: application/json' \
  -d '{"subscriptionId": "YOUR_SUB_ID"}'

# GCP
curl -X POST http://localhost:3000/discovery/scan/gcp \
  -H 'Content-Type: application/json' \
  -d '{"projectId": "YOUR_PROJECT_ID"}'
```

## Cleanup

```bash
./seed-aws.sh --destroy
./seed-azure.sh --destroy   # deletes entire resource group
./seed-gcp.sh --destroy
```
