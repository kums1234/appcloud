# AppCloud

AppCloud is a knowledge graph platform for infrastructure dependency mapping and blast radius analysis across multi-cloud environments (Azure, AWS, GCP). The core job is to ingest cloud resource inventory, enrich it with structural and semantic relationships, and answer "if X changes, what's affected?" with traceable evidence.

This file is the durable context for working on AppCloud. Read it at the start of every session. If anything here contradicts the current code, flag it — don't silently paper over the drift.

---

## Stack

- **API / ingestion**: Node.js + Fastify
- **Graph store**: Neo4j (primary source of truth for relationships)
- **Relational store**: PostgreSQL (scheduling, audit trail, job state)
- **Scanners**: per-cloud modules in `api/src/routes/discovery.<cloud>.js`. All three clouds (Azure, GCP, AWS) are first-class, each fronted by a single native inventory query (Resource Graph / Cloud Asset Inventory / Config aggregator).
- **API surface**: see `docs/api-guide.md` for the per-domain reference, request samples, and the importable Postman collection.

---

## Graph conventions (Neo4j)

These are load-bearing. Violating them silently corrupts the graph.

### Writes are always idempotent

Every write uses `MERGE`, never `CREATE`, for both nodes and edges. Scanners re-run on a schedule and the graph must converge, not accumulate duplicates. If you're tempted to use `CREATE` for performance, stop and surface the tradeoff — we'd rather be slow and correct.

### Edge types — single label, traceability via properties

There is **one** relationship label: `:CONNECTS_TO`. Every edge between any pair of nodes — Infra↔Infra, Component↔Infra, Component↔Component, IAM principal↔resource, OTEL service↔service, ServiceNow CMDB CI↔CI — uses this label. Provenance and meaning are carried in properties, not in the label.

Required properties on every `:CONNECTS_TO` edge:

- `source` — which writer emitted the edge. Stable strings, lowercase-hyphenated:
  - Discovery scanners: `azure-resource-graph`, `gcp-cloud-asset-inventory`, `aws-config-aggregator`
  - Discovery supplements: `azure-network-watcher`, `azure-vm-insights`, `gcp-iam-policy`
  - Auto-link: `auto-link` (with `provider_source` carrying `azure-enrichment` / `gcp-enrichment` / `aws-enrichment`)
  - Bootstrap: `bootstrap`, `bootstrap-rg-propagation`
  - Manual: `manual-link`, `manual-deploy`
  - Other ingestors: `otel`, `servicenow-cmdb-rel`
- `via` — the relationship flavour. Per-cloud structural vias (`nic`, `subnet`, `vpc`, `disk`, `iam-binding`, `eni`, `app-service-plan`, `service-account`, `hosted-on`, `runs-on`, `depends-on`, `otel-http`, `otel-rpc`, `component-mapping`, …). The `via` is part of the MERGE key for most writers, so distinct relationship flavours between the same pair of nodes stay as separate edges.
- `confidence` — numeric 0–100. Per-cloud structural-via tables in `discovery.{azure,gcp,aws}.js` set base scores; auto-link's per-cloud `*_VIA_TO_AUTOLINK_SCORE` table in `discovery.autolink.js` defines the Rule 2 direct-link weights.
- `evidence` — short human-readable string explaining why the edge exists (the scanner's source-API call, the IAM binding role, the autolink rule that matched, etc.).
- `discovered_at` / `last_seen` — set on creation and refreshed on each idempotent re-MERGE. Used for staleness detection and audit.

Some writers carry additional properties:

- IAM-binding edges from `gcp-iam-policy` add `role` (the GCP role string) on the MERGE key so distinct grants between the same pair stay separate.
- OTEL telemetry edges add `protocol`, `route`, `rps`, `error_rate`, `p50_ms`, `p95_ms`, `window_start`/`window_end` describing the observed flow.
- Auto-link edges add `provider_source` (`azure-enrichment` etc.) plus the firing `rule` and `score` for audit.
- Bootstrap RG-propagation edges add `rgRatio`.
- ServiceNow CMDB edges add `relType` (human label) and `relTypeRaw` (raw cmdb_rel_ci.type) and `snUpdatedOn`.

Indexes on `:CONNECTS_TO(source, via)`, `(via)`, and `(source)` are created by the Neo4j plugin's startup-time `CREATE INDEX IF NOT EXISTS` block (api/src/plugins/neo4j.js). Filter queries should use either or both properties.

Never create an edge without `source`, `via`, `confidence`, `evidence`. An un-traceable edge is worse than no edge because it cannot be audited, re-scored, or invalidated.

### Node identity

- **Azure**: ARM resource ID (fully qualified `/subscriptions/.../providers/.../<name>`). Parse at ingestion to extract subscription, resource group, provider, type, name — store these as first-class properties.
- **GCP**: REST self-link as `cloud_id` (matches what the per-product SDK scanners used), plus the CAI canonical asset name (`//service.googleapis.com/...`) promoted to the `cai_name` property so the IAM-policy supplement can resolve policy targets back to nodes.
- **AWS**: per-type cloud_id, mostly ARN. EC2 instances and ElastiCache clusters use raw resource IDs (`i-…` and the cluster name) for identity continuity with the legacy per-service scanner. The Config-aggregator scanner builds an in-memory lookup keyed on **both** ARN and raw `resourceId` so cross-resource references (e.g., `subnetId: subnet-xxx`) resolve regardless of which form the source field carries.

Do not rely on parsing the cloud_id on every query.

---

## Discovery architecture

Each cloud follows the same three-stage shape: **primary scan**, optional **supplement layers**, then **auto-link**. The primary stage emits both nodes and unambiguous structural edges; supplements add fidelity the primary cannot surface; auto-link infers Component → Infra ownership from the assembled graph.

### 1. Primary scanner — single native-inventory query per cloud

| Cloud | File | API call | Replaces |
|---|---|---|---|
| Azure | [discovery.azure.js](api/src/routes/discovery.azure.js) | Resource Graph KQL `Resources \| project ...` (paginated by skipToken) | 6 per-type ARM SDKs + the generic `ResourceManagementClient` catch-all |
| GCP | [discovery.gcp.js](api/src/routes/discovery.gcp.js) | Cloud Asset Inventory `listAssetsAsync` with `contentType: 'RESOURCE'` | `@google-cloud/compute`, `@google-cloud/container`, `googleapis` sqladmin/run |
| AWS | [discovery.aws.js](api/src/routes/discovery.aws.js) | Config aggregator `SelectAggregateResourceConfig` with a `WHERE awsRegion IN (...)` filter, paginated | 7 per-service `@aws-sdk/client-*` |

The scanner's job is to:

- Page the native query end-to-end (no silent truncation).
- Upsert one `(:Infra)` node per recognised resource type (typed labels from `discovery.schema.js`, promoted raw fields, ARM-id / self-link / ARN as `cloud_id`).
- Emit unambiguous structural `:CONNECTS_TO` edges directly from the response (VM→NIC→Subnet→VNet, Compute→Subnet/Network/Disk/SA, Instance→Subnet/VPC/SG/ENI/Disk/IAM-Role, …) with `source` set to the scanner's tag and `via` from the per-cloud table.
- Honour fidelity over single-query purity (memory `feedback_fidelity_over_single_query.md`): if the native query has a coverage gap vs. a field downstream consumers rely on, fill the gap with a targeted per-resource call rather than silently dropping the field. The decision must be recorded in the per-cloud coverage doc (`docs/azure-resource-graph-coverage.md`, `docs/gcp-cloud-asset-coverage.md`, `docs/aws-config-aggregator-coverage.md`).

The scanner does **not** infer relationships beyond what the response makes unambiguous. Inferred edges are auto-link's job.

### 2. Supplement layers — opt-in, high-fidelity, per cloud

Supplements live in `discovery.<cloud>.supplement.js` and are invoked from the dedicated enrichment route handlers (see API guide). They never emit nodes — only edges and node-property updates.

Currently shipped layers:

- **Azure Network Watcher** (`source: 'azure-network-watcher'`) — runtime topology `Contains` / `Associated` links per VNet. Surfaces relationships ARG cannot (Azure's own runtime topology view, not just ARM properties).
- **Azure VM Insights** (`source: 'azure-vm-insights'`) — observed TCP connections from the VMConnection Log Analytics table. Adds `connection_count`, `ports`, `process` to the edge.
- **GCP IAM Policy** (`source: 'gcp-iam-policy'`) — IAM-binding edges from CAI's `IAM_POLICY` content type. Service-account principals resolve to existing `gcp_service_account` nodes; `allUsers` / `allAuthenticatedUsers` bindings flip the target's `public = true` and stamp `public_via_iam = <role>`.

Future supplements (scoped but not built; see `docs/discovery-native-graph-slices.md`): VPC Flow Logs / IAM Access Analyzer for AWS; VPC flow logs / IAM Policy Analyzer for GCP; per-service advanced-resource-types enablement for Config gaps.

Adding a new supplement layer requires: a name (kebab-case), a documented `source` string, a `via` value or a small per-layer `via` table, and a paragraph in the per-cloud coverage doc explaining what fidelity it adds and why the primary scanner cannot surface it.

### 3. Auto-link — Component → Infra ownership

[discovery.autolink.js](api/src/routes/discovery.autolink.js) is a single cross-cloud helper consumed by all three cloud supplements. It runs three layered rules over the graph and writes a single `:CONNECTS_TO {via:'component-mapping'}` edge per inferred mapping:

- **Rule 1 — Co-location.** Resources in the same co-location bucket (Azure resource group, GCP project, AWS account+region — extracted by a per-cloud `coLocationFromCloudId` function passed in by the caller) vote for already-mapped Components.
  - ratio = 1.0 → score 85, rule `<bucket>-unanimous`
  - ratio ≥ 0.5 → score 70, rule `<bucket>-majority`
- **Rule 2 — Direct structural 1-hop.** If the unmapped Infra has a `:CONNECTS_TO` edge (via not equal to `component-mapping`) to a mapped Infra, score by the `via`'s coupling weight from the per-cloud `*_VIA_TO_AUTOLINK_SCORE` table. Default 60.
- **Rule 3 — 2-hop neighbourhood.** Only fires when Rules 1+2 produced nothing ≥ minScore. Score is `min(58, 40 + paths × 6)`.

A candidate clearing minScore (default 60) gets an `auto-link` edge written; a candidate scoring 30–59 is surfaced as a suggestion. Ties dedup to highest score per Component, then sort.

Bootstrap ([discovery.bootstrap.js](api/src/routes/discovery.bootstrap.js)) is a separate pass that runs after a scan to materialise Components and Applications from tags / RG patterns. It writes the same `:CONNECTS_TO {via:'component-mapping'}` edges with `source: 'bootstrap'` (Phase 1 — tags) or `source: 'bootstrap-rg-propagation'` (Phase 2 — ≥60% dominance). The two stages are distinct on the edge so confidence reporting and explanations can keep them separate.

### Cross-cloud invariants

Shared `via` keys keep the same Rule-2 score across clouds: `subnet`/`vpc`/`network`/`disk`/`service-account`/`iam-role`/`security-group`. If you change one of these, change all three of `AZURE_VIA_TO_AUTOLINK_SCORE`, `GCP_VIA_TO_AUTOLINK_SCORE`, `AWS_VIA_TO_AUTOLINK_SCORE` together — the cross-cloud test in `discovery.autolink.test.js` locks the invariant.

---

## Scoring and confidence

Treat scores as engineering quantities, not magic numbers — if you change one, explain the change in the PR and update any tests that lock in the old value.

Where the tables live:

- **Primary scanner structural edges**: `VIA_TO_CONFIDENCE` in each `discovery.<cloud>.js`. Per-cloud nuance (e.g., Azure's `nic` = 90, `app-service-plan` = 85) plus shared cross-cloud keys.
- **Auto-link Rule 2 (1-hop)**: per-cloud `*_VIA_TO_AUTOLINK_SCORE` in `discovery.autolink.js`. Includes telemetry-derived vias (`observed-tcp` = 75) where applicable.
- **Auto-link Rule 1 (co-location)**: hard-coded in the helper — 85 unanimous, 70 majority.
- **Auto-link Rule 3 (2-hop)**: hard-coded as `min(58, 40 + paths × 6)` so a 2-hop candidate can never beat a Rule-1/Rule-2 result above minScore.
- **Bootstrap RG propagation**: confidence is the dominance ratio × 100 (so 60% dominance → 60).
- **Manual / route-handler writes**: `confidence: 100` for direct user actions (`/discovery/link`, `/components/:id/deploy`); `confidence: 80` for `/discovery/suggest/apply-all`.

When signals overlap for the same pair, the writer that wins is the one with the highest `via` weight in the relevant table; the previous edge is overwritten on MATCH (not duplicated, because `via` is part of the MERGE key).

---

## PostgreSQL role

Postgres is for:
- **Scheduling** — scanner job definitions, cron state, backoff
- **Audit** — what ran when, against which subscription, with which outcome
- **Operational state** — things that don't belong in the graph (e.g., API rate-limit windows)
- **Episode tracking** — `:IngestionEpisode` provenance on the high-leverage write paths

Postgres is **not** a duplicate of the graph. Resource relationships live in Neo4j. Don't migrate relational queries that should be Cypher.

---

## Migrations

Cypher migrations live in `api/src/migrations/` as numbered `.cypher` files. They're currently applied manually via `kubectl exec` + `cypher-shell`. There is no runner — track which files have been applied against a given environment yourself.

Existing files:

- `001-schema-evolution.cypher` — backfilled `firstseen` / `lastupdated`, typed node labels, promoted raw fields. Applied manually against legacy databases; new installs never need it.

The earlier `002-edge-consolidation` (legacy `:DEPLOYED_ON` / `:CONNECTED_TO` → unified `:CONNECTS_TO`) and `003-connects-to-indexes` were never committed as separate `.cypher` files. The current state:

- **Edge consolidation** is no longer migration-time work — every writer in the codebase emits `:CONNECTS_TO` directly, and the legacy edge labels haven't been written for several releases. A legacy database that still carries them needs the consolidation step applied by hand from the commit history of slice 002 (search the git log for `edge-consolidation`).
- **`:CONNECTS_TO` indexes** are created by the Neo4j plugin's startup-time `CREATE INDEX IF NOT EXISTS` block (api/src/plugins/neo4j.js). Idempotent; runs every boot.

Migration runner is deferred until customer onboarding nears (memory `feedback_pre_customer_priorities.md`). Until then, manual application is acceptable; document the order in any PR that adds a migration. If a new migration lands as a `.cypher` file, list it in this section.

---

## Working conventions

### Test discipline

- Every change to scanner / supplement / auto-link needs a fixture test that locks in the scoring behaviour or edge shape on a representative input. Existing test files: `api/src/routes/__tests__/discovery.{azure,gcp,aws}.{,supplement.}test.js`, `discovery.autolink.test.js`. Before adding more, read those — the patterns repeat.
- Cross-cloud invariants (shared `via` weights, dual-write removal, `via` filters in autolink's structural matches) have explicit invariant tests in `discovery.autolink.test.js`. Any PR that breaks one should update both sides of the invariant or fail the test deliberately.
- Bootstrap and ARM-id parsing have edge cases — don't trust a fix until there's a test for the specific shape.

### Logging

Structural decisions (signal fired, score assigned, edge created/skipped) should be logged at a level that lets us reconstruct why the graph looks the way it does. When in doubt, log the `evidence` string that would go on the edge.

### Naming

Keep the `auto-link` / `bootstrap` / `bootstrap-rg-propagation` / `manual-link` / `manual-deploy` / `azure-resource-graph` / `gcp-cloud-asset-inventory` / `aws-config-aggregator` / `azure-network-watcher` / `azure-vm-insights` / `gcp-iam-policy` / `otel` / `servicenow-cmdb-rel` `source` vocabulary consistent across writers, readers, logs, and per-cloud `via→score` tables. Renaming any of these is a coordinated change, not a local one.

---

## How to work with me

I'm actively iterating on this codebase and thinking about the product positioning, so I need you working with me, not ahead of me.

**Default to the `propose-before-implementing` skill** for any change that:
- Introduces or modifies a structural-edge `via` value or its score
- Changes auto-link rule logic, thresholds, or scoring
- Alters the graph schema (node labels, the `:CONNECTS_TO` property contract, required vs. optional properties)
- Adds a new resource type to a scanner, or a new supplement layer
- Touches per-cloud cloud_id parsing
- Refactors across scanner / supplement / auto-link / bootstrap

For those, produce 2–3 candidate approaches with tradeoffs and wait for my pick before writing code. Include what each option optimizes for and what it costs.

**You can proceed without a proposal** for:
- Bug fixes with an obvious single correct answer
- Test additions that lock in current behavior
- Log message improvements, comment clarifications, doc updates
- Typo and lint fixes

**When you finish a task**, don't just say "done." Surface the top 2–3 adjacent improvements you noticed while working, ranked by blast-radius impact on the system. I'd rather have a candid list of "here's what I'd look at next and why" than a clean handoff that hides friction you saw.

**When you're uncertain**, say so explicitly and propose how to resolve the uncertainty (a test, a query against the graph, a question for me). Don't pick a direction and hope.
