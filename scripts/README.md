# AppCloud Demo Scripts

These scripts create and delete demo data for live demonstrations of the AppCloud platform.

## Overview

The demo setup creates a realistic microservices landscape with:

- **5 Applications**: E-Commerce Platform, Payment Service, User Management, Analytics Dashboard, Notification Service
- **13 Components**: Various APIs, services, and workers across different runtimes
- **15 Connections**: Both intra-application and inter-application component connections
- **7 Infrastructure Resources**: AWS, Azure, and GCP resources
- **20+ Deployments**: Components deployed to appropriate infrastructure

## Prerequisites

1. **API Server Running**: The AppCloud API must be running on `http://localhost:3000`
2. **Authentication**: `APPCLOUD_API_KEY` set to a valid API key (only needed when the API is running with auth enabled)
3. **curl and jq**: Required for API calls and JSON parsing

## Usage

### Environment Variables

Set these environment variables before running the scripts:

```bash
export API_BASE="http://localhost:3000"          # Optional, defaults to localhost:3000
export APPCLOUD_API_KEY="your-api-key-here"      # Optional; only needed if auth is enabled
```

### Creating Demo Data

```bash
./scripts/create-demo.sh
```

This will create:
- Infrastructure resources (EC2, RDS, S3, AKS, GKE, Storage accounts)
- Applications with different tiers and characteristics
- Components with various types (UI, API, Service, Worker)
- Component-to-component connections using different protocols
- Component-to-infrastructure deployments

### Deleting Demo Data

```bash
./scripts/delete-demo.sh
```

This will:
- Delete all demo applications (which cascades to delete exclusive components and infra)
- Clean up any orphaned components
- Clean up any orphaned infrastructure
- Preserve shared resources and non-demo data

## Demo Architecture

### Applications & Components

```
E-Commerce Platform (Tier 1)
├── web-frontend (UI/React) → AWS EC2
├── api-gateway (API/Node.js) → AWS EC2
├── order-service (Service/Java) → Azure AKS + AWS RDS
└── inventory-service (Service/Python) → Azure AKS + AWS RDS

Payment Service (Tier 1)
├── payment-api (API/Go) → GCP GKE + AWS RDS
└── fraud-detection (Service/Python) → GCP GKE

User Management (Tier 2)
├── auth-service (Service/Node.js) → AWS EC2
└── user-api (API/Java) → AWS EC2

Analytics Dashboard (Tier 3)
├── analytics-api (API/Python) → Azure AKS + AWS S3
└── data-processor (Worker/Python) → Azure AKS + Azure Storage

Notification Service (Tier 2)
├── email-service (Service/Node.js) → GCP GKE
└── sms-service (Service/Go) → GCP GKE
```

### Connections

**Intra-Application:**
- web-frontend → api-gateway (HTTPS)
- api-gateway → order-service (HTTP)
- order-service → inventory-service (gRPC)
- payment-api → fraud-detection (TCP)

**Inter-Application:**
- order-service → payment-api (HTTPS)
- web-frontend → auth-service (HTTPS)
- api-gateway → user-api (HTTP)
- order-service → analytics-api (HTTPS)
- payment-api → analytics-api (HTTPS)
- order-service → email-service (AMQP)
- payment-api → sms-service (AMQP)

## Troubleshooting

### Authentication Issues
- Ensure `APPCLOUD_API_KEY` is set to the same value the API was started with
- If auth is disabled on the API, leaving `APPCLOUD_API_KEY` unset is fine

### API Connection Issues
- Verify the API server is running on the correct port
- Check `API_BASE` URL is correct
- Ensure no firewall/proxy issues

### jq Not Found
- Install jq: `brew install jq` (macOS) or `apt install jq` (Ubuntu)

### Permission Issues
- Ensure scripts are executable: `chmod +x scripts/*.sh`

## Safety

- The delete script only removes demo applications and their exclusive resources
- Shared infrastructure is preserved
- Non-demo data remains untouched
- Always test in a development environment first