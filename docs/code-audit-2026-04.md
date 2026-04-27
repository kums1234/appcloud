# AppCloud code audit — 2026-04

**Branch:** `security_enhancement` (currently includes the work shipped through the multi-key-rbac, fastify5, and security-improvements slices).
**Method:** six parallel exploration agents, each with a fixed rubric — security, correctness, operations, performance, testing, docs/API. Each produced a punch list with `file:line` references and a severity tag; this doc aggregates, deduplicates across overlaps, and ranks by blast radius.

This is a **one-time artifact**, not a living checklist. Use it to plan the next 4–6 slices, then archive. The trickle-of-adjacent-improvements notes from per-slice work continue alongside, but they are now a backstop, not the primary feed.

---

## How to read this

Severity scale (consolidated across all six rubrics):

- **P0** — exploitable now, silent data loss, or production-blocking on realistic data volume. Ship a fix in the next 1–2 slices.
- **P1** — high blast radius but needs deliberate triggering (specific concurrency window, unusual scale, partial outage). Ship within the next 4–6 slices.
- **P2** — bounded blast radius / defense-in-depth / nice-to-have hardening. Backlog.
- **P3** — polish, micro-optimizations, doc nits. Park unless the surrounding code is being touched anyway.

Every finding cites `file:line`. Where multiple agents converged on the same root cause, the entry is consolidated and tagged `[seen by: <dimensions>]`.

**Counts:** 7 P0, 21 P1, 28 P2, 18 P3. Plus 2 false positives caught during verification (documented at the bottom for transparency).

---

## Executive summary

Five themes that should drive sequencing:

1. **Audit pipeline observability is incomplete.** The retry buffer, partition retention, and OTel aggregator all have silent failure modes — errors get swallowed, drops get logged but never alerted, and the operator-facing signals don't add up to "audit log is healthy." A handful of pointed fixes (drain error logging, partition-drop retry visibility, missing exposed counters) would close most of this.
2. **Single-pod / single-instance assumptions leak into multi-pod deployments.** Scheduler `fetch('http://localhost:PORT/...')`, in-memory `running` flags as concurrency guards, in-process auth-key cache as the only refresh mechanism — none of these survive horizontal scaling. Multi-tenant work (next-next slice) will force this anyway; flag it now so the design doc accounts for it.
3. **Response schemas are loose.** ~91% of OpenAPI response declarations use `additionalProperties: true`. This breaks Fastify's fast-json-stringify path (perf), prevents client-side type generation (DX), and lets schema drift go undetected (correctness). Tightening them is a multi-PR sweep, not one slice.
4. **Test coverage of admin / lifecycle endpoints is sparse.** `admin-api-keys` (4 handlers, 0 tests), the new `admin-audit-cleanup` (0 tests), `iac-ingest`, AI-provider plumbing — these are exactly the places where a regression would matter. The fuzz test we just added is a partial mitigation, not a substitute.
5. **The auth-disabled local-dev fallback is a footgun in disguise.** When Postgres is unreachable AND no bootstrap envs are set, every request becomes anonymous-admin. This is documented as intentional (`feedback_pre_customer_priorities.md`) but emits one warning at boot and goes silent. A periodic re-warn would catch the case where a deploy quietly lost its bootstrap secrets.

---

## P0 — ship in the next 1–2 slices

### P0.1 — Neo4j hard fail-fast on startup blocks every deploy

`api/src/plugins/neo4j.js:39` — `verifyConnectivity()` throws and the API process exits if Neo4j is unreachable, with no graceful degradation. Postgres degrades to a stub on the same scenario; Neo4j does not.
**Why it matters:** During a Neo4j rolling restart or version upgrade, the API can't start at all. K8s rolls forward, Neo4j pod isn't ready, API pod crash-loops, customers see 5xx until Neo4j is fully up. Single-pod deployments = 100% downtime; multi-pod = thrashing replicas.
**Fix sketch:** Mirror the Postgres pattern — catch the error, log it, decorate `fastify.neo4j` with a stub that returns 503 from query/write methods. Add a `/ready` endpoint that probes both DBs (see P0.2).
[seen by: ops]

### P0.2 — Liveness vs. readiness probes don't probe DB connectivity

`k8s/base/api-deployment.yaml:readinessProbe → /health` returns 200 unconditionally; the actual gate that should keep traffic away during a deploy is missing. Combined with P0.1, a pod can pass readiness while one of its DBs is unreachable.
**Why it matters:** Traffic routes to a pod that will 5xx every request.
**Fix sketch:** Add `GET /ready` that calls `await fastify.pg.pool?.query('SELECT 1')` + `await fastify.neo4j.driver.verifyConnectivity()` with a tight timeout, returns 503 on failure. Point the K8s readinessProbe at `/ready`; keep `/health` for liveness.
[seen by: ops]

### P0.3 — Audit retry-buffer drain breaks on the first failure

`api/src/utils/audit-buffer.js:79–86` — when `drain()` fails to insert one buffered row, the entire drain loop short-circuits via `catch(err) { return { error } }`. Subsequent rows in the buffer never get retried until the next periodic drain, which will hit the same row first and fail again.
**Why it matters:** A single bad row (FK violation, oversize, transient network) blocks the entire backlog. Combined with the `dropped` counter incrementing silently when the buffer fills, audit data is lost and nothing alerts.
**Fix sketch:** Per-row try/catch inside the drain loop; log the error with the row id, increment a `failedRows` counter, continue. Expose the counter via `/metrics`.
[seen by: correctness, ops]

### P0.4 — Scheduler scan loop is single-pod-only

`api/src/plugins/scheduler.js:138, 160, 187` — fires `fetch('http://localhost:PORT/discovery/scan/aws')` against the local process. In a 2+ replica K8s deployment, every replica's scheduler fires its own scans concurrently against the same cloud accounts, multiplying API costs and hammering rate limits.
**Why it matters:** Production cloud-API rate limits get hit. Account-locked-out incidents. AWS bills go up by N× replicas.
**Fix sketch:** Replace `fetch(localhost)` with direct in-process function calls (the scan logic is already in routes/discovery.js). For multi-pod election, use a simple Postgres-row lock or an interval offset by pod ordinal. Document the current single-pod assumption clearly until then.
[seen by: ops, testing]

### P0.5 — `running` flags as concurrency guards

`api/src/plugins/scheduler.js:67–71` and `api/src/plugins/cmdb-assessment-scheduler.js:96–117` — both use a JS-local `running` boolean to gate re-entrancy. This works on a single pod but leaks across an `await` (the gap between check and set lets a second tick enter), and breaks completely in multi-pod.
**Why it matters:** Concurrent scans can step on each other (duplicate :IngestionEpisode nodes, double-write attempts in audit_log). Less acute than P0.4 but in the same family.
**Fix sketch:** Promise-based lock for single-pod (`if (running) return; running = newPromise; ... finally { running = null }`). Postgres-backed advisory lock for multi-pod. Same fix applies to both files; they're literally the same pattern duplicated.
[seen by: correctness]

### P0.6 — Auth-disabled mode is silent after boot

`api/src/plugins/auth.js:269–280` — when no bootstrap env vars are set AND the DB cache is empty, every request is treated as anonymous-admin. This is intentional for local dev. The plugin warns once at boot and never again. If a production deploy loses its bootstrap secrets (deleted ConfigMap, expired Secret, race with secret-mount), the API silently runs wide-open.
**Why it matters:** This is the kind of failure that doesn't surface until the auditor asks "why does the audit log show 'anonymous' for every request from yesterday?". By then the data leak has happened.
**Fix sketch:** Log the warning every 60s (or every Nth request) when auth is disabled. Emit a Prometheus metric `appcloud_auth_disabled` that operators can alert on. Refuse to start at all when `NODE_ENV=production` AND auth is disabled — gate behind a separate `APPCLOUD_ALLOW_OPEN_AUTH=true` knob.
[seen by: security]

### P0.7 — Encryption: per-row HKDF salts give one-key-leak total compromise

`api/src/utils/encrypt.js:99–101` — per-row keys derive from a master key via HKDF, with the per-row salt stored alongside the ciphertext. If an attacker exfiltrates the master key (via env-var leak, log inclusion, or process memory), every encrypted row is recoverable in a single pass — the salt is right there.
**Why it matters:** Encrypted fields include cloud credentials (integrations table). One master-key leak = full credential dump.
**Fix sketch:** Add key-version metadata to ciphertext. Implement a rotation procedure (CLI script: re-encrypt all rows with new master key, retire old). Document the rotation cadence in `secrets_setup.md`. This is a multi-day effort — but the design needs to land before a customer with compliance requirements asks.
[seen by: security]

---

## P1 — high blast radius, ship in the next 4–6 slices

### Authentication / authorization

- **`api/src/server.js:80`** — rate-limit key generator is `req.headers['x-api-key'] || req.ip`. An unauthenticated attacker rotating keys (each request a new fake X-API-Key) bypasses the global 300/min cap. **Fix:** rate-limit on IP for unauthed requests; per-key limits only after authentication succeeds.
- **`api/src/routes/audit.js:114–116`** — admin-only `q=` query uses ILIKE on `actor` / `resource_name` with no length limit. A pathological pattern can DoS Postgres. **Fix:** cap `q` length (e.g., 200 chars) + reject leading wildcards. Admin-only blunts urgency but doesn't eliminate it (compromised admin key).

### Correctness

- **`api/src/utils/audit-partitioning.js:282 (DETACH) → 313 (ATTACH in finally)`** — if ATTACH fails after a partial-success move, the default partition is left detached. Future INSERTs that should land in default get rejected at the partition tree. **Fix:** log the ATTACH result explicitly; expose detached state via `/metrics`; document the manual `ALTER TABLE … ATTACH PARTITION audit_log_default DEFAULT` recovery procedure.
- **`api/src/utils/audit-partitioning.js:139`** — `monthBounds()` for `month=12` produces `to: Date.UTC(year, 12, 1)` which JS interprets as January of `year+1` correctly *via overflow* — but the `partitionName(year, 12)` next iteration in `ensureCurrentAndNextPartitions` uses `next.y = year+1, m=1`, which is right. The math is correct *but the agent's flag is worth keeping as a P3 test target* — add an explicit test for the December → January boundary.
- **`api/src/routes/applications.js:107`** — `parseInt(tier)` with no bounds check. Schema requires it but `parseInt('99999')` succeeds; the value lands in Neo4j. **Fix:** schema-level `enum: [1,2,3,4]` (or whatever the valid set is), not `parseInt`.

### Operations

- **`api/src/plugins/postgres.js:Pool({ max: 10 })`** — hardcoded pool size. At ~20 concurrent requests doing audit + DB queries, the pool saturates and audits get buffered. **Fix:** `APPCLOUD_PG_POOL_MAX` env var, default 10, document tuning. [seen by: ops, perf]
- **`api/src/plugins/scheduler.js:138–149`** — cloud-scan errors logged as flat strings. **Fix:** structured logging with `{ provider, accountId, attempt, durationMs, errorCode }`.
- **`api/src/plugins/audit-cleanup.js:103, 140`** — partition-drop / DELETE failures log `err.message` only. No `{ partition, retentionDays, batchSize }` context. **Fix:** structured fields throughout.
- **`api/src/plugins/postgres.js:142`** — periodic drain loop `.catch(() => {})` swallows every error. After 100 silent failures, oncall sees `audit_buffer_pending = 1000` and no clue why. **Fix:** log at WARN with error details. [seen by: ops]
- **`k8s/base/api-deployment.yaml`** — no `imagePullPolicy: Always`, no `PodDisruptionBudget`, no `securityContext: { runAsNonRoot: true, readOnlyRootFilesystem: true }`. **Fix:** all three are routine K8s hardening.
- **`api/src/plugins/ai.js:177–205`** — Ollama availability cached at boot; never re-checked. If Ollama crashes mid-session, the next request sees `cloudAvailable=true` from 5 minutes ago and 503s only after attempting the call. **Fix:** 5-min TTL on the availability cache, or check on every request (it's cheap).

### Performance

- **`api/src/routes/discovery.aws.js:381–382`, `discovery.azure.js:306–308`** — N+1 await loop linking subnets / disks / NICs to each resource. At 100k cloud resources × 10 links each, this is 1M sequential round-trips. **Fix:** batch into `UNWIND $links AS link MERGE …` per resource type.
- **`api/src/routes/graph.js:216`, `routes/audit.js`, `routes/infra.js`** — unbounded result sets. `MATCH (s:Snapshot) RETURN s ORDER BY ... DESC` with no LIMIT; `GET /infra` returns every node. **Fix:** add `?limit=` (default 100) + cursor-based pagination on the audit / infra endpoints; cap snapshot list at 100.
- **`api/src/plugins/scheduler.js:127–149`** — providers scan serially (AWS → Azure → GCP). At 30s + 20s + 40s = 90s per tick. **Fix:** `Promise.all(providers.map(scan))`. (Note: also relevant to P0.4.)

### Testing

- **`api/src/routes/admin-api-keys.js`** — zero handler-level tests on 4 admin handlers (POST create, GET list, DELETE revoke, PATCH update). Critical surface for key lifecycle. **Fix:** route tests covering happy path + duplicate-name + revoke-self + bootstrap-key-protection.
- **`api/src/routes/admin-audit-cleanup.js`** — zero tests for `redistribute-default` endpoint as a route (the underlying util has integration coverage). **Fix:** route test exercising the admin-tier guard, body-rejection, response shape.
- **`api/src/utils/iac-ingest.js`, `utils/ai-providers.js`, `utils/ai-prompts.js`** — zero unit tests on ingest helpers and AI provider plumbing. **Fix:** prioritize ai-providers (real failure mode) over iac-ingest (graph writes are MERGE-only and hard to misuse).
- **`api/src/__tests__/auth-coverage.test.js`** — asserts preHandler attachment but doesn't actively exercise auth. A broken middleware chain that silently skips `authenticate` would still pass. **Fix:** companion test that hits each non-public route without an API key, asserts 401.

### Docs

- **`api/src/README.md` env-var table** — omits ~25 env vars currently read by the code (`APPCLOUD_ALLOWED_ORIGINS`, `APPCLOUD_AUDIT_BUFFER_DRAIN_MS`, `APPCLOUD_AUDIT_CLEANUP_BATCH_SIZE`, `APPCLOUD_AUTH_CACHE_TTL_MS`, `APPCLOUD_RATE_LIMIT_*`, `APPCLOUD_KDF_SALT`, all AI provider keys, all `OTEL_AGG_*`). **Fix:** comprehensive `.env.example` with comments + reference from README.
- **`CLAUDE.md:158–159`** — references migrations `002-edge-consolidation.cypher` and `003-connects-to-indexes.cypher` that don't exist on disk in `api/src/migrations/`. Either they're inlined into postgres-init or never landed. **Fix:** reconcile — either remove the references or commit the missing files.

---

## P2 — bounded blast radius / defense-in-depth

### Security
- `api/src/routes/integrations.management.js:140` — integration creation audit doesn't capture `config` diffs. Tampering visible only via "this row got updated", not "what changed".
- `api/src/plugins/auth.js:293–304` — Map.get on the hash is O(1) but no explicit constant-time recheck via `safeHashEqual`. Belt-and-braces.
- `api/src/routes/integrations.js:34–39` — Terraform upload filename logged unsanitized into audit metadata. Path-traversal-shaped filenames pollute the audit log without affecting filesystem.
- `api/src/server.js:36–48` — CORS allowlist includes Vite dev port by default. Prod deploys should override `APPCLOUD_ALLOWED_ORIGINS`; missing this is a soft signal.
- `api/src/routes/admin-api-keys.js:110–114` — key expiry checked at creation, not on cache refresh. Up to 60s window where an expired key still works.

### Correctness
- `api/src/plugins/otel-aggregator.js` — at-least-once semantics rely on idempotent MERGE. If MERGE semantics ever change (e.g., adding `ON CREATE SET created_at`), double-processing gets recorded as duplicate edges. **Fix:** add an integration test that simulates Neo4j-fail-then-succeed, asserts no duplicate edges.
- `api/src/utils/audit-buffer.js:94–105` — `enqueue()` evicts oldest row silently on overflow. Operator never paged. **Fix:** expose drop counter via `/metrics` (already done in this slice) — but also add an alert rule example to DEVELOPMENT.md.
- `api/src/routes/discovery.js:183` — discovery uses MERGE; manual POST/PATCH endpoints use CREATE. Not a violation per se (manual routes have unique IDs from the request) but inconsistent with the graph convention.
- `api/src/routes/applications.js:82` — GET handler does `records[0].get('a').get('components').map(...)` without checking for null. Optional MATCH could return null `a` if the graph is corrupted.

### Operations
- `api/src/plugins/scheduler.js:138` — internal `fetch()` calls have no timeout. A hung handler can block the entire scheduler timer. **Fix:** `AbortSignal.timeout(30_000)`.
- `api/src/plugins/audit-cleanup.js:113–121` — partition-drop failures log + continue, but no admin-facing recovery path. **Fix:** new admin endpoint `POST /admin/audit-cleanup/retry-failed-drops`.
- No distributed tracing / request ID propagation. The scheduler makes 3+ HTTP calls per tick with no correlation header. **Fix:** Fastify request-id plugin + propagate to downstream HTTP calls.
- `api/src/plugins/cmdb-assessment-scheduler.js:101–102` — fires first tick immediately on startup but swallows errors. Operators don't learn the worker is broken until the next tick succeeds. **Fix:** log the startup tick result explicitly.

### Performance
- `api/src/routes/audit.js:105–117` — composite query (`actor + action + resource_type`) hits single-column indexes. **Fix:** add `idx_audit_log_filters` composite covering the common filter combination + `created_at DESC`.
- `api/src/routes/discovery.js:154, 177` — hot-path `JSON.stringify` of `tags` and `raw` per resource. At 100k resources/scan, real CPU. **Fix:** check for already-stringified, or pass through as JSONB.
- ~91% of OpenAPI response declarations use `additionalProperties: true`. Disables `fast-json-stringify`. **Fix:** sweep across response schemas.

### Testing
- Stub-vs-prod drift: every test stub returns `async () => []`. Routes assuming `.length > 0` would pass tests but break in production with empty stub returns vs real partial data. **Fix:** "minimal valid response" stub fixtures per route.
- No test enforcing the `:CONNECTS_TO` invariant from CLAUDE.md (every edge has `source` + `via` + `confidence` + `evidence`). **Fix:** integration test that scans every committed Cypher and asserts the property set.
- `api/src/__tests__/integration/audit-resilience.test.js` covers Postgres outage; doesn't cover Neo4j outage. **Fix:** add a parallel test that fails Neo4j writes and asserts at-least-once.
- Discovery tests don't cover provider-rate-limit / 403 / timeout error paths. **Fix:** mock cloud APIs to fail with each, assert handler returns appropriate code.

### Docs
- `docs/openapi.yaml` — 90% of routes have loose response schemas (`additionalProperties: true`). Same root cause as the perf finding above; mention here so the docs slice picks it up.
- `docs/api-guide.md:723–726` — describes `/discovery/resources/<id>/refresh` as "no-op today". Either implement or remove from the doc.
- `api/src/README.md:237` — references `:DEPLOYED_ON` as a primary edge type; consolidation merged it into `:CONNECTS_TO {via:'component-mapping'}` already.
- No documented API versioning policy (when does `info.version` bump? what's the deprecation contract?).

---

## P3 — polish

(Compressed listing — these are nits, not work items.)

- Scheduler-style timer callbacks rarely re-schedule on error (silent freeze on first failure for some paths).
- Hardcoded localhost URLs in scheduler.js + drain timer interval (no env var).
- `api/src/plugins/audit-cleanup.js:144–170` — batched DELETE re-queries on every iteration; could be a single query with RETURNING.
- `api/src/plugins/neo4j.js:125` — index creation runs 21 statements in `Promise.allSettled` parallel. Fine, but a wave-of-3-4 would reduce driver connection churn at startup.
- `api/src/__tests__/integration/auth-plugin.test.js` uses `Date.now() + 60_000` for expiry tests. Edge case at clock-skew boundaries.
- `api/src/utils/encrypt.js:41,46,101` — Scrypt N=2^14 (OWASP minimum). Acceptable for static keys; future Argon2 migration is the right time-pressure-permitting move.
- `docs/discovery-native-graph-slices.md` — references future supplements (VPC Flow Logs, GCP Policy Analyzer) without a clear "shipped vs scoped" indicator.
- `docs/openapi.json info.version: 1.1.0` — no clear bump policy.
- `DEVELOPMENT.md` could use an operator runbook section ("audit_log is full, what do I do?").

---

## False positives (verified during consolidation)

Two findings were demoted out of P0 / P1 after I read the actual code. Documenting here for transparency:

1. **Cypher injection in `cmdb.js:51-52`** (security agent flagged P0) — the `matched` parameter is checked via `=== 'true'` / `=== 'false'` exact-match against literals; the resulting `matchedClause` is a hardcoded Cypher string. No user input flows into the query. Verified by reading the file.
2. **OTel aggregator deletes Postgres rows after Neo4j failure** (correctness agent flagged P1) — the catch block at `otel-aggregator.js:255` does an early `return` before the DELETE block. Neo4j-write failure leaves the rows in `otel_spans_raw` for the next tick, which is the correct at-least-once behavior. Verified by reading lines 250–267.

Lesson for future audits: the agents are pattern-matching at speed; the human verification step on each P0 is non-negotiable.

---

## Coverage gaps

What the agents couldn't reach:

- **Connector implementations** (`api/src/connectors/*/index.js`) — the security agent flagged SSRF / external-callback risk but couldn't fully trace the HTTP client construction in each connector's `healthCheck()` and inbound webhook handlers. ServiceNow + Terraform Cloud + IaC backends each have their own surface.
- **Multi-tenancy isolation** — codebase is single-tenant today, so there are no findings here, but the upcoming design doc needs to assume the audit log queries will need tenant-id filters and that the `:CONNECTS_TO` graph contract gets a `tenant_id` property.
- **Neo4j connection pool sizing** — perf agent noted it but the actual driver default + observed throughput under peak discovery scans wasn't measured.
- **Cloud-API rate-limit interactions** — scanner behavior under AWS / Azure / GCP throttling wasn't deeply explored. Real-data scenarios (10k VMs) aren't reproducible from static analysis.
- **K8s manifests** — only `k8s/base/*.yaml` was reviewed; per-environment overlays (`k8s/overlays/*` if any) weren't.

---

## Recommended sequencing

Given the multi-tenancy design work is queued next, here's the order I'd take the items in:

**Slice A (this is what slows down a real customer onboarding):**
- P0.1 + P0.2 (Neo4j hard-fail + readiness probe) — together, ~3h
- P0.6 (auth-disabled silent mode) — ~1h
- Tighten the ~6 admin-route tests (P1 testing block) — ~3h

**Slice B (multi-tenancy prep — these unblock the design):**
- P0.4 + P0.5 (scheduler concurrency + multi-pod safety) — these need to be solved before tenant-per-DB makes sense, since the schedulers will need to run per-tenant. ~half-day for the single-pod-correct version, document the multi-pod TODO.
- P1 ops items on logging structure (scheduler errors, audit-cleanup errors) — ~2h, makes incident triage tractable.

**Slice C (performance pass):**
- N+1 query fixes in `discovery.aws.js` / `discovery.azure.js` — ~half-day.
- Composite audit-log index — ~30 min.
- Pagination on `/infra`, `/audit`, `/graph/topology` — ~half-day.

**Slice D (test coverage sweep):**
- `admin-api-keys` tests, `iac-ingest` test, AI provider tests — ~half-day.
- Stub-vs-prod fixture pattern (P2 testing) — ~half-day.

**Deferred until customer-driven:**
- P0.7 (encryption rotation) — ~1 week, but no customer is asking yet.
- The S3 audit archive (mentioned in CLAUDE.md as future) — same.
- Stress / load testing harness (item 4 from earlier slice list, fuzz half is done) — ~half-day, but probably wait until perf fixes land first so the load test reveals new bottlenecks rather than known ones.

This sequencing assumes the per-tenant design work begins in parallel; if you'd rather block tenancy on the audit findings, slices A + B should land before any schema work.

---

*Generated 2026-04-27. Re-run the audit (rerun the same six agents) before the v1.0 cut to catch what's new since this snapshot.*
