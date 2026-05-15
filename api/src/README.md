# AppCloud API

Headless Fastify service that answers blast-radius and CMDB-quality
questions against a Neo4j + Postgres backing store. Cloud inventory is
ingested via AWS / Azure / GCP scanners and IaC connectors; ServiceNow
CMDB and OTel traces layer in dependency and runtime signals on top.

## Setup

```bash
npm install
npm run dev            # development with auto-reload
npm start              # production
```

The API reads Neo4j + Postgres credentials from `*_FILE` env vars by
default (see `docker-compose.yml`), falling back to plain env vars for
local development.

## Authentication

Headless API-key gate. Callers send the key in a request header:

```
X-API-Key: <appcloud_api_key>
```

The key is read from `APPCLOUD_API_KEY_FILE` (e.g. `/run/secrets/appcloud_api_key`)
or `APPCLOUD_API_KEY`. When neither is set, auth is disabled and all
routes are open — matching the plugin's graceful-degradation model.

## Environment Variables

The full list of environment variables read by the API. Defaults are
the values used when the variable is unset; `—` means there is no
default and the feature stays off until the variable is supplied.

### Connections

| Variable | Default | Description |
|---|---|---|
| `APPCLOUD_NEO4J_URI` / `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI. Use `bolt+s://` for TLS, `bolt+ssc://` for self-signed certs. |
| `NEO4J_USER` / `DB_USERNAME_FILE` | `neo4j` | Neo4j username (filename overrides direct env). |
| `NEO4J_PASSWORD` / `DB_PASSWORD_FILE` | — | Neo4j password. |
| `POSTGRES_HOST` | `localhost` | Postgres host. Empty disables Postgres entirely. |
| `POSTGRES_PORT` | `5432` | Postgres port. |
| `POSTGRES_DB` | `appcloud` | Postgres database name. |
| `POSTGRES_USER` / `PG_USERNAME_FILE` | `postgres` | Postgres user. |
| `POSTGRES_PASSWORD` / `PG_PASSWORD_FILE` | — | Postgres password. |
| `APPCLOUD_PG_POOL_MAX` | `10` | Postgres pool max connections. Bump under bursty audit + query load. |
| `APPCLOUD_POSTGRES_SSL` | `false` | Set to `true` to enable TLS to Postgres. |
| `PG_CA_FILE` | — | PEM bundle for verified-CA Postgres TLS. |
| `APPCLOUD_REQUIRE_TLS` | `false` | Set to `true` to refuse to start without TLS to both DBs. |
| `PORT` | `3000` | Server port. |
| `HOST` | `0.0.0.0` | Bind host. |

### Auth + secrets

| Variable | Default | Description |
|---|---|---|
| `APPCLOUD_API_KEY_FILE` / `APPCLOUD_API_KEY` | — | Bootstrap write-scope API key. |
| `APPCLOUD_ADMIN_API_KEY_FILE` / `APPCLOUD_ADMIN_API_KEY` | — | Bootstrap admin-scope API key. |
| `APPCLOUD_ALLOW_OPEN_AUTH` | `false` | In `NODE_ENV=production`, this MUST be `true` for the API to start without bootstrap keys (open-auth fallback). |
| `APPCLOUD_AUTH_CACHE_TTL_MS` | `60000` | API-key cache TTL — how often the auth plugin re-reads the api_keys table. |
| `APPCLOUD_AUTH_WARN_WINDOW_MS` | `60000` | Per-`(principal, X-Actor)` rate-limit window for the X-Actor warning. |
| `APPCLOUD_AUTH_DISABLED_WARN_MS` | `60000` | When auth is disabled, re-emit the warning every N ms. `0` to disable. |
| `APPCLOUD_ENCRYPTION_KEY_FILE` / `APPCLOUD_ENCRYPTION_KEY` | — | AES-256-GCM master for connector secrets at rest. Required at startup. |
| `APPCLOUD_KDF_SALT` | (built-in) | Override for the master-key scrypt salt. Don't change without re-keying every encrypted row. |

### Rate limit

| Variable | Default | Description |
|---|---|---|
| `APPCLOUD_RATE_LIMIT_MAX` | `300` | Per-key request budget per `APPCLOUD_RATE_LIMIT_WINDOW` for authenticated requests. |
| `APPCLOUD_RATE_LIMIT_UNAUTH_MAX` | `60` | Per-IP request budget for unauthenticated requests. Tighter to blunt key-rotation bypass attacks. |
| `APPCLOUD_RATE_LIMIT_WINDOW` | `1 minute` | The window passed to `@fastify/rate-limit`. |
| `APPCLOUD_ALLOWED_ORIGINS` | localhost dev set | Comma-separated CORS allowlist. |

### Audit log

| Variable | Default | Description |
|---|---|---|
| `APPCLOUD_AUDIT_RETENTION_DAYS` | `365` | Drop audit partitions older than N days. `0` disables retention entirely. |
| `APPCLOUD_AUDIT_CLEANUP_INTERVAL_MS` | `86400000` | Cleanup tick interval (default 24h). |
| `APPCLOUD_AUDIT_CLEANUP_BATCH_SIZE` | `10000` | Pre-partitioning fallback DELETE batch size. |
| `APPCLOUD_AUDIT_BUFFER_MAX` | `1000` | Retry-buffer capacity; overflow evicts oldest + bumps the dropped counter. |
| `APPCLOUD_AUDIT_BUFFER_DRAIN_MS` | `30000` | Periodic drain interval for the buffer. |

### Discovery + OTel + AI

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local LLM endpoint. K8s service name `ollama` is rewritten to localhost outside the cluster. |
| `OLLAMA_MODEL` | `llama3` | Default Ollama model. |
| `APPCLOUD_OLLAMA_CHECK_TTL_MS` | `30000` | How long the API caches a positive Ollama-availability check before re-probing. |
| `AI_CLOUD_PROVIDER` | — | One of `anthropic` / `openai` / `azure` / `gemini`. Empty disables cloud AI. |
| `AI_CLOUD_MODEL` | provider default | Override the default model for the chosen provider. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AZURE_OPENAI_API_KEY` / `GEMINI_API_KEY` | — | API key for the matching provider. |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` | — | Required when `AI_CLOUD_PROVIDER=azure`. |
| `OTEL_AGG_INTERVAL_MS` | `60000` | OTel aggregator tick interval. |
| `CMDB_ASSESSMENT_INTERVAL_MS` | `60000` | CMDB assessment scheduler tick. |
| `CMDB_ASSESSMENT_BACKSTOP_MS` | `1800000` | Backstop interval — run even when not dirty. |

### Observability + dev

| Variable | Default | Description |
|---|---|---|
| `APPCLOUD_READY_TIMEOUT_MS` | `2000` | Per-DB probe timeout for `GET /ready`. |
| `APPCLOUD_DEBUG` | `false` | Required in production for `/discovery/debug/:id` to be reachable. |
| `NODE_ENV` | `development` | Use `production` to gate the auth-disabled refuse-to-start behaviour. |

---

## API versioning

The OpenAPI spec carries a SemVer version at `info.version` (currently `1.1.0`).
Until v1.0 is cut, the contract is:

- **Patch bumps** (`1.1.0` → `1.1.1`) for additive non-breaking changes:
  new optional fields on responses, new optional query parameters, new
  routes, error-message wording. Old clients keep working.
- **Minor bumps** (`1.1.0` → `1.2.0`) for additive surface that crosses
  a meaningful capability boundary (a whole new resource family, a new
  required header on a future request, expanded scope semantics).
- **Major bumps** (`1.x` → `2.0.0`) for breaking changes: removing /
  renaming a route, changing a response shape's existing fields, dropping
  a query parameter, tightening a previously-loose schema in a way that
  rejects payloads that used to validate. Reserved until v1.0 is cut and
  the contract has external consumers; pre-v1.0 we may still iterate
  shape without the bump.

Deprecation: when a route is on the way out, it ships with the
existing path + a `Deprecation: true` and `Sunset: <RFC 7231 date>`
response header for at least one minor cycle before the removal. The
sunset path is `<minor cycle> + 90 days` minimum.

The OpenAPI drift test in `__tests__/openapi-drift.test.js` blocks
silent contract drift — `docs/openapi.json` must match what the live
route registrations would produce. CI fails the PR otherwise.

---

## API Reference

### Applications — `/applications`

| Method | Path | Description |
|---|---|---|
| GET | `/applications` | List all applications |
| GET | `/applications/:id` | Get application with components + infra |
| POST | `/applications` | Create application |
| PATCH | `/applications/:id` | Update application |
| DELETE | `/applications/:id` | Delete application |
| GET | `/applications/:id/topology` | Full topology with connections |
| GET | `/applications/:id/dependencies` | Cross-app dependencies |

**POST /applications body:**
```json
{
  "name": "Payment Service",
  "tier": 1,
  "owner": "platform-team",
  "environment": "production"
}
```

---

### Components — `/components`

| Method | Path | Description |
|---|---|---|
| GET | `/components?type=API` | List components (optional type filter) |
| GET | `/components/:id` | Get component with inbound/outbound connections |
| POST | `/components` | Create component |
| PATCH | `/components/:id` | Update component |
| DELETE | `/components/:id` | Delete component |
| POST | `/components/:id/connections` | Add `:CONNECTS_TO` edge |
| DELETE | `/components/:id/connections/:targetId` | Remove connection |
| POST | `/components/:id/deploy` | Link component to `:Infra` |

---

### Infra — `/infra`

| Method | Path | Description |
|---|---|---|
| GET | `/infra?provider=aws&public=true` | List infra (filterable) |
| GET | `/infra/:id` | Get infra with deployments + network connections |
| POST | `/infra` | Create infra resource |
| PATCH | `/infra/:id` | Update infra resource |
| DELETE | `/infra/:id` | Delete infra resource |
| GET | `/infra/shared/resources` | Infra used by multiple apps |
| GET | `/infra/public/exposed` | All public-facing infra |

---

### Graph — `/graph`

| Method | Path | Description |
|---|---|---|
| GET | `/graph/summary` | Node counts and high-level stats |
| GET | `/graph/topology` | Application / component / infra topology with connections |
| GET | `/graph/impact?id=id` | What breaks if this Application, Component, or Infra changes — depth-aware inbound tree |
| GET | `/graph/dependencies?id=id` | Inverse — what an Application or Component leans on (outbound) |
| GET | `/graph/snapshots` | List snapshots |
| POST | `/graph/snapshots` | Create a new snapshot |

---

### Discovery — `/discovery`

Cloud scanning + schema metadata.

| Method | Path | Description |
|---|---|---|
| POST | `/discovery/scan/aws` | Scan all configured AWS accounts |
| POST | `/discovery/scan/azure` | Scan all configured Azure subscriptions |
| POST | `/discovery/scan/gcp` | Scan all configured GCP projects |
| POST | `/discovery/scan/all` | Scan every configured cloud account and auto-bootstrap |
| POST | `/discovery/bootstrap` | Run app/component bootstrap (RG propagation) without scanning |
| POST | `/discovery/link` | Link an `:Infra` to a `:Component` via `:CONNECTS_TO {via:'component-mapping'}` |
| GET | `/discovery/providers` | Providers + per-provider supported resource types |
| GET | `/discovery/schedule` | Current scheduler state |

After any successful scan the API flags the CMDB assessment scheduler
as dirty so the next tick re-runs relevance + quality scoring.

---

### Integrations — `/integrations`

Generic CRUD for connector configurations. Each connector type declares
its own JSON Schema (see `GET /connectors`). Secret fields are AES-encrypted
at rest using `APPCLOUD_ENCRYPTION_KEY`.

| Method | Path | Description |
|---|---|---|
| GET | `/integrations` | List all configured integrations |
| GET | `/integrations/:id` | Get one integration (secrets redacted) |
| POST | `/integrations` | Create an integration from a connector spec |
| PATCH | `/integrations/:id` | Update config (partial merge) |
| DELETE | `/integrations/:id` | Remove integration |
| POST | `/integrations/:id/sync` | Fire a connector run immediately |
| POST | `/integrations/:id/health` | Run the connector's health probe |
| GET | `/integrations/cloud/accounts` | Cloud-account-specific list view |
| POST | `/integrations/terraform/upload` | Upload Terraform state for one-shot ingest |

---

### Connectors — `/connectors`

Read-only registry view of available connector specs (the definitions,
not the configured instances). Used when building a dynamic UI.

| Method | Path | Description |
|---|---|---|
| GET | `/connectors` | List every registered connector spec |
| GET | `/connectors/:id` | One spec with UI metadata + auth schema |

Currently registered: `aws`, `azure`, `gcp`, `iac-state-backend`,
`terraform-cloud`, `otel-ingest` (push), `servicenow` (CMDB pull).

---

### CMDB assessment — `/cmdb`

Relevance + data-quality scoring of ServiceNow CIs against live cloud
inventory. See `services/cmdb-assessment/` for the algorithm (three-stage
match ladder: exact keys → exact normalised name → MinHash/LSH/Jaccard
gated by Shannon entropy ≥ 1.5).

| Method | Path | Description |
|---|---|---|
| GET | `/cmdb/assessment` | Paginated list with filters (`minRelevance`, `minQuality`, `sys_class_name`, `matched=true/false`, free-text `q`) |
| GET | `/cmdb/assessment/state` | Scheduler state (dirty flag, last run, interval config) |
| GET | `/cmdb/assessment/runs` | Recent run history from `cmdb_assessment_runs` |
| GET | `/cmdb/assessment/:sys_id` | One CI with matched `:Infra` list, evidence, parsed reasons |
| POST | `/cmdb/assessment/refresh` | Fire-and-forget manual run (returns 202) |

`:REPRESENTS` edges carry bi-temporal `createdAt` / `validAt` /
`lastSeenAt` / `expiredAt` fields per the graphiti pattern. Pruning is
soft — stale edges get `expiredAt` set, not deleted.

---

### AI — `/ai`

Optional enrichment endpoints that call out to Ollama (local) or a
configured cloud provider. Gracefully return 503 when no provider is
configured.

| Method | Path | Description |
|---|---|---|
| GET | `/ai/status` | Which providers are reachable |
| POST | `/ai/suggest/explain` | Plain-English mapping-suggestion explanation |
| POST | `/ai/suggest/score` | LLM-backed ranking of candidate apps for an `:Infra` |
| GET | `/ai/infra/:id/impact` | Narrative blast radius for one `:Infra` |
| GET | `/ai/architecture/plan` | Architectural improvement recommendations |
| POST | `/ai/drift/remediation-plan` | Cloud-backed drift remediation plan |
| GET | `/ai/dependencies/analysis` | Single-point-of-failure and cascade analysis |
| POST | `/ai/chat` | Enriched chat with a live context snapshot |

---

### Audit — `/audit`

Append-only audit trail of write events across the API (Postgres
`audit_log` table).

| Method | Path | Description |
|---|---|---|
| GET | `/audit?resourceType=Infra&action=create` | Paginated filter search |
| GET | `/audit/stats` | 30-day aggregates |
| GET | `/audit/resource/:type/:id` | Per-resource history |

Actor defaults to `system`; callers may supply `X-Actor: <operator>` to
record operator identity on audited writes.

---

## Graph conventions

See `CLAUDE.md` at the repo root for the full set of rules that apply to
every write to the graph. The load-bearing ones:

- Every scanner / supplement / autolink write uses `MERGE`, never `CREATE`.
  Scanners re-run on a schedule and the graph must converge, not accumulate
  duplicates. (User-driven `POST` endpoints with server-generated UUIDs
  use `CREATE` because each call is a fresh entity by definition.)
- Edges carry traceability properties: `source`, `via`, `confidence`,
  `discovered_at`, `last_seen`, `evidence`. The static-analysis test in
  `__tests__/connects-to-invariant.test.js` enforces this contract
  across every Cypher writer at PR time.
- **One** edge label: `:CONNECTS_TO`. The legacy `:DEPLOYED_ON` and
  `:CONNECTED_TO` labels were consolidated; everything between any pair
  of nodes (Infra↔Infra, Component↔Infra, Component↔Component, etc.)
  uses `:CONNECTS_TO` with provenance carried in `source` and `via`
  properties. See CLAUDE.md "Graph conventions" for the full vocabulary.
- Azure resources are identified by full ARM resource id, parsed once at
  ingestion into first-class properties.
