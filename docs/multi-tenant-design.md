# Multi-tenant design

**Status:** Accepted — Option D (§3). Phase 0 shipped (`beb6f85`); 1a (`dc05015`); 1b (`997c62c`); 1c in progress (this commit).
**Branch:** `feature/multi-tenant-design` (forked from `release/0.1.0.0`).
**Author:** drafted with Claude.

---

## 1. Why this exists

AppCloud today is single-tenant by construction:

- One Neo4j graph holds infra/components/applications across **all** scanned cloud accounts.
- One Postgres holds API keys, cloud-account credentials, audit log, schedule, OTel staging — **none** of these tables carry a tenant column.
- A single API key with `read | write | admin` scope grants system-wide access.
- The scheduler fans out per cloud account into a shared graph.

The only tenant-shaped construct in the codebase is `otel_tenants` ([postgres-init/08-otel-staging.sql](postgres-init/08-otel-staging.sql)), which scopes raw OTel spans by ingestion bearer token per integration. It is OTel-internal isolation, not a customer boundary.

We need to decide *now* — before customer onboarding — what tenancy means in AppCloud, because the chosen isolation model dictates schema changes, query rewrites, scanner routing, and the API surface. Retrofitting it later is the kind of cross-cutting refactor the `propose-before-implementing` convention exists to avoid.

---

## 2. Goals and non-goals

### Goals

1. **One AppCloud deployment serves multiple customers** without cross-tenant data exposure on any read or write path.
2. **Per-tenant blast-radius queries** return only that tenant's graph.
3. **Per-tenant cloud-account credentials** stay isolated — a misrouted scanner cannot write Tenant A's resources into Tenant B's graph.
4. **Per-tenant audit trail** — actor, action, resource, and the resulting diff are attributable to a tenant.
5. **Tenant lifecycle is operationally tractable** — onboarding, deletion ("forget this customer"), per-tenant backup, and per-tenant pause must each be a documented, scriptable operation.
6. **Migration story for the current single-tenant deployment is non-disruptive** — existing data lands in a `default` tenant and continues to work without API breakage.

### Non-goals (explicit)

- **Hierarchical orgs / sub-tenants / projects-within-tenants.** Flat tenant model only. We can layer hierarchy later if customers ask; building it speculatively now is scope creep.
- **Per-tenant feature flags or per-tenant pricing plans.** Belongs in a billing/entitlements service, not in the graph layer.
- **Cross-tenant analytics for customers.** An admin operator can run cross-tenant queries (for ops); customers cannot.
- **Self-serve tenant signup.** Tenant creation is an admin operation in v1. SaaS signup flow is a separate design.
- **Replacing the existing API-key auth with SSO/OIDC.** Auth model stays multi-key RBAC; we only add a `tenant_id` binding.

---

## 3. The decision: isolation model

This is the choice that sets the cost shape of everything else. Three candidates:

### Option A — Pool model (shared stores, logical isolation)

**Postgres:** single database. Every tenant-bearing table gains a `tenant_id UUID NOT NULL` column. Enforce isolation with **PostgreSQL row-level security** (RLS) policies bound to a `current_setting('app.tenant_id')` GUC set per request, plus app-level guards as belt-and-braces.

**Neo4j:** single database, single graph. Every node gains a `tenant_id` property; every `MERGE` key includes it; every `MATCH` adds a `WHERE n.tenant_id = $tid` predicate. Composite indexes on `(:Infra {tenant_id, cloud_id})`, `(:Component {tenant_id, id})`, etc.

**Auth:** API keys carry `tenant_id` (FK to `tenants` table). The auth plugin resolves the key, sets `req.principal.tenantId`, and a downstream hook sets the Postgres GUC + injects the predicate into every Cypher run.

**Pros**
- Cheapest ops surface — one database to back up, one Neo4j to monitor.
- Cross-tenant admin queries are trivial (drop the predicate).
- Onboarding a new tenant is a single `INSERT` plus key issuance — sub-second.
- No license uplift for Neo4j (Community Edition supports this).

**Cons**
- **Any missed predicate is a data leak.** RLS catches Postgres mistakes, but Neo4j has no equivalent — every Cypher writer is a place a bug can leak. The current codebase has ~40+ Cypher sites; auditing all of them is real work and stays real work forever.
- Noisy-neighbor risk on Neo4j: a tenant with a 5M-node graph slows queries for everyone else.
- Per-tenant restore is hard (you can't `cypher-shell --restore tenant=X` — you'd have to delete + re-import a subgraph).
- "Forget this customer" is a Cypher delete that has to recurse correctly across all node labels and edges, and you'd better hope the predicate is right on the delete too.

### Option B — Silo model (database-per-tenant)

**Postgres:** a small **control-plane database** (`appcloud_control`) holds `tenants`, `api_keys`, and routing metadata. Each tenant gets its own **data-plane database** (`appcloud_t_<tenantid>`) holding their `cloud_accounts`, `audit_log`, `sync_jobs`, `discovery_schedule`, `otel_*`, etc. — created from a templated SQL bundle at onboarding.

**Neo4j:** one **database per tenant** using Neo4j's multi-database feature (`CREATE DATABASE tenant_<id>`), routed via a per-request `session({ database })` selector. *Requires Neo4j Enterprise Edition.*

**Auth:** API key resolves tenant → control-plane lookup → connection-pool selector picks the right Postgres DB and Neo4j database name.

**Pros**
- **Hard isolation.** A bug in a query handler can read the wrong row only if the connection routing is broken — and that's one place to audit, not 40+.
- Per-tenant backup, restore, and deletion become first-class operations (`pg_dump tenant_db`, `neo4j-admin database backup tenant_X`).
- Per-tenant performance tuning and scaling possible.
- Incident blast radius bounded — one tenant's slow scanner doesn't poison another tenant's graph.

**Cons**
- **Neo4j Enterprise license required** for multi-database. Community Edition tops out at one user database. This is a real cost and a procurement decision.
- Tenant onboarding is no longer instant — provisioning a Postgres DB + Neo4j DB + applying schema takes seconds-to-minutes.
- Cross-tenant admin queries (e.g., "how many tenants have GCP enabled?") require fan-out across N databases.
- Schema migrations have to run N times. We need a migration runner with per-tenant version tracking — currently we have no runner at all (memory: pre-customer state; migrations are manual). This forces us to build the runner.
- Connection-pool count grows linearly with tenant count; not a problem at 10 tenants, will be at 1000.

### Option C — Hybrid (pool Postgres, silo Neo4j) — **proposed default**

**Postgres:** shared, with `tenant_id` columns and RLS, exactly as Option A. The control-plane data (tenants, keys, audit, schedule, cloud_accounts, OTel staging) lives here.

**Neo4j:** **database-per-tenant** as Option B. The graph — which is the part where a leaked predicate would expose another customer's blast radius — gets hard isolation.

**Auth:** API key has `tenant_id`. Postgres GUC set per request as in Option A. Neo4j session opens against `tenant_<id>` database.

**Pros**
- Hard-isolates the highest-risk store (the graph), where most queries live and where a leak is most damaging.
- Keeps Postgres simple to operate — one DB, standard backups, trivial control-plane queries.
- Per-tenant graph backup/restore is a first-class operation; per-tenant Postgres rows are trivial to delete on tenant offboarding.
- Cross-tenant admin reporting on Postgres data (key inventory, schedule status) stays trivial.

**Cons**
- Still requires Neo4j Enterprise.
- Two operational models to maintain (Postgres-pool, Neo4j-silo) — operators have to learn both.
- Still need the migration runner for Neo4j (one tenant DB at a time), but Postgres migrations stay single-pass.
- The "graph queries must select database" rule lives in the Neo4j plugin — one place, but it's load-bearing.

### Option D — Schema-per-tenant Postgres + per-tenant Neo4j — **chosen**

**Postgres:** single database, single connection pool, but each tenant owns a **schema** (`tenant_<id>`) holding their data tables. A small set of cross-tenant tables (`tenants`, `api_keys`) lives in a `control` schema. Per-request, the auth/tenant preHandler issues `SET LOCAL search_path = tenant_<id>, public` on the connection's transaction; unqualified table references resolve to the tenant's schema. Cross-tenant admin queries qualify schemas explicitly.

**Neo4j:** database-per-tenant as Option B. Sessions opened via the plugin always pass `database: req.tenant.neo4jDatabase`; no caller picks the database name.

**Auth:** API key has `tenant_id` (FK to `control.tenants`). Super-admin scope sits above the existing ladder and is unbound to a tenant.

**Pros**
- **Stronger Postgres isolation than Option A or C without a per-DB ops surface.** A wrong `search_path` is a connection-level bug (one place), not a missed `WHERE` predicate restated per query (40+ places).
- Per-tenant restore in Postgres is now first-class: `pg_dump --schema=tenant_<id>`.
- Tenant onboarding remains cheap — `CREATE SCHEMA` + a templated DDL apply (~tens of ms), much faster than provisioning a new database.
- Cross-tenant admin queries are still trivial — qualify the schema explicitly, no fan-out across DBs.
- Standard Postgres backup/replication/HA all keep working unchanged.
- Pairs naturally with per-tenant Neo4j to give hard isolation in both stores.

**Cons**
- Schema count grows linearly with tenants. Postgres handles thousands of schemas fine, but `pg_dump` of the whole DB gets slower; per-schema dumps are the expected workflow.
- DDL changes apply per schema — forces a Postgres-side migration runner that iterates schemas. (Same problem Options B and C have for Neo4j; we'd be building the equivalent for Postgres anyway.)
- A bug that drops or truncates without qualifying the schema still hits the connection's current `search_path`. RLS would catch this; schemas don't. Mitigation: never run unqualified destructive DDL outside the migration runner.
- Still requires Neo4j Enterprise for the multi-DB side.

### Recommendation

**Option D.** The graph is where bugs hurt most: a missing `WHERE tenant_id` on a Cypher MATCH could surface another customer's infrastructure topology in a blast-radius reply, and ~40+ Cypher sites would each need to stay disciplined forever under Option A. Hard-isolating the graph at the database level removes that class of bug.

For Postgres, schema-per-tenant gives stronger isolation than RLS (one connection-level setting vs. predicates restated per query) without the operational cost of a database per tenant. It pairs naturally with per-tenant Neo4j and keeps the control plane simple.

The Neo4j Enterprise license is the cost we pay for graph isolation. Worth it before customers, expensive to retrofit after.

**Decision:** Option D accepted. The rest of this document is written against Option D; references to Option C in earlier drafts have been retained where the underlying mechanism (per-tenant Neo4j) is identical, since C and D differ only on the Postgres side.

---

## 4. Tenant identity

A **tenant** in AppCloud is the unit of customer isolation. It owns:

- A set of cloud accounts (Azure subscriptions, GCP projects, AWS accounts).
- A graph (one Neo4j database under Option C).
- A set of API keys, each with scopes that apply only within that tenant.
- Its own audit log entries, schedule, OTel staging, and integrations.

### Schema

New table in shared Postgres (under Option C, this is in the only Postgres):

```sql
-- postgres-init/13-tenants.sql
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,        -- short URL-safe identifier, e.g. 'acme-corp'
  display_name TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended', 'pending_delete')),
  neo4j_database TEXT NOT NULL UNIQUE,    -- e.g. 'tenant_<id-without-dashes>'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,                       -- principal name of admin who created
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX tenants_status_idx ON tenants(status) WHERE status != 'active';
```

A `default` tenant is seeded on first boot (idempotent `INSERT ... ON CONFLICT DO NOTHING`) for migration continuity (§9).

### Slug constraints

- `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` — URL-safe, kebab-case, 3–40 chars.
- Reserved slugs: `default`, `admin`, `system`, `api`, anything beginning with `_`.

### Neo4j database name

`tenant_` + tenant ID with dashes stripped. Lowercase, ≤63 chars. Neo4j requires database names match `^[a-z][a-z0-9._-]{2,62}$`.

---

## 5. Auth and request lifecycle

### API-key extension

Add `tenant_id UUID NOT NULL` (FK → `tenants(id)`) to `api_keys`. Bootstrap keys belong to the `default` tenant unless `APPCLOUD_BOOTSTRAP_TENANT_SLUG` overrides.

A new scope, `super-admin`, sits *above* the existing `admin > write > read` ladder and is **not bound to a tenant**. Super-admin keys can:
- Create/suspend/delete tenants.
- Issue/revoke API keys for any tenant.
- Run cross-tenant admin queries (used for ops dashboards and incident response).

Regular `admin` keys can do everything they do today, but only **within their tenant**. The scope hierarchy becomes `super-admin > admin > write > read`.

### Per-request flow

1. `authenticate` preHandler in [api/src/plugins/auth.js](api/src/plugins/auth.js) validates the key, looks up `principal = { id, name, scopes, prefix, tenantId }`.
2. New `tenantContext` preHandler:
   - Loads `control.tenants` row by `principal.tenantId`. Rejects if `status != 'active'` (returns 423 Locked for `suspended`, 410 Gone for `pending_delete`).
   - Sets `req.tenant = { id, slug, schemaName, neo4jDatabase }`.
   - Wraps Postgres access in a transaction that begins with `SET LOCAL search_path = "<schema_name>", public`. The transaction commits at request end (or rolls back on error). All unqualified table references in the request resolve to the tenant's schema.
3. Route handlers use `req.tenant.id` for control-plane writes (qualified with `control.` schema) and `req.tenant.neo4jDatabase` to open Cypher sessions.

### Cypher session selector

The Neo4j plugin currently exposes a `driver.session()` helper. Replace with `driver.session({ database: req.tenant.neo4jDatabase })` everywhere — *or* better, expose `req.neo4j(opts)` from the Neo4j plugin which closes over `req.tenant.neo4jDatabase`. This way no route handler ever picks the database name itself; the plugin enforces it.

The plugin's startup `CREATE INDEX IF NOT EXISTS` block runs once **per tenant database** (see §8 migrations) rather than against the system database.

### Super-admin override

Super-admin requests may pass `X-Tenant-Slug: <slug>` to act as that tenant. Super-admin requests *without* the header act against the system database (no graph operations permitted) and are restricted to control-plane endpoints (`/admin/tenants`, `/admin/keys`).

---

## 6. Postgres schema layout under Option D

### `control` schema (cross-tenant)

Holds the control-plane tables that the auth/tenant resolver reads *before* any tenant context is set. The auth plugin always qualifies these explicitly (`control.tenants`, `control.api_keys`).

- `control.tenants` — see §4.
- `control.api_keys` — same shape as today's `api_keys`, plus `tenant_id UUID NOT NULL REFERENCES control.tenants(id)`. Bootstrap keys bind to the `default` tenant.
- `control.schema_migrations` — per-schema migration tracking (filename, sha256, applied_at, schema_name). Replaces ad-hoc tracking.

### Per-tenant schemas (`tenant_<id>`)

Each tenant gets a schema with the existing data tables, copied 1:1 in shape (no `tenant_id` columns added — the schema *is* the isolation):

- `cloud_accounts`
- `integrations`
- `sync_jobs`
- `audit_log` (with its existing partition layout — partitioning is per-schema)
- `terraform_imports`
- `cmdb_assessment_*`
- `discovery_schedule`
- `ai_jobs`
- `otel_tenants`, `otel_spans_raw` (the existing `tenant_id` column inside `otel_tenants` is renamed to `bearer_id` to avoid shadowing the new tenancy concept)

Postgres extensions (`pgcrypto` etc.) stay in `public` and are referenced fully-qualified or via `search_path = tenant_<id>, public`.

### Bootstrap / migration

A new templated DDL bundle (`postgres-init/templates/tenant-schema.sql`) holds the per-tenant table definitions. Tenant creation runs:

1. `CREATE SCHEMA tenant_<id>`
2. Apply the template against that schema (`SET LOCAL search_path = tenant_<id>` then run the bundle).
3. Insert a row into `control.schema_migrations` for each migration applied.

Existing single-tenant deployments migrate by creating `tenant_<default-id>` and `ALTER TABLE ... SET SCHEMA tenant_<default-id>` for each existing data table — moves rows in place without copying. (See §9.)

---

## 7. Scanner and scheduler routing

### Scheduler change

[api/src/plugins/scheduler.js](api/src/plugins/scheduler.js) currently does:

```
loop tick:
  withLeaderLock:
    rows = SELECT * FROM cloud_accounts WHERE enabled
    for each row: dispatch scanner
```

Becomes:

```
loop tick:
  withLeaderLock:
    tenants = SELECT * FROM tenants WHERE status = 'active'
    for each tenant:
      set req.tenant + GUC
      rows = SELECT * FROM cloud_accounts WHERE enabled  -- RLS scopes
      for each row: dispatch scanner against this tenant's Neo4j DB
```

Leader lock stays global (one pod schedules all tenants per tick) until tenant count grows enough to need per-tenant locks. That threshold is empirical; revisit when a tick takes >5 min.

### Scanner change

Each `discovery.<cloud>.js` accepts a `neo4jDatabase` parameter (or receives a pre-bound session) instead of opening its own session against the default DB. Every `MERGE` is unchanged in shape — it just runs against the correct database.

`source` and `via` strings on `:CONNECTS_TO` edges stay identical. Tenancy is **not** an edge property; it's a database-level fact.

### Auto-link and bootstrap

[api/src/routes/discovery.autolink.js](api/src/routes/discovery.autolink.js) and [api/src/routes/discovery.bootstrap.js](api/src/routes/discovery.bootstrap.js) operate within a single tenant's database. No change to scoring tables, no change to rule logic, no cross-cloud invariant changes. Just the session selector.

---

## 8. Migrations

The Postgres-side change is a single migration file `13-tenants.sql` plus a `14-add-tenant-id.sql` that:

1. Creates `tenants` table.
2. Inserts a `default` tenant.
3. Adds nullable `tenant_id` to each table listed in §6.
4. Backfills `tenant_id` on existing rows to the `default` tenant ID.
5. Sets `tenant_id` to `NOT NULL`.
6. Adds RLS policies.
7. Updates UNIQUE constraints to include `tenant_id`.

The Neo4j-side change is *not* a migration in the existing sense — it's a runtime concern. On startup, the Neo4j plugin:

1. Lists active tenants from Postgres.
2. For each, runs `CREATE DATABASE tenant_<id> IF NOT EXISTS`.
3. Switches to that database and runs the `CREATE INDEX IF NOT EXISTS` block.
4. For the `default` tenant only, if the system database `neo4j` is non-empty, **moves** existing data into `tenant_<default-id>` via a one-shot `apoc.export` / `apoc.import` round-trip (or `neo4j-admin database copy` offline). This is the migration step for existing single-tenant deployments.

This is the right time to actually build the **migration runner** that's been deferred (memory `feedback_pre_customer_priorities.md`). Multi-tenant Neo4j needs schema applied per database, manually doesn't scale past 2–3 tenants. Scope: a numbered-file runner in `api/src/migrations/` that tracks applied migrations per Neo4j database in a Postgres `cypher_migrations` table keyed on `(neo4j_database, migration_file)`. Sketch:

```sql
CREATE TABLE cypher_migrations (
  neo4j_database TEXT NOT NULL,
  filename       TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (neo4j_database, filename)
);
```

Runner runs at startup after tenant database creation, applies any unapplied `.cypher` files in order against each tenant database. SHA pinning catches files that get edited after-the-fact.

---

## 9. Existing-deployment migration story

Single-tenant deployments today must continue working without operator intervention. Sequence:

1. Deploy new image with multi-tenant code.
2. Postgres migration runs, creates `default` tenant, backfills all rows.
3. Neo4j plugin on first boot detects existing data in the system database, creates `tenant_<default-id>`, copies data over, marks the default tenant as migrated. (One-shot, idempotent — if it crashes mid-copy, next boot resumes by checking node counts.)
4. Existing API keys are now bound to the `default` tenant. No external API change for existing clients.
5. Operator can then create additional tenants via `POST /admin/tenants` (super-admin scope).

The system database (`neo4j`) is **left in place but not written to** after migration. Operators can `DROP DATABASE neo4j` once they've verified the migration; doing so is not automatic.

---

## 10. API surface changes

### New routes (super-admin scope)

- `POST /admin/tenants` — create tenant, returns slug, ID, and a fresh admin API key.
- `GET /admin/tenants` — list tenants.
- `PATCH /admin/tenants/:id` — update display name, status (`active` / `suspended`).
- `DELETE /admin/tenants/:id` — soft-delete (sets `status = pending_delete`); a separate offline job performs the hard delete (drops the Neo4j database, deletes Postgres rows). Confirmation token required.
- `POST /admin/tenants/:id/keys` — issue API key for tenant.

### Existing routes

No URL change. All existing routes — `/applications`, `/infra`, `/components`, `/discovery/*`, `/scans/*` — continue to work. Tenant scoping is implicit via the API key and applied by the `tenantContext` preHandler. This is deliberate: avoids a breaking change for the `default` tenant migrating from single-tenant.

Super-admin requests targeting a specific tenant pass `X-Tenant-Slug: <slug>`. Documented as an admin-only header.

### OpenAPI / Postman

Both ([docs/openapi.yaml](docs/openapi.yaml), [docs/api-postman-collection.json](docs/api-postman-collection.json)) regenerate from the route definitions; the only visible delta is the new `/admin/tenants*` block and the `X-Tenant-Slug` header on super-admin operations.

---

## 11. Audit and observability

- `audit_log` rows include `tenant_id`. Existing queries against the audit table continue to work but are RLS-filtered.
- Structured log lines include `tenant_id` (or `tenant_slug`) on every request via a Fastify `requestContext` integration. Existing `evidence` strings on graph edges are unchanged.
- Metrics gain a `tenant` label on the high-cardinality counters (scanner runs, edges written, query duration). For `tenant_count > ~50`, switch to a top-N + "other" rollup to keep Prometheus cardinality bounded.
- Per-tenant rate limiting becomes possible (and probably necessary) — out of scope for v1, noted in §13.

---

## 12. Cross-cutting risks

| Risk | Mitigation |
|---|---|
| Cypher writer forgets to use `req.neo4j()` and writes to the system database. | Linter rule + unit test that scans `*.js` for `driver.session(` calls outside the plugin. CI fails the diff. |
| Neo4j Enterprise license cost. | Decision needed; budgeted before customer onboarding. |
| `search_path` not set on a request that sneaks past the preHandler (e.g., a websocket, a background job). | Postgres connections in the application pool default `search_path = control` so an unset request sees only control-plane tables — destructive queries fail loudly rather than hitting the wrong tenant. Background jobs explicitly call the tenant-context helper to set `search_path` before queries; websocket handlers run through the same preHandler chain — codified in CI. |
| `otel_tenants` rename collision with the new tenant model. | Rename existing column to `otel_bearer_id` in the same migration; mechanical, well-scoped. |
| Migration runner introduces drift if tenant DBs get out of sync (different migrations applied to different tenants). | `cypher_migrations` table is the source of truth. A `/admin/migrations` route shows per-tenant lag. |
| "Forgot to filter by tenant" in a one-off `cypher-shell` operator query. | Operators must select database explicitly with `:use tenant_<id>` — there is no default. The system database has no infra data after migration, so a forgotten selector returns empty rather than leaking. |

---

## 13. Out of scope (v1 deliberately defers)

- **Per-tenant rate limits.** Add when first customer needs it.
- **Per-tenant feature flags.** Belongs in entitlements.
- **Per-tenant pricing / metering.** Billing service.
- **Cross-tenant resource sharing** (e.g., a shared "vendor catalog" tenant that other tenants can read from). Defer until requested.
- **Tenant-scoped SSO / OIDC.** API keys remain the only auth in v1.
- **Per-tenant Neo4j performance tuning** (page cache sizes per database). Possible under Option C, but defer until measured need.
- **Hard-delete background worker.** v1 ships soft-delete; hard delete is a manual `DROP DATABASE` + `DELETE FROM ... WHERE tenant_id = ...` runbook. Build the worker when the runbook fires twice.

---

## 14. Open questions

1. **Confirm Option C vs. A vs. B.** Decision blocks the rest. (§3)
2. **Neo4j Enterprise procurement** — is the license budgeted? If no, we're forced into Option A. (§3)
3. **Tenant naming** — is `slug` the right user-facing identifier, or do customers expect `org_id` / `account_id` semantics? Affects the OpenAPI surface and any future console.
4. **Super-admin auth** — should super-admin keys live in a separate table (`admin_keys`) rather than a special row in `api_keys`? Slight blast-radius win if compromised admin keys can't be confused with tenant keys.
5. **Neo4j system-database cleanup** — automate the `DROP DATABASE neo4j` post-migration, or leave it manual? Manual is safer; automated is cleaner.
6. **OTel re-keying** — the `otel_spans_raw.tenant_id` partition column shadows the new tenant concept. Migration is mechanical but partition swap is a bit invasive. Confirm we accept the brief downtime on OTel ingestion during the migration. (§6)
7. **Migration runner scope** — minimum viable runner for v1, or invest in proper version-graph + dry-run tooling now? Memory says defer tooling pre-customer; multi-tenant arguably forces our hand. (§8)

---

## 15. Implementation phasing (sketch — only after §3 is decided)

Once Option C (or alternative) is confirmed, suggested phasing:

1. **Phase 0 — control plane.** `control` schema, `control.tenants`, `control.api_keys` with `tenant_id`, `tenantContext` preHandler (sets `search_path` per request), super-admin scope, `/admin/tenants*` routes. Existing tables stay in `public` for now; default tenant seeded; auth binds existing keys to default. No data movement yet. **— Shipped.**
2. **Phase 1 — Postgres schema-per-tenant cutover.** Sub-phased to keep individual changes reviewable:
   - **1a — schema provisioning.** Per-schema migration runner (`api/src/utils/tenant-schema-runner.js`), `control.schema_migrations` tracking table, tenant-schema migration template starting with a minimal `001-base-tables.sql` (integrations + cloud_accounts), provisioning hook in POST `/admin/tenants` that runs CREATE SCHEMA + applyMigrations inside the same transaction as the row insert (atomic on rollback). `tenantContext` 503s any request bound to a tenant whose `schema_name` is not `public` so the failure mode is visible until 1b lands. **— Shipped.**
   - **1b — per-request search_path + default-tenant cutover.** Add `fastify.pg.forTenant(schemaName)` and `fastify.pg.transaction(fn)` helpers — connection-bound, search_path-set, BEGIN/COMMIT-managed. `tenantContext` attaches `req.pg = fastify.pg.forTenant(req.tenant.schemaName)` per request. Move `integrations` + `cloud_accounts` from `public` into `tenant_default` via `ALTER TABLE … SET SCHEMA`; update the default tenant's `schema_name` to `tenant_default`. Refactor route handlers + plugins that touch those tables to use `req.pg` (or `fastify.pg.forTenant(...)` from out-of-request contexts like the scheduler). The 1a 503 guard tightens to fire only for non-`tenant_default` schemas — the default tenant now legitimately routes through the per-request `search_path` path; non-default tenants stay 503 until 1c finishes the table set. Friction-2 fix: postgres-init/01-schema.sql + 04-cloud-accounts.sql get explicit "DDL also in api/src/migrations/tenant-schema/001-base-tables.sql; moved to tenant_default by 15-default-tenant-cutover.sql" pointers so the duplication is visible until 1c retires the public-side creates entirely.
   - **1c — `integrations` + `sync_jobs` cutover, helper extraction, startup sweep.** Extracted `forTenant`/`transaction` from inline plugin code into `utils/pg-helpers.js` (closes 1b friction-1). Shared `requireTenantPg` lives in `utils/route-helpers.js` (closes 1b friction-3). New `002-sync-jobs.sql` template (sync_jobs with FK to integrations), paired cutover for `integrations` + `sync_jobs` together (`postgres-init/16-integrations-cutover.sql` + idempotent startup mirror). Refactored `integrations.management.js` (16 sites) and `integrations-cloud.js` to use `req.pg` + the shared helper. Added a startup re-migration sweep in `tenant-context` that iterates active tenants and applies any unapplied template migrations — lets existing tenant schemas pick up new template files (`003-…`) automatically. **— Shipped.**
   - **1d — remaining tables + lift the 503 guard.** Move `audit_log` (decide: per-tenant vs. control with tenant_id), `terraform_imports`, `cmdb_assessment_*`, `discovery_schedule`, `ai_jobs`, `otel_*`. Refactor the `audit()` machinery to be tenant-aware. Once every tenant-scoped table is in the per-tenant schema (or cross-tenant by design), lift the 503 guard so non-default tenants become viable.
3. **Phase 2 — Neo4j per-tenant DBs.** Per-tenant `CREATE DATABASE`, plugin-enforced `req.neo4j()`, one-shot data move for the default tenant. Linter rule + CI gate that no `driver.session(` lives outside the plugin.
4. **Phase 3 — Scanner / scheduler routing.** Scheduler iterates tenants; each scanner accepts a session selector. Audit-log + metric labels gain `tenant_id`.
5. **Phase 4 — Tenant lifecycle ops.** Suspend/delete flows, hard-delete runbook, per-tenant migration status endpoint.
6. **Phase 5 — Documentation and the cutover.** Update `CLAUDE.md`, `docs/api-guide.md`, OpenAPI; cut `release/0.2.0.0` with multi-tenant as the headline change.

Each phase is independently shippable and revertable.
