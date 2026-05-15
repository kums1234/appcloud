# AppCloud API guide

This is the working reference for the AppCloud HTTP API. Every example uses
`curl` against a port-forwarded local cluster; swap `localhost:3000` for
your tunnel URL or production host as appropriate. Response bodies are
trimmed for readability — exact shapes are subject to evolution; check the
live API and adjust.

For a clickable, importable workflow, see
**[`api-postman-collection.json`](api-postman-collection.json)** — open
Postman → Import → upload that file. The collection has the same coverage
as this guide.

---

## 1. Overview

### Base URL

```
http://localhost:3000          # via kubectl -n appcloud port-forward svc/api 3000:3000
http://appcloud.local           # via minikube tunnel + /etc/hosts entry
```

### Authentication

`X-API-Key: <key>` header. The key is whatever your `secrets/appcloud_api_key.txt`
contains (mounted into the API pod via `APPCLOUD_API_KEY_FILE`).

When the key file is absent or empty, the API logs
`[auth] APPCLOUD_API_KEY not set — authentication disabled, all routes open`
and the header is ignored. Useful for local dev; never run that way in
production.

### Response format

JSON throughout. Error responses look like:

```json
{ "statusCode": 400, "error": "Bad Request", "message": "infraId required" }
```

Successful responses for collection endpoints return a top-level array;
single-resource endpoints return a top-level object.

### Conventions in this doc

- `$KEY` — placeholder for your API key
- `$BASE` — placeholder for the base URL (`http://localhost:3000`)
- Output blocks are abbreviated — fields not shown still come back in the response

---

## 2. Quickstart — three commands to know the API works

```bash
BASE=http://localhost:3000
KEY=$(cat secrets/appcloud_api_key.txt)

# 1. Liveness — should always 200
curl -s "$BASE/health"
# {"status":"ok","timestamp":"2026-04-25T..."}

# 2. Topology snapshot — Apps, Components, Infra, cross-app connections
curl -s -H "X-API-Key: $KEY" "$BASE/graph/topology" | jq '.apps | length, .components | length, .connections | length'

# 3. Discovery providers — what the scanners can map
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/providers"
```

If all three return data, the API + Neo4j wiring is healthy.

---

## 3. Health

### `GET /health`

Open (no auth). Liveness probe — returns `{ status: "ok", timestamp }`.

```bash
curl -s "$BASE/health"
```

---

## 4. Discovery

The discovery domain owns everything related to cloud-account scans,
mapping suggestions, and supplement enrichment. See
[CLAUDE.md → Discovery architecture](../CLAUDE.md#discovery-architecture)
for the conceptual model.

### Cloud accounts

Cloud-account configurations live under **[`/integrations/cloud`](#12-integrations)**
— see that section for full CRUD. Discovery is a *consumer* of those
records and never owns them. The two scan endpoints below pick up every
enabled account for the chosen provider; pass credentials inline only for
ad-hoc one-off scans without persisting an account.

### Scans

Each scan is **synchronous** — the request blocks until the scanner +
auto-bootstrap finish and returns the result inline. For multi-account or
scheduled use, see `/discovery/schedule`.

```bash
# Azure — one-off scan with credentials in the body
curl -s -X POST "$BASE/discovery/scan/azure" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{
    "subscriptionId": "...",
    "credentials": {
      "tenantId":     "...",
      "clientId":     "...",
      "clientSecret": "..."
    }
  }'

# Azure — scan all configured Azure accounts (no body needed)
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/discovery/scan/azure"

# GCP — same shape, projectId-keyed
curl -s -X POST "$BASE/discovery/scan/gcp" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "projectId": "my-project", "credentials": { "client_email": "...", "private_key": "..." } }'

# AWS — Config aggregator scan; aggregatorName + region required
curl -s -X POST "$BASE/discovery/scan/aws" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{
    "regions":     ["us-east-1", "us-west-2"],
    "credentials": {
      "accessKeyId":      "...",
      "secretAccessKey":  "...",
      "aggregatorName":   "appcloud-aggregator",
      "aggregatorRegion": "us-east-1"
    }
  }'

# Multi-cloud — every configured account, in parallel
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/discovery/scan/all"
```

Response shape (Azure example, abbreviated):

```json
{
  "provider": "azure",
  "accounts": 1,
  "subscriptionId": "...",
  "duration": 9213,
  "total": 0,
  "breakdown": {
    "vms": 0, "aks": 0, "sql": 0, "appService": 0, "functionApp": 0,
    "redis": 0, "vnet": 0, "edges": 0,
    "errors": [],
    "skipped": [],
    "scanEpoch": 1777079373715
  },
  "stale": { "removed": 0, "markedStale": 0, "skipped": false, "errors": [] },
  "bootstrap": { "createdApps": 0, "createdComponents": 0, "linked": 0, ... }
}
```

### Resources, summary, links

```bash
# Discovered resource catalog (filterable)
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/resources?provider=azure&resourceType=vm&limit=50"

# By-provider, by-type counts (mapped vs unmapped)
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/summary"

# Manually link an Infra to a Component
curl -s -X POST "$BASE/discovery/link" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "infraId": "<infra-uuid>", "componentId": "<component-uuid>" }'

# Refresh tags / metadata for a single resource (no-op today; full scan recommended)
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/resources/<infraId>/refresh"

# Delete a discovered resource (refused if linked to a Component)
curl -s -X DELETE -H "X-API-Key: $KEY" "$BASE/discovery/resources/<infraId>"

# Bulk delete
curl -s -X POST "$BASE/discovery/resources/bulk-delete" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "ids": ["<id1>", "<id2>"] }'
```

### Suggestions and mapping actions

```bash
# Pull current suggest-engine output
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/suggest"

# Apply a single suggestion (legacy single-mapping endpoint)
curl -s -X POST "$BASE/discovery/suggest/apply" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "mappings": [{ "infraId": "<id>", "componentId": "<id>" }] }'

# Apply mixed-action batch (link / create-component / create-application)
curl -s -X POST "$BASE/discovery/suggest/apply-all" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{
    "actions": [
      { "action": "link_component",     "infraId": "...", "componentId": "..." },
      { "action": "create_component",   "infraId": "...", "applicationId": "...", "newCompName": "auth-api" },
      { "action": "create_application", "infraId": "...", "newAppName": "Payments", "newCompName": "payment-api", "suggestedTier": 1 }
    ]
  }'

# Bootstrap (tag-based + RG-propagation auto-link, episode-tracked)
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/discovery/bootstrap"
```

### Supplement enrichment (Azure today)

```bash
# Trigger Azure supplement layers (Network Watcher + VM Insights + auto-link)
curl -s -X POST "$BASE/discovery/enrich/azure" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{
    "strategy":    "monitor-insights",
    "workspaceId": "/subscriptions/.../resourceGroups/.../providers/Microsoft.OperationalInsights/workspaces/...",
    "autoLink":    true,
    "minScore":    60
  }'

# What strategies are available + what they cost
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/linking-strategies"
```

### Schedule (cron-style)

```bash
# View
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/schedule"

# Set (every 6h, all providers)
curl -s -X PUT "$BASE/discovery/schedule" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "enabled": true, "cron": "0 */6 * * *" }'

# Run now
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/discovery/schedule/run-now"
```

### Metadata helpers

```bash
# Provider catalog (which providers are wired up)
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/providers"

# Recognised resource types per provider
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/resource-types?provider=azure"

# Debug a single Infra node — includes all its CONNECTS_TO neighbours
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/debug/<infraId>"
```

---

## 5. Applications

```bash
# List
curl -s -H "X-API-Key: $KEY" "$BASE/applications"

# Get one (id or name)
curl -s -H "X-API-Key: $KEY" "$BASE/applications/<id-or-name>"

# Create
curl -s -X POST "$BASE/applications" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{
    "name":            "Payments Platform",
    "tier":            1,
    "owner":           "payments-team",
    "environment":     "production",
    "availability":    "99.99",
    "confidentiality": "confidential",
    "domain":          "finance"
  }'

# Update (PATCH supports any subset of the create fields)
curl -s -X PATCH "$BASE/applications/<id>" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "tier": 2 }'

# Delete (cascades exclusively-owned components and infra)
curl -s -X DELETE -H "X-API-Key: $KEY" "$BASE/applications/<id>"

# Topology — Application + its Components + their Infra + cross-component connections
curl -s -H "X-API-Key: $KEY" "$BASE/applications/<id>/topology"

# Cross-app + structural dependencies — use the polymorphic /graph/dependencies.
# The legacy /applications/<id>/dependencies was removed; its narrow [{app, component}]
# shape is a strict subset of what /graph/dependencies returns (with depth + edge
# contract + rollup annotations).
curl -s -H "X-API-Key: $KEY" "$BASE/graph/dependencies?id=<app-id>"
```

---

## 6. Components

```bash
# Component schema metadata (types, runtimes, etc.)
curl -s -H "X-API-Key: $KEY" "$BASE/components/metadata"

# List + get + CRUD
curl -s -H "X-API-Key: $KEY" "$BASE/components"
curl -s -H "X-API-Key: $KEY" "$BASE/components/<id>"
curl -s -X POST "$BASE/components" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "name": "payment-api", "type": "api", "runtime": "nodejs", "applicationId": "<app-id>" }'
curl -s -X PATCH "$BASE/components/<id>" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "runtime": "nodejs-20" }'
curl -s -X DELETE -H "X-API-Key: $KEY" "$BASE/components/<id>"

# Connect two Components (writes Component-to-Component :CONNECTS_TO)
curl -s -X POST "$BASE/components/<id>/connections" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "targetId": "<other-component-id>", "protocol": "https", "port": 443 }'

# Deploy a Component onto an Infra resource (manual ownership)
curl -s -X POST "$BASE/components/<id>/deploy" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "infraId": "<infra-id>" }'
```

---

## 7. Infrastructure

```bash
# Catalog + filters
curl -s -H "X-API-Key: $KEY" "$BASE/infra"

# One node (with its component owners)
curl -s -H "X-API-Key: $KEY" "$BASE/infra/<id>"

# Manual create (rare; most Infra comes from discovery scans)
curl -s -X POST "$BASE/infra" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "name": "manual-vm-1", "provider": "azure", "resource_type": "vm", "region": "eastus", "public": false }'

curl -s -X PATCH -H "X-API-Key: $KEY" "$BASE/infra/<id>" -H 'content-type: application/json' -d '{ "public": true }'
curl -s -X DELETE -H "X-API-Key: $KEY" "$BASE/infra/<id>"

# Resources owned by more than one Application (shared services)
curl -s -H "X-API-Key: $KEY" "$BASE/infra/shared/resources"

# Internet-exposed resources
curl -s -H "X-API-Key: $KEY" "$BASE/infra/public/exposed"
```

---

## 8. Graph

```bash
# Single-shot topology — apps, components, connections, deployments, infra
curl -s -H "X-API-Key: $KEY" "$BASE/graph/topology"

# Counts by node type / edge type
curl -s -H "X-API-Key: $KEY" "$BASE/graph/summary"

# Blast-radius — given an Application, Component, or Infra, who depends on it?
# Inbound walk over :CONNECTS_TO, depth-aware tree, full edge contract. For an
# Infra root this transitively surfaces both the Components deployed on it AND
# the upstream Infra that uses it (a NIC root surfaces the VM; a subnet root
# surfaces every NIC in it). Each Infra node carries `rollupKind` / `rollupKey`
# (resource-group / GCP project / AWS account+region), and the top-level
# `rollups` field is a count histogram of those buckets.
curl -s -H "X-API-Key: $KEY" "$BASE/graph/impact?id=<app-component-or-infra-id>&maxDepth=10&nodeCap=500"

# Inverse of /impact — given an Application or Component, what does it depend on?
# Outbound walk: Component→Component service calls + Component→Infra deployments
# + transitively chased Infra→Infra structural edges. Same rollup annotations
# as /impact, useful for "this app spans N resource groups" dashboards.
curl -s -H "X-API-Key: $KEY" "$BASE/graph/dependencies?id=<app-or-component-id>&maxDepth=10&nodeCap=500"

# Render either walk as a diagram. `format=mermaid` (default) returns text that
# GitHub will render inline; `format=dot` returns Graphviz source for `dot -T…`.
# `direction=outbound` (default) for dependencies; `direction=inbound` for impact.
curl -s -H "X-API-Key: $KEY" "$BASE/graph/visualize?id=<id>&direction=outbound&format=mermaid"
curl -s -H "X-API-Key: $KEY" "$BASE/graph/visualize?id=<id>&direction=inbound&format=dot" | dot -Tpng > impact.png

# All cross-application dependencies
curl -s -H "X-API-Key: $KEY" "$BASE/graph/cross-app-dependencies"

# Path between two arbitrary nodes (uses :CONNECTS_TO of any flavour)
curl -s -H "X-API-Key: $KEY" "$BASE/graph/path?from=<id>&to=<id>&maxHops=4"

# Topology snapshots (point-in-time captures, useful for diff)
curl -s -H "X-API-Key: $KEY" "$BASE/graph/snapshots"
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/graph/snapshots" \
  -H 'content-type: application/json' -d '{ "name": "pre-payments-deploy" }'
```

---

## 9. AI

The AI domain is opt-in: status / availability is reported up-front so the
client can hide the relevant UI surfaces when no provider is configured.

```bash
# Provider availability (local Ollama and/or cloud — OpenAI / Anthropic / …)
curl -s -H "X-API-Key: $KEY" "$BASE/ai/status"

# Explain why the suggest engine made a particular suggestion
curl -s -X POST "$BASE/ai/suggest/explain" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "infra": { ... }, "suggestion": { ... } }'

# Re-score a suggestion (optionally cloud-LLM)
curl -s -X POST "$BASE/ai/suggest/score" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "infra": { ... }, "candidates": [ ... ] }'

# Plain-English impact narrative for an Infra blast radius
curl -s -H "X-API-Key: $KEY" "$BASE/ai/infra/<infraId>/impact"

# Architectural plan over the whole graph (cloud LLM only)
curl -s -H "X-API-Key: $KEY" "$BASE/ai/architecture/plan"

# Drift-remediation plan (auto-generated for unmapped resources, or pass items)
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/ai/drift/remediation-plan" \
  -H 'content-type: application/json' -d '{}'

# Cross-app dependency analysis
curl -s -H "X-API-Key: $KEY" "$BASE/ai/dependencies/analysis"

# Conversational chat with live graph context injected
curl -s -X POST "$BASE/ai/chat" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "messages": [{ "role": "user", "content": "What apps are at risk if we lose vm-1?" }] }'
```

---

## 10. Audit

Every mutation is recorded in Postgres with `actor`, `action`, `resource`,
and timestamp.

```bash
# History (filterable by actor / action / resource type / scope / key)
curl -s -H "X-API-Key: $KEY" "$BASE/audit?limit=50"

# Aggregated stats (counts by action type, scope, top actors per key)
curl -s -H "X-API-Key: $KEY" "$BASE/audit/stats"

# History for a specific resource (provider-aware)
curl -s -H "X-API-Key: $KEY" "$BASE/audit/resource/Application/<id>"

# ── Per-actor history ─────────────────────────────────────────────────────
# Recommended: filter by the API-key UUID. Stable, unique even if two keys
# share a display name, and the UUID lives in the create-key response and
# in GET /admin/api-keys.
curl -s -H "X-API-Key: $KEY" "$BASE/audit?keyId=<uuid>&limit=50"

# Or by actor name (exact match by default).
curl -s -H "X-API-Key: $KEY" "$BASE/audit/actor/system"

# Legacy substring match — opt in via ?like=true. Use this only when you
# don't know the exact name; it collapses similarly-named keys
# (`ci-deploy-staging` + `ci-deploy-prod` etc.) into one query result.
curl -s -H "X-API-Key: $KEY" "$BASE/audit/actor/ci-deploy?like=true"

# Filter by privilege tier (admin | write | read).
curl -s -H "X-API-Key: $KEY" "$BASE/audit?scope=admin"
```

---

## 11. CMDB assessment

The CMDB assessment scores how well ServiceNow CIs (or any external CMDB
imported via the connector) align with discovered Infra. See the ServiceNow
connector section in `/integrations` for ingestion.

```bash
# Per-CI assessment results (joinable by sys_id)
curl -s -H "X-API-Key: $KEY" "$BASE/cmdb/assessment"

# Last run state (was a run successful, when, what changed)
curl -s -H "X-API-Key: $KEY" "$BASE/cmdb/assessment/state"

# Run history
curl -s -H "X-API-Key: $KEY" "$BASE/cmdb/assessment/runs"

# Detail for a specific CI
curl -s -H "X-API-Key: $KEY" "$BASE/cmdb/assessment/<sys_id>"

# Force a refresh (idempotent)
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/cmdb/assessment/refresh"
```

---

## 12. Integrations

### Cloud accounts

The single source of truth for cloud-account credentials. The discovery
domain reads these but never writes them.

```bash
# List all
curl -s -H "X-API-Key: $KEY" "$BASE/integrations/cloud"

# Filter by provider — only enabled ones
curl -s -H "X-API-Key: $KEY" "$BASE/integrations/cloud/azure"

# Create — Azure example (service-principal credentials)
curl -s -X POST "$BASE/integrations/cloud" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{
    "provider": "azure",
    "name":     "azure-prod",
    "config": {
      "subscriptionId": "00000000-0000-0000-0000-000000000000",
      "tenantId":       "00000000-0000-0000-0000-000000000000",
      "clientId":       "00000000-0000-0000-0000-000000000000",
      "clientSecret":   "..."
    }
  }'

# Update (PATCH merges into existing config)
curl -s -X PATCH "$BASE/integrations/cloud/<id>" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "enabled": false }'

# Delete
curl -s -X DELETE -H "X-API-Key: $KEY" "$BASE/integrations/cloud/<id>"

# One-time migration for graphs that pre-date the Postgres backing store
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/integrations/cloud/sync-from-neo4j"
```

### AI provider config

```bash
curl -s -H "X-API-Key: $KEY" "$BASE/integrations/ai"
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/integrations/ai" \
  -H 'content-type: application/json' \
  -d '{ "provider": "anthropic", "apiKey": "...", "model": "claude-sonnet-4-5" }'
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/integrations/ai/test"
curl -s -X DELETE -H "X-API-Key: $KEY" "$BASE/integrations/ai"
```

### Generic connector framework (ServiceNow, Terraform Cloud, OTel ingest, IaC state backends)

```bash
# List all configured integration instances
curl -s -H "X-API-Key: $KEY" "$BASE/integrations"

# Detail
curl -s -H "X-API-Key: $KEY" "$BASE/integrations/<id>"

# Create (config schema is connector-specific — see /connectors for the schema)
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/integrations" \
  -H 'content-type: application/json' \
  -d '{
    "connectorId": "servicenow",
    "name":        "snow-prod",
    "config": {
      "instance":      "mycompany",
      "username":      "integration-user",
      "password":      "...",
      "tables":        ["cmdb_ci_server", "cmdb_ci_database"],
      "pullRelations": true
    }
  }'

# Test connection without ingesting
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/integrations/<id>/test"

# Trigger one-off scan / pull
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/integrations/<id>/scan"

# Sync history
curl -s -H "X-API-Key: $KEY" "$BASE/integrations/<id>/history"

# Delete
curl -s -X DELETE -H "X-API-Key: $KEY" "$BASE/integrations/<id>"
```

### Connector registry

```bash
# All available connectors (their UI metadata, JSON schemas, capabilities)
curl -s -H "X-API-Key: $KEY" "$BASE/connectors"

# One connector's schema
curl -s -H "X-API-Key: $KEY" "$BASE/connectors/<id>"
```

### Terraform import (multipart upload)

```bash
# Push a `terraform.tfstate` or plan JSON for graph ingestion
curl -s -X POST "$BASE/integrations/terraform/import" \
  -H "X-API-Key: $KEY" \
  -F 'state=@./terraform.tfstate'

# View import history
curl -s -H "X-API-Key: $KEY" "$BASE/integrations/terraform/history"
```

### OTel ingest (push from a Collector)

The OTel connector exposes `POST /ingest/otlp/v1/traces` — configure your
OpenTelemetry Collector's `otlphttp` exporter with `encoding: json` and the
tenant token in the `Authorization: Bearer …` header. Token is auto-issued
when you create the integration; surfaced once in the create response.

```bash
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/integrations" \
  -H 'content-type: application/json' \
  -d '{ "connectorId": "otel-ingest", "name": "otel" }'

# response includes the otelTenantToken — copy into your Collector config
```

---

## 13. Common workflows

### A) Add an Azure account and trigger the first scan

```bash
ID=$(curl -s -X POST "$BASE/integrations/cloud" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{ "provider": "azure", "name": "azure-prod",
        "config": { "subscriptionId":"...", "tenantId":"...", "clientId":"...", "clientSecret":"..." } }' \
  | jq -r .id)

curl -s -X POST -H "X-API-Key: $KEY" "$BASE/discovery/scan/azure"
curl -s -H  "X-API-Key: $KEY" "$BASE/discovery/summary"
```

### B) Manually map a discovered Infra to a Component

```bash
# 1. Find the unmapped Infra
curl -s -H "X-API-Key: $KEY" "$BASE/discovery/resources?limit=200" \
  | jq '.[] | select(.mapped == false)'

# 2. Find a Component
curl -s -H "X-API-Key: $KEY" "$BASE/components" | jq '.[].id'

# 3. Link
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/discovery/link" \
  -H 'content-type: application/json' \
  -d '{ "infraId": "<i>", "componentId": "<c>" }'
```

### C) Run impact analysis on a single resource

```bash
# Direct (Application, Component, or Infra id all accepted)
curl -s -H "X-API-Key: $KEY" "$BASE/graph/impact?id=<id>"

# Plain-English narrative (requires AI provider configured)
curl -s -H "X-API-Key: $KEY" "$BASE/ai/infra/<id>/impact"
```

### D) Wire up the Azure VM Insights supplement

```bash
# 1. Add the workspace to your Azure account config (PATCH the cloud account)
curl -s -X PATCH -H "X-API-Key: $KEY" "$BASE/integrations/cloud/<id>" \
  -H 'content-type: application/json' \
  -d '{ "config": { "logAnalyticsWorkspaceId": "/subscriptions/.../workspaces/..." } }'

# 2. Trigger the supplement explicitly
curl -s -X POST -H "X-API-Key: $KEY" "$BASE/discovery/enrich/azure" \
  -H 'content-type: application/json' \
  -d '{ "strategy": "monitor-insights", "autoLink": true }'
```

---

## 14. OpenAPI / Swagger UI

The API self-describes via [`@fastify/swagger`](https://github.com/fastify/fastify-swagger).
The spec is generated at startup from the registered route schemas (every
route is auto-tagged by its first path segment).

```bash
# Machine-readable spec
curl -s "$BASE/openapi.json" | jq .info.title
# "AppCloud API"

# Interactive Swagger UI — open in a browser
open "$BASE/docs"   # macOS; xdg-open on Linux
```

A copy is committed at [`docs/openapi.yaml`](openapi.yaml) (and `openapi.json`)
so callers can build clients without running the server. Re-export with:

```bash
cd api && npm run openapi:export
# [export-openapi] wrote docs/openapi.{json,yaml} — 75 paths
```

Useful follow-ons once you have the spec:

- Generate a typed client: `openapi-generator generate -i docs/openapi.yaml -g typescript-fetch`
- Import into Postman: **Import → File → docs/openapi.yaml** (alternative to the curated collection in `api-postman-collection.json`)
- Validate against Spectral: `spectral lint docs/openapi.yaml`

## 15. Postman setup

1. Open Postman → **Import** → drag in
   [`api-postman-collection.json`](api-postman-collection.json).
2. Set the collection variables:
   - `baseUrl` — `http://localhost:3000` (or your tunnel URL)
   - `apiKey` — paste the contents of `secrets/appcloud_api_key.txt`
3. Open the **Health** folder → **GET /health** → Send. You should see
   `200 OK` and `{ "status": "ok", ... }`.
4. Walk through the **Quickstart** folder for the next two requests.

Each request in the collection has its own description with the same
explanation as in this guide. The body for write operations is
pre-populated with sample JSON; replace the `<placeholder>` tokens before
sending.

If you'd rather work from the CLI, every example in this doc is copy-paste-
ready once `BASE` and `KEY` are exported.

---

## 16. Open issues / known caveats

- `GET /discovery/resources/<id>/refresh` is a deliberate stub — it
  returns `{ status: "deferred", hint: "..." }` and does not refresh
  anything. Full provider scans (`POST /discovery/scan/<provider>`)
  are the only path today for picking up tag / property changes. The
  endpoint exists for future per-resource refresh work; tracked but
  not scheduled. Until then, prefer polling `GET /discovery/summary`
  or scheduling a periodic full scan via `POST /discovery/schedule`.
- AWS scans require the Configuration Aggregator prerequisite documented
  in [secrets_setup.md](../secrets_setup.md). Without it, the scan
  surfaces a clear error at the auth boundary.
- The `cleanupStaleNodes` errored-scan guard skips cleanup on a scan that
  errors with zero nodes scanned. A scan that returns most resources but
  errors on one type still triggers cleanup — for production scenarios,
  we may want a "majority-fresh" guard. Tracked as a follow-up in
  [docs/discovery-native-graph-slices.md](discovery-native-graph-slices.md).
