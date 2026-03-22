# AppCloud v1.0.0 — Prior Art Release

**Release date:** March 2026  
**Release type:** Prior Art / Public Disclosure  
**Tag:** `v1.0.0-prior-art`

---

## Purpose of this Release

This release constitutes a **public disclosure of prior art** for the AppCloud infrastructure intelligence platform. It is published to establish a cryptographically timestamped, publicly verifiable record of the system's existence, architecture, and novel technical contributions as of March 2026.

This release is intended to:

- Establish prior art against future patent claims covering the described techniques
- Support copyright registration filings with the US Copyright Office
- Serve as a permanent archival record in conjunction with submissions to the Internet Archive and OSF Preprints
- Provide a citable reference for the accompanying technical paper

---

## What is AppCloud?

AppCloud is a **graph-native infrastructure intelligence platform** that models the full application–component–infrastructure topology as a property graph, and provides change governance, compliance reporting, drift detection, and live multi-cloud discovery on top of that graph.

The system is built on a polyglot Neo4j + PostgreSQL architecture. Neo4j stores the topology graph. PostgreSQL stores operational state — users, audit logs, cloud account credentials (AES-256-GCM encrypted), and integration configuration.

---

## Novel Technical Contributions

The following specific techniques are disclosed in this release:

### 1. Topology-Aware Blast Radius and Risk Scoring

A pre-change impact analysis engine that traverses the property graph up to four hops upstream via `CONNECTS_TO` edges to compute affected components, then scores risk using a tier-weighted formula:

```
riskScore = min(10,
  sum(w(app))                 // Tier-1 = 2.0, Tier-2 = 1.5, other = 1.0
  + |affectedComponents| / 3  // blast breadth penalty
  + 1 if |affectedInfra| > 0  // infrastructure involvement bonus
)
```

### 2. Graph-Traversal Policy Engine

Governance policies expressed as Cypher queries executed against the live graph. Six policies implemented, including `SELF_APPROVED` (detects same-user submit+approve via a single graph pattern match) and `HIGH_RISK_UNAPPROVED` (flags riskScore >= 7 on Tier-1 applications).

### 3. Three-Engine Workflow System

- **Change Lifecycle** — seven-step gate with automated Cypher-based policy check blocking advancement
- **Application Onboarding** — completion computed in real time by counting graph relationships
- **Drift Detection** — infrastructure without `DEPLOYED_ON` relationships auto-creates draft Change nodes

### 4. Live Multi-Cloud Discovery with Graph Linkage

Live ingestion from AWS, Azure, and GCP APIs writing `Infra` nodes with `source='discovery'`. The `/discovery/link` endpoint creates `DEPLOYED_ON` relationships bridging the cloud control plane and application topology graph.

### 5. Append-Only Audit Log with Query API

Every write recorded as an immutable PostgreSQL row with diff (JSONB). Dedicated `/audit` query API with filtering, pagination, per-resource history, and 30-day aggregated statistics.

### 6. Polyglot Graph-Relational Architecture

Deliberate allocation between Neo4j (topology, multi-hop traversal) and PostgreSQL (audit, credentials, sync history) with graceful degradation on partial database failure.

### 7. Encrypted Cloud Account Credential Storage

AES-256-GCM encryption of secret fields before PostgreSQL storage, using the JWT secret as the encryption key (SHA-256 derived). Auto-tenant resolution for Azure service principals via the ARM unauthenticated metadata endpoint.

### 8. Kubernetes-Native Deployment with Kustomize

Kustomize base + four overlays (Minikube, EKS, AKS, OpenShift). Neo4j entrypoint adapted from Docker Compose bind-mount to ConfigMap + initContainer. API uses `APPCLOUD_NEO4J_URI` to prevent Kubernetes service-discovery environment variable injection from overriding the bolt connection string.

---

## System Architecture

```
┌──────────────────────────────────────────────┐
│              Next.js 14 UI                    │
└──────────────────────┬───────────────────────┘
                       │ /api/* server-side rewrite
┌──────────────────────▼───────────────────────┐
│           Fastify REST API (Node 20)          │
│  11 route groups · JWT auth · Graceful degrad │
└──────────┬───────────────────────┬───────────┘
           │                       │
┌──────────▼──────────┐ ┌──────────▼──────────┐
│      Neo4j 5.x       │ │    PostgreSQL 16     │
│  Topology graph      │ │  users · audit_log  │
│  CONTAINS            │ │  cloud_accounts     │
│  DEPLOYED_ON         │ │  (AES-256-GCM enc.) │
│  CONNECTS_TO         │ │  sync_jobs          │
│  AFFECTS · MODIFIES  │ │  terraform_imports  │
└─────────────────────┘ └─────────────────────┘
```

---

## Repository Contents

| Path | Description |
|------|-------------|
| `api/` | Fastify REST API (Node.js 20, ES modules) |
| `api/src/routes/` | 12 route modules |
| `api/src/utils/encrypt.js` | AES-256-GCM credential encryption |
| `ui/` | Next.js 14 frontend |
| `postgres-init/` | PostgreSQL schema migrations 01–04 |
| `k8s/` | Kustomize base + four cloud overlays |
| `k8s/scripts/` | Deploy scripts for all targets |
| `integration_tests/` | Jest test suite + LocalStack seed |
| `cloud-seed/` | AWS/Azure/GCP resource seed scripts |
| `docs/main.tex` | Technical paper (arXiv cs.DC submission) |
| `NOTICE` | Prior art and copyright notice |

---

## API Surface

| Prefix | Key Endpoints |
|--------|--------------|
| `/auth` | register, login, refresh, logout, me |
| `/applications` | CRUD, topology, dependencies |
| `/components` | CRUD, connections, deploy |
| `/infra` | CRUD, shared/resources, public/exposed |
| `/changes` | CRUD, blast-radius, impact-preview, approve, reject |
| `/graph` | summary, topology, impact, cross-app-deps, snapshots |
| `/governance` | policy-violations, risk-heatmap, compliance-report, CSV, PDF |
| `/workflows` | change lifecycle, onboarding, drift detection |
| `/discovery` | accounts, scan/aws, scan/azure, scan/gcp, scan/all, link |
| `/integrations` | terraform import, cloud account CRUD |
| `/audit` | paginated history, stats, per-resource, per-actor |

---

## Accompanying Materials

- **Technical paper:** `docs/main.tex` — submitted to arXiv cs.DC
- **Copyright registration:** US Copyright Office (source code + paper)
- **Internet Archive:** Permanent archival copy
- **OSF Preprints:** DOI assigned

---

## License

Copyright © 2026. All rights reserved.  
See `NOTICE` for prior art disclosure terms and `LICENSE` for source terms.