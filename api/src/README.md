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

| Variable | Default | Description |
|---|---|---|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j Bolt URI |
| `POSTGRES_HOST` | `localhost` | Postgres host |
| `POSTGRES_DB` | `appcloud` | Postgres database |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind host |
| `APPCLOUD_API_KEY_FILE` / `APPCLOUD_API_KEY` | — | Shared key for `X-API-Key` auth |
| `APPCLOUD_ENCRYPTION_KEY_FILE` / `APPCLOUD_ENCRYPTION_KEY` | — | AES-256-GCM key for stored connector secrets |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Optional local LLM endpoint |
| `OTEL_AGG_INTERVAL_MS` | `60000` | OTel aggregator tick |
| `CMDB_ASSESSMENT_INTERVAL_MS` | `60000` | CMDB assessment scheduler tick |
| `CMDB_ASSESSMENT_BACKSTOP_MS` | `1800000` | Max time between runs even if not dirty |

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
| GET | `/graph/impact?infraId=id` | What breaks if this infra goes down |
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
| POST | `/discovery/link` | Link an `:Infra` to a `:Component` via `:DEPLOYED_ON` |
| GET | `/discovery/accounts` | Configured cloud accounts (from Postgres) |
| GET | `/discovery/metadata/providers` | Providers + per-provider supported resource types |
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

- Every write uses `MERGE`, never `CREATE`. Scanners re-run on a schedule
  and the graph must converge, not accumulate duplicates.
- Edges carry traceability properties: `source`, `confidence`, `createdAt`,
  `lastSeenAt`, `evidence`.
- Two primary edge types: `:CONNECTS_TO` (inferred) and `:DEPLOYED_ON`
  (structural hosting).
- Azure resources are identified by full ARM resource id, parsed once at
  ingestion into first-class properties.
