# TODO — Phase 1c: complete the per-tenant Postgres schema template

**Status**: deferred to a separate branch (the agents/LLM branch is the wrong place for this).

**Owns**: lifting the 503 gate at `api/src/plugins/tenant-context.js:429` so non-default tenants can accept data writes.

---

## Why this exists

Multi-tenant rollout was staged:

| Phase | Scope | Status |
|---|---|---|
| 1a | Control schema (`control.tenants`, `control.api_keys`, `control.schema_migrations`); `/admin/tenants` CRUD; super-admin scope | ✅ landed |
| 1b | `tenant-context` plugin; per-request `X-Tenant-Slug` resolves to a `SET LOCAL search_path` per query; minimal per-tenant template (`integrations`, `cloud_accounts`) | ✅ landed |
| **1c** | **Expand the per-tenant template to cover every data table currently in `public`. Lift the 503 gate.** | **⛔ this branch** |
| 1d | `req.audit` curried with `tenant_id`; `actor_key` cross-tenant FK | ✅ landed |

Phase 1c is the one piece that makes the rest of the multi-tenant story actually usable. Without it, every non-default tenant has a provisioned schema that's almost empty — writes against routes like `POST /infra`, `POST /applications`, `POST /components` would either fail with "relation does not exist" or, worse, fall through `search_path` to `public` and silently land in the **wrong** tenant's data. So `tenant-context.js` 503s every non-default-tenant data write rather than risk the leak. Quote the gate's comment:

> Phase 1b guard: data routes route through the per-request search_path mechanism for the default tenant only. Non-default tenants have provisioned schemas with the *minimal* template (integrations + cloud_accounts) but lack the rest of the per-tenant table set; queries against missing tables would either fail or — worse — fall through search_path to `public` and read another tenant's data. Phase 1c expands the template to cover all tables and lifts this guard.

---

## What "complete the template" means

The per-tenant template lives at `api/src/migrations/tenant-schema/`. Today it has:

- `001-base-tables.sql` — bare minimum (integrations, cloud_accounts)
- `002-sync-jobs.sql` — sync-job state for scheduler

What it should also have, per a scan of `postgres-init/01-schema.sql` and the rest of `postgres-init/`:

| Table | Source script | Notes |
|---|---|---|
| `audit_log` | `01-schema.sql` + `11-audit-evolution.sql` + `12-audit-partitioning.sql` + `17-audit-tenant-id.sql` | partitioned by month — the partition DDL needs to be tenant-scoped too |
| `discovery_schedule` | `05-discovery-schedule.sql` | per-tenant scanner cron |
| `ai_jobs` | `06-ai-jobs.sql` | AI assistant chat audit trail |
| `cmdb_assessment*` | `09-cmdb-assessment.sql` | a few tables |
| (anything else 18-tables-cutover.sql moved out of `public` in the cutover) | | check the cutover script |

The pattern from `001-base-tables.sql` is the right one to copy: every table is created in the *current* schema (no `public.` prefix), so the same SQL applies cleanly when run with `SET search_path = tenant_<id>, public`.

---

## What lifting the gate looks like

Once the template covers all tables:

1. Drop the `tenant.schemaName !== 'tenant_default'` branch at `tenant-context.js:429`.
2. Update the test at `api/src/plugins/__tests__/tenant-context.test.js:38` ("503 guard for tenants whose schema differs from `tenant_default`") — flip its assertion: non-default tenants should get a 200 / 201 from a data route now.
3. `agents/seed.js` line ~32: switch `TENANT_SLUG` back from `'default'` to `'default-test'`. The comment + the supporting plumbing (reserved-slug list, `?allowReserved=true`, auto-create flow) are already shipped on the agents/LLM branch waiting for this moment — that's a one-line change.
4. Add a tenant-isolation invariant test: spin up two tenants, write `Infra` to each, confirm `req.pg` for tenant A never sees tenant B's rows.

---

## Migration story for existing default-tenant data

`postgres-init/15-default-tenant-cutover.sql` and `18-tables-cutover.sql` already moved tables from `public` into `tenant_default` for the seeded tenant. Phase 1c needs to ensure those same tables are *also* in the template that gets applied to new tenants. No data migration needed — every new tenant starts empty.

---

## Branch hygiene this depends on (already landed in `feature/AI-agents-and-LLM`)

The agents/LLM branch shipped the surrounding plumbing to make the smoke flow run on minikube — these are unrelated to Phase 1c itself, but are Phase-1c-adjacent and should be reviewed as part of the same workflow:

- `APPCLOUD_ALLOWED_ORIGINS` set in the minikube overlay (otherwise the API refuses to start in `NODE_ENV=production`)
- `APPCLOUD_SUPER_ADMIN_API_KEY` wired into `k8s/base/api-deployment.yaml` (operator must create the secret one-off — see deployment YAML comment)
- `k8s/base/postgres-init/` refreshed from the canonical top-level `postgres-init/` (was 5 stale March files; now mirrors the 17-script set)
- `k8s/base/kustomization.yaml` configMapGenerator updated to include all 17 init scripts — required for fresh-cluster boots to bring up the control schema correctly

---

## Definition of done

- `node agents/seed.js` writes to `default-test` (not `default`) and every POST returns 2xx.
- The cross-tenant invariant test passes.
- `tenant-context.js:429` no longer carries a 503 branch.
- The Phase 1b guard comment in `tenant-context.js` is updated to past tense.
