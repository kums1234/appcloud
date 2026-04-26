# Discovery native-graph refactor — slice plan

Tracks the 5-slice replacement of per-service cloud SDK scanners with each
cloud's native inventory API. Living document; update as slices land or
scope shifts. See `docs/azure-resource-graph-coverage.md` for the
slice-1 coverage audit, and the memory entries
`feedback_supplement_model.md`, `feedback_single_edge_type.md`,
`feedback_fidelity_over_single_query.md` for the durable decisions this
plan rests on.

## Shape (applies to every cloud)

- **Primary**: one native-inventory query — ARG for Azure, Cloud Asset
  Inventory for GCP, Config aggregator for AWS. Paginated, emits both
  (:Infra) nodes and unambiguous structural `:CONNECTS_TO` edges.
- **Supplement (opt-in per layer)**: high-fidelity signals the primary
  cannot surface. Each layer is named, gated by a flag, writes
  `:CONNECTS_TO` with its own `source` string.
- **Auto-link (Phase 2)**: consumes the graph produced above; infers
  Component ↔ Infra ownership; dual-writes `:DEPLOYED_ON` (legacy) and
  `:CONNECTS_TO[source='auto-link']` until slice 5.
- **Edge-write policy (Option A dual-write)** through slices 1–4:
  scanner + supplement + auto-link write both the legacy label
  (`:CONNECTED_TO` / `:DEPLOYED_ON`) and the new canonical
  `:CONNECTS_TO`, carrying the same traceability properties
  (`source`, `via`, `confidence`, `evidence`).

## Slice 1 — Azure via Resource Graph · **DONE**

- [discovery.azure.js](../api/src/routes/discovery.azure.js) —
  ARG-primary scanner with pagination, dual-write structural edges.
- [discovery.azure.supplement.js](../api/src/routes/discovery.azure.supplement.js)
  — Network Watcher + VM Insights + auto-link (dual-writes DEPLOYED_ON
  and CONNECTS_TO).
- `discovery.js` Azure scanner body deleted (net –1101 lines);
  post-scan Layer-A enrich calls removed; `scanAzure` is now a
  drop-in passthrough to the new file.
- Typed relationships (`NETWORK_INTERFACE`, `HOSTED_ON_PLAN`, …) no
  longer written — confirmed no readers outside this refactor.
- Tests: [discovery.azure.test.js](../api/src/routes/__tests__/discovery.azure.test.js) +
  [discovery.azure.supplement.test.js](../api/src/routes/__tests__/discovery.azure.supplement.test.js)
  lock behaviour including `VIA_TO_CONFIDENCE` scores and dual-write
  shape.
- 6 Azure SDK usages dropped from discovery.js:
  `arm-compute`, `arm-containerservice`, `arm-sql`, `arm-appservice`,
  `arm-rediscache`, `arm-resources`. Retained:
  `arm-resourcegraph` (primary), `arm-network` (Network Watcher),
  `monitor-query` (VM Insights), `identity` (auth). Package-json
  pruning deferred to slice 5.

## Slice 2 — GCP via Cloud Asset Inventory

- **Primary**: `cloudasset.assets.listAssets` — single paginated call
  across the configured project(s). File:
  `api/src/routes/discovery.gcp.js`. Drops `@google-cloud/compute`,
  `@google-cloud/container`, `@google-cloud/resource-manager`, and the
  `googleapis` sqladmin / run calls in `discovery.js`.
- **Supplement (to be scoped during implementation)**:
  `api/src/routes/discovery.gcp.supplement.js`. Candidate layers —
  VPC flow logs (observed flows, analog of Azure VM Insights) and
  IAM Policy Analyzer (if we need IAM-edge fidelity CAI's
  `iamPolicy` view misses). Keep minimal until the coverage diff
  surfaces a real gap.
- **Coverage audit deliverable**: `docs/gcp-cloud-asset-coverage.md`
  — per-type SDK field → CAI availability → decision, same structure
  as Azure's.
- **Prereqs**: caller service-account needs
  `cloudasset.assets.listAssets` on the org/project.
- Edge-write policy: continue Option A dual-write.

## Slice 3 — AWS via Config aggregator

- **Primary**: Config aggregator query across regions/accounts. File:
  `api/src/routes/discovery.aws.js`. Drops all 7 `@aws-sdk/client-*`
  discovery-path SDKs (ec2, rds, lambda, eks, ecs, elb-v2,
  elasticache). Retains `@aws-sdk/client-s3` (used by
  `iac-state-backend/backends/s3.js`, not discovery).
- **Coverage caveat**: not every AWS resource type is Config-supported.
  The coverage doc (`docs/aws-config-aggregator-coverage.md`) must
  list the gap set and, for each missing type, a decision:
  enable "advanced resource types" in Config (if supported there), add
  a targeted SDK fallback, or confirm the type is unused.
- **Supplement (to be scoped during implementation)**:
  `api/src/routes/discovery.aws.supplement.js`. Likely layers — VPC
  flow logs (observed flows), CloudWatch Metric Insights (if we want
  live utilisation edges).
- **Prereqs**: Config enabled per account + an aggregator. Documented
  in secrets_setup.md's new Prerequisites section (slice 4).
- Edge-write policy: continue Option A dual-write.

## Slice 4 — Docs · **DONE**

- [CLAUDE.md](../CLAUDE.md) — Discovery architecture rewritten end to end.
  Single `:CONNECTS_TO` edge label with required traceability properties
  (`source`, `via`, `confidence`, `evidence`, `discovered_at`,
  `last_seen`); per-cloud `via→score` table locations; primary scanner +
  supplement layers + auto-link three-stage model; cross-cloud
  invariants; per-cloud node-identity rules; the migrations directory
  + manual application stance.
- [secrets_setup.md](../secrets_setup.md) — added **Cloud-account
  prerequisites** section with per-cloud roles/permissions tables (Azure
  Reader + Network Watcher + Log Analytics; GCP
  `cloudasset.assets.listAssets`; AWS Config + Aggregator + advanced
  resource types). Also documents the local-dev auth-disabled mode.
- [docs/api-guide.md](api-guide.md) — comprehensive HTTP API reference
  with curl examples for every domain (discovery, applications,
  components, infra, graph, ai, audit, cmdb, integrations) plus
  multi-step workflow recipes and a Postman setup pointer.
- [docs/api-postman-collection.json](api-postman-collection.json) —
  importable Postman v2.1 collection. 19 folders, 100 requests, with
  `{{baseUrl}}` and `{{apiKey}}` variables and pre-populated bodies for
  every write operation.
- Per-cloud coverage docs (`azure-resource-graph-coverage.md`,
  `gcp-cloud-asset-coverage.md`, `aws-config-aggregator-coverage.md`)
  remain the source of truth for field-by-field decisions; CLAUDE.md
  cross-links them.

## Slice 5 — Cleanup · **DONE**

Reader migration (10 files), writer collapse (every `:DEPLOYED_ON` writer
now writes single `:CONNECTS_TO {via:'component-mapping'}`), scanner +
supplement single-write, autolink `MATCH` switched to `:CONNECTS_TO` with
`r.via <> 'component-mapping'` filters, OTEL aggregator + connector
migrated, ServiceNow CMDB migrated to `:CONNECTS_TO` with via-encoded
relation flavour, `discovery.schema.js` purged of `VIA_TO_REL_TYPE` /
`getTypedRel`, `cleanupStaleNodes` errored-scan guard added,
package.json pruned (6 Azure SDKs + 7 AWS SDKs + 3 GCP SDKs gone),
[002-edge-consolidation.cypher](../api/src/migrations/002-edge-consolidation.cypher)
ran against the live graph (Phase A copy + Phase B delete),
[003-connects-to-indexes.cypher](../api/src/migrations/003-connects-to-indexes.cypher)
adds composite + single-key indexes on the unified edge.

288/290 unit tests pass — same 2 pre-existing `release/0.1.0.0`
failures, zero slice-5 regressions. Smoke against the cluster: scanners
load, route handlers walk the new edge shape, `/graph/topology` returns
30 deployments + 24 cross-app connections through `:CONNECTS_TO` only.

## Slice 6 — Adjacent improvements landed during slice-4/5 follow-up · **DONE**

Three issues surfaced as adjacent improvements during earlier slices,
landed together as slice 6.

### 6.1 — Consolidate `/discovery/accounts` into `/integrations/cloud`

`/discovery/accounts` was a CRUD shim over the same `cloud_accounts`
Postgres table that `/integrations/cloud` already owned. Discovery is
now a *consumer* of cloud-account configurations — it reads them via
the existing `loadAccounts` helper but no longer offers create/list/
delete endpoints of its own.

- Removed `GET`/`POST`/`DELETE /discovery/accounts` route handlers
  (~70 lines from `discovery.js`).
- Updated the two "configure an account first" error messages to point
  to `POST /integrations/cloud`.
- Removed the discovery-side accounts folder from the Postman
  collection; expanded the `/integrations/cloud` folder with explicit
  Azure/GCP/AWS request templates and the `sync-from-neo4j` migration
  endpoint.
- Updated [docs/api-guide.md](api-guide.md) and `api/src/README.md` to
  reflect the single canonical surface.

### 6.1b — Slice-5 regression in OTel pipeline integration test

The slice-5 cleanup deleted `VIA_TO_REL_TYPE` and `getTypedRel` from
`discovery.schema.js`, but `api/src/__tests__/integration/otel-pipeline.test.js`
still imported them. Caught while reading the existing integration-test
pattern for slice 6.3.

- Removed the dead import; replaced the typed-rel sync assertion with a
  set membership check against the documented telemetry `via` namespace
  (`otel-http`, `otel-rpc`, `otel-db`, `otel-messaging`).
- Updated the Cypher MERGE + final verification query from `:CONNECTED_TO`
  to `:CONNECTS_TO` to match the slice-5 single-edge model.

### 6.2 — OpenAPI generation

`@fastify/swagger` + `@fastify/swagger-ui` registered at server startup.
Routes are auto-tagged by their first path segment via a `transform`
hook, so the 75 endpoints group into 11 OpenAPI tags (Applications,
Components, Discovery, …) without per-route annotation.

- `GET /openapi.json` — machine-readable spec, importable into Postman /
  openapi-generator / Spectral.
- `GET /docs` — interactive Swagger UI.
- `npm run openapi:export` boots a stub server (no DB), generates the
  spec, and writes it to `docs/openapi.{json,yaml}` for offline / SCM
  use. Currently 75 paths, 11 tags.
- API key security scheme declared globally; `/health` and `/` opt out.
- Schema annotations are declared inline only on `/health`, `/`, and
  `/openapi.json` so far. The rest of the catalogue exists in OpenAPI
  with auto-derived path + method + tags but without request/response
  schemas. Filling those in is incremental and route-by-route — track
  in a separate slice if/when the API stabilises.

### 6.3 — CMDB assessment integration test

`api/src/__tests__/integration/cmdb-assessment.test.js` exercises
`runAssessment` end-to-end against a real Neo4j via Testcontainers.
Three test cases:

- **Match path**: a CI sharing a `cloud_id` with an Infra node produces
  a `:REPRESENTS` edge with `matchType='exact_cloud_id'`,
  `confidence=95`, `episodeId` linked to the run's
  `:IngestionEpisode`. The CI's `relevance` / `quality` /
  `assessReasons` properties are written back. An unmatched CI gets the
  scores but no `:REPRESENTS`.
- **Idempotency**: re-running the assessment moves the edge to a new
  episodeId, refreshes `lastSeenAt`, but leaves `createdAt` untouched
  — confirms the MERGE is matching, not duplicating.
- **Expire-stale path**: a CI that loses its match between runs has its
  `:REPRESENTS` edge marked `expiredAt` (not deleted), preserving audit
  history.

Skips cleanly if Docker is unavailable or the Node version isn't
20/22 LTS, mirroring the existing `otel-pipeline.test.js` pattern. Run
explicitly with `npm run test:integration`.

## Slice 7 — OpenAPI coverage, drift detection, Postman-from-spec, pre-existing-failure cleanup · **DONE**

### 7.0 — Diagnose and fix the two pre-existing failures

- **`hasHighEntropy('db01')`** — the entropy gate let short hostnames
  through because per-character entropy of a 4-distinct-char string is
  2.0, above the 1.5 threshold. Added a minimum-length precondition
  (`NAME_MIN_LENGTH = 6`) so distinguishing-poor short names fail before
  entropy is even computed.
- **`ServiceNowClient.listCis honours the 'max' cap`** — `sysparm_limit`
  was clamped correctly on the request, but the yielded page was the
  full server response, so a server that ignored `sysparm_limit`
  over-yielded. Sliced the yielded page to `remaining` defensively.
  Production code is now contractually correct even when the upstream
  server misbehaves.

Both fixes are 2–3 lines each. Full suite is now **292/292 green** for
the first time since slice 1.

### 7.1 — OpenAPI drift test

[api/src/__tests__/openapi-drift.test.js](../api/src/__tests__/openapi-drift.test.js)
imports the same export logic the CLI script uses, builds the spec
in-process against a stub Fastify (no DB connections), and diffs the
output against `docs/openapi.{json,yaml}` byte-for-byte. Two test
cases — JSON and YAML — fail with an actionable message
(`Run: cd api && npm run openapi:export`) when drift is detected.

Runs in CI automatically (it's just a unit test) and locally before
every commit. No pre-commit hook plumbing required.

### 7.2 — Postman generated from OpenAPI

`scripts/export-openapi.js` now also generates
`docs/api-postman-collection.json` via `openapi-to-postmanv2`. The
single source of truth is the OpenAPI spec; the Postman collection is
mechanically derived from it (96 requests, 12 folders grouped by
OpenAPI tag) plus a hand-curated `Quickstart` folder prepended for the
"first three requests" onboarding experience. Multi-step workflow
recipes stay in `docs/api-guide.md §13` (where they belong as
narrative).

`docs/api-postman-collection.json` is now an artefact, not a
source-of-truth. Edit OpenAPI annotations on routes, run
`npm run openapi:export`, both `openapi.{json,yaml}` and the Postman
collection update together. The drift test catches anyone who forgets.

### 7.3 — OpenAPI schema annotations across every route file

[api/src/schemas/openapi.js](../api/src/schemas/openapi.js) defines
~12 reusable JSON schema components (Application, Component, Infra,
CloudAccount, ScanResponse, Suggestion, GraphTopology, GraphImpact,
ErrorResponse, IdParam, …). Every route file imports the components it
needs and declares a `schema` block on each handler.

Coverage shape:

- **Full body + response schemas**: applications.js, components.js,
  infra.js, integrations-cloud.js, plus discovery.js scans / suggest /
  link / bootstrap / linking-strategies / enrich.azure.
- **Summary + description + tags + minimal request/response shapes**:
  graph.js (every route), discovery.js (schedule, debug, summary,
  resources), audit.js, cmdb.js, ai.js, integrations.js,
  integrations-ai.js, integrations.management.js,
  discovery.metadata.js.
- **Auto-tagging by path segment** continues to apply via the
  `transform` hook, so any route added in the future picks up its tag
  without explicit annotation.

Re-exported spec: still 75 paths in the offline export (77 live —
runtime-only `/openapi.json` + `/docs/json` aren't part of the export
script's catalogue). Every operation now has at minimum a `summary`,
making Swagger UI navigable; high-value routes additionally have
request body schemas, response shapes, parameter schemas, and the
`StandardErrorResponses` envelope.

To regenerate after route edits:

```
cd api && npm run openapi:export
```

Drift test catches you if you forget.

### 7-extras

- Ajv strict mode disabled with explicit OpenAPI keyword allow-list
  (`example`, `xml`) so route schemas can carry OpenAPI 3.0 annotations
  without the validator rejecting them. Body / param validation still
  runs.
- Smoke test against the live cluster: API `/health` 200, `/openapi.json`
  reports 77 paths / 12 tags, `/docs` serves Swagger UI, route shapes
  unchanged behind annotations (graph topology returns the same 18 apps
  / 66 components / 24 connections / 30 deployments as before).

## Slice 5 — original plan (kept for traceability)

- **Drop dual-writes** everywhere: scanner, supplement, auto-link. Only
  `:CONNECTS_TO` is written going forward.
- **Migrate readers** — the 26 route/agent/compliance/UI files that
  `MATCH ()-[:DEPLOYED_ON]-()` or
  `MATCH ()-[:CONNECTED_TO]-()`. Most become
  `MATCH ()-[r:CONNECTS_TO]-() WHERE r.source IN ['auto-link', …]`
  with the appropriate `source` filter.
- **`autoLink` switches its `MATCH` from `:CONNECTED_TO` to
  `:CONNECTS_TO`** (adjacent item #2 from slice 1). Must land in the
  same PR as the writer dual-write drop or the autoLink stops finding
  edges the moment writers stop writing `:CONNECTED_TO`.
- **One-shot Cypher migration** ([002-edge-consolidation.cypher](../api/src/migrations/002-edge-consolidation.cypher)).
  **⚠ Order matters**: run Phase A (copy legacy edges → `:CONNECTS_TO`)
  *before* deploying the slice-5 API; run Phase B (delete legacy)
  *after* the deploy is steady. Reason: the slice-5
  `cleanupStaleNodes` filter
  `NOT (:Component)-[:CONNECTS_TO {via:'component-mapping'}]->(i)`
  treats bootstrap-only-mapped nodes (which had `:DEPLOYED_ON` but no
  `:CONNECTS_TO` twin pre-slice-5) as orphaned and deletes them on the
  first post-deploy scan.
  - Existing `:DEPLOYED_ON` edges → already covered by `:CONNECTS_TO`
    dual-write, safe to `DELETE` after readers migrate.
  - Existing `:CONNECTED_TO` edges → same story.
  - Existing typed-rel edges (`NETWORK_INTERFACE`, `ATTACHED_DISK`,
    `PART_OF_SUBNET`, `MEMBER_OF_VNET`, `SECURED_BY`, `HAS_PUBLIC_IP`,
    `USES_ROUTE_TABLE`, `HOSTED_ON_PLAN`, `VNET_INTEGRATED`,
    `MONITORED_BY`, `AKS_NODE_SUBNET`, `CHILD_OF_SERVER`,
    `VNET_INJECTED`, `PRIVATE_ENDPOINT`, `KEYVAULT_ACL`, `LB_BACKEND`,
    `AGW_SUBNET`, `OBSERVED_CONNECTION`, `MONITORS`,
    `TOPOLOGY_CONTAINS`, `TOPOLOGY_ASSOCIATED`, plus OTel
    telemetry-derived rel types and `STATE_REFERENCE`) — slice 1
    stopped writing these going forward; existing edges from prior
    scans still exist. `MATCH ()-[r:NETWORK_INTERFACE|…]-() DELETE r`
    purges them (adjacent item #1 from slice 1).
- **`discovery.schema.js`** — delete `VIA_TO_REL_TYPE` and the
  `getTypedRel()` helper once nothing writes them.
- **Prune `api/package.json`** — drop the 6 Azure SDKs from slice 1
  plus all 7 AWS discovery SDKs (slice 3) plus the GCP clients
  (slice 2). Retain: `@azure/identity`,
  `@azure/arm-resourcegraph`, `@azure/arm-network`,
  `@azure/monitor-query`, `@aws-sdk/client-s3` (iac-state),
  `@google-cloud/storage` (iac-state), whatever client the CAI and
  Config implementations add.
- **Extract shared ARG client helper** (adjacent item #3 from slice 1) —
  by slice 5 there are at least two ARG consumers:
  `discovery.azure.js` (primary scanner) and the Azure Arc branch of
  `/discovery/enrich` in `discovery.js`. A small helper exporting a
  configured `ResourceGraphClient` + `queryAllPages(kql, subId)`
  removes boilerplate from both.
- **Delete `cleanupStaleNodes`'s `DEPLOYED_ON` checks** or convert
  them to `:CONNECTS_TO[source IN [...]]`, depending on whether we
  still want auto-link ownership to gate stale-node deletion (the
  current behaviour is "don't delete nodes with a Component owner").
- **Guard `cleanupStaleNodes` against errored scans** (adjacent item
  surfaced during slice 1 smoke test). Today it runs unconditionally
  after every scan — when the scan errors before reading any
  resources (e.g., bad credentials), the cleanup pass marks
  every existing Infra node stale because none of them got a fresh
  `lastupdated`. Concrete fix: skip cleanup when the scan returned
  zero nodes AND `stats.errors.length > 0`. Land it in slice 5
  rather than mid-flight so the change is reviewed alongside the
  rest of the cleanup-and-migration sweep.
