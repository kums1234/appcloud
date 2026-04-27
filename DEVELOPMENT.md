# AppCloud Development Workflow

This guide covers the development workflow for quick iteration, unit testing, and reduced container refresh for the AppCloud API.

## Quick Start

```bash
# Start development environment
./dev.sh up

# Run unit tests
./dev.sh test

# Open shell in container
./dev.sh shell

# View logs
./dev.sh logs
```

## Development Features

### 🚀 Quick Iteration
- **Volume Mounting**: Code changes are reflected immediately without container rebuilds
- **Hot Reloading**: Node.js `--watch` mode automatically restarts the server on changes
- **Development Dockerfile**: Includes dev dependencies for testing and debugging

### 🧪 Unit Testing
- **Jest Framework**: Fast unit tests with mocking
- **Isolated Tests**: No database dependencies required
- **Watch Mode**: Automatic test re-running on file changes
- **Coverage Reports**: Test coverage analysis

### 🐳 Container Optimization
- **Development Override**: `docker-compose.dev.yml` with volume mounts
- **Selective Rebuilding**: Only rebuild when dependencies change
- **Named Volumes**: Avoid host `node_modules` conflicts

## Development Commands

| Command | Description |
|---------|-------------|
| `./dev.sh up` | Start development environment |
| `./dev.sh down` | Stop development environment |
| `./dev.sh restart` | Restart API service |
| `./dev.sh logs` | View API logs |
| `./dev.sh shell` | Open shell in API container |
| `./dev.sh test` | Run unit tests |
| `./dev.sh test:watch` | Run tests in watch mode |
| `./dev.sh test:coverage` | Run tests with coverage |
| `./dev.sh clean` | Clean up containers and volumes |

## Project Structure

```
api/
├── src/                    # Source code (volume mounted)
├── __tests__/             # Unit tests (volume mounted)
├── package.json          # Dependencies and scripts
├── Dockerfile            # Production build
└── Dockerfile.dev        # Development build

docker-compose.yml        # Base services
docker-compose.dev.yml    # Development overrides
dev.sh                   # Development workflow script
```

## Unit Testing

### Writing Tests

Tests are located in `api/__tests__/` and use the `.test.js` extension.

```javascript
// __tests__/example.test.js
import { someFunction } from '../src/utils/example.js'

describe('someFunction', () => {
  test('does something', () => {
    expect(someFunction('input')).toBe('expected')
  })
})
```

### Running Tests

```bash
# Run all tests
./dev.sh test

# Run tests in watch mode
./dev.sh test:watch

# Run with coverage
./dev.sh test:coverage
```

### Test Configuration

- **Timeout**: 10 seconds per test
- **Environment**: Isolated mocks for Neo4j and PostgreSQL
- **Coverage**: Excludes `server.js` (entry point)

## Development Environment

### Services

- **API**: Fastify server with hot reloading
- **Neo4j**: Graph database for infrastructure data
- **PostgreSQL**: Relational database for audit logs
- **Ollama**: Local LLM for AI features

### Environment Variables

Development overrides:
- `NODE_ENV=development`
- `APPCLOUD_API_KEY=dev-api-key-for-local-development`
- `APPCLOUD_ENCRYPTION_KEY=dev-encryption-key-for-local-development`
- Database names suffixed with `_dev`

### Volume Mounting

Source code is volume mounted for instant updates:
- `api/src/` → `/app/src/`
- `api/__tests__/` → `/app/__tests__/`
- `api/package.json` → `/app/package.json`

## Workflow Examples

### Feature Development

```bash
# 1. Start environment
./dev.sh up

# 2. Run tests to ensure baseline
./dev.sh test

# 3. Make code changes (auto-reloaded)
# Edit files in api/src/

# 4. Run tests frequently
./dev.sh test:watch

# 5. Check coverage
./dev.sh test:coverage
```

### Debugging

```bash
# Open container shell
./dev.sh shell

# Install additional debugging tools
npm install -D node-inspect

# Run with debugger
npm run dev -- --inspect=0.0.0.0:9229
```

### Database Access

```bash
# Access Neo4j browser
open http://localhost:7474

# Access PostgreSQL
./dev.sh shell
psql -h postgres -U appcloud_dev
```

## Troubleshooting

### Container Issues

```bash
# Check container status
docker-compose -f docker-compose.yml -f docker-compose.dev.yml ps

# View detailed logs
./dev.sh logs

# Restart services
./dev.sh restart
```

### Test Issues

```bash
# Clear Jest cache
./dev.sh shell
npx jest --clearCache

# Run specific test
./dev.sh shell
npx jest __tests__/specific.test.js
```

### Permission Issues

```bash
# Fix file permissions
sudo chown -R $USER:$USER api/
```

### Stray `api/src/node_modules/` shadowing dependencies

If a Fastify (or any other) version warning surfaces during test runs
that doesn't match the version in `api/package.json` — e.g. tests
fail with `expected '5.x' fastify version, '4.29.1' is installed`
even though `npm ls fastify` reports the upgraded version — check
for an unintended `api/src/node_modules/` directory and delete it:

```bash
ls api/src/node_modules >/dev/null 2>&1 && rm -rf api/src/node_modules
```

This typically appears after an accidental `cd api/src && npm install`,
which creates a separate dependency tree there. Node's module
resolution walks UP the directory tree from each test file, so
`api/src/__tests__/foo.test.js` finds `api/src/node_modules/` BEFORE
`api/node_modules/` and resolves the wrong copy of any package
present in both. The repo's `.gitignore` already excludes
`node_modules` at every depth, so the directory never makes it into
git — but it can persist in a working tree until you notice the
symptom.

## Connector framework

The API's third-party integrations (IaC state sources, cloud accounts, APM
vendors, OpenTelemetry ingest) all plug in as **connectors** registered at
boot. A connector is a folder under `api/src/connectors/<id>/` that exports a
default `ConnectorSpec` object.

```
api/src/
  connectors/
    iac-state-backend/      # pull — Terraform/OpenTofu state from S3/Azure/GCS/Consul
      index.js              # ConnectorSpec
      backends/             # per-backend list/fetch/health
    terraform-cloud/        # pull — TFC / Terraform Enterprise
      api.js                # REST client
      index.js
    otel-ingest/            # push — OTLP/HTTP receiver
      index.js
      parse.js              # pure helpers (unit-testable)
      routes.js             # Fastify route that stages spans
  plugins/
    connectors.js           # loads the registry; applies runtime DDL
    otel-aggregator.js      # periodic worker: otel_spans_raw → Neo4j graph
  utils/
    terraform-state-parser.js
    iac-ingest.js           # shared MERGE path for all IaC writes
    encrypt.js              # AES-256-GCM — extend SECRET_FIELDS for new auth
  routes/
    integrations.management.js   # generic CRUD: /integrations, /connectors
    integrations.js              # legacy TF upload (now uses shared parser)
```

### Spec shape

```js
{
  id:          'my-connector',          // must match the directory name
  category:    'iac'|'apm'|'cloud'|'telemetry-ingest'|'upload',
  displayName: 'Human-readable',
  authSchema:  { type:'object', required:[...], properties:{...} },

  // Credential probe (optional but recommended).
  healthCheck: async (cfg, ctx) => ({ ok, detail }),

  // Pull-style (scheduled):
  fetch:     async function* (cfg, ctx) { yield rawBatch },
  normalize: (raw, cfg)       => normalizedShape,
  ingest:    async (norm, ctx) => ({ resourcesCreated, ... }),

  // Push-style (receiver):
  receiver:  { register: async (fastify) => { fastify.post(...) } },

  // Lifecycle hooks (optional):
  beforeUpsert: async (cfg)        => cfg,        // fill defaults / generate tokens
  afterUpsert:  async (row, ctx)   => {},         // sync derived rows
}
```

### Adding a new connector

1. Create `api/src/connectors/<id>/index.js` exporting a default spec.
2. If the connector needs new secret fields, add them to `SECRET_FIELDS` in
   `api/src/utils/encrypt.js` (they'll then be auto-encrypted at rest).
3. If it needs backing tables, add `postgres-init/NN-<your>.sql`, sync the
   file to `k8s/base/postgres-init/`, and append it to the
   `configMapGenerator.files` list in `k8s/base/kustomization.yaml`. Mirror
   the DDL in an IF-NOT-EXISTS runtime hook so existing installs pick it up
   without a volume wipe.
4. Restart the API — `[Connectors] Loaded: <id>` should appear in the log.

Routes wire themselves in via the registry: no server.js changes needed.

## Testing

Jest is the test runner (ESM-compatible via `--experimental-vm-modules`).
`supertest` is available for HTTP-level tests, **`jest.spyOn(globalThis,
'fetch')`** for outbound HTTP mocking (nock and undici's `MockAgent` both
have caveats with Node 18+'s built-in fetch dispatcher — spying on the
global is simple and portable), and `@testcontainers/postgresql` +
`@testcontainers/neo4j` for real database integration tests.

```bash
cd api

# Everything (unit + integration)
npm test

# Pure unit suite — no Docker required
npm run test:unit

# Integration suite — boots Postgres + Neo4j containers; skips cleanly if
# Docker isn't available.
npm run test:integration

# Coverage report
npm run test:coverage
```

### What's covered today

- `utils/terraform-state-parser` — v4 tfstate, `show -json`, module walks, unmapped types
- `utils/encrypt` — round-trip, SECRET_FIELDS coverage
- `connectors/base` — `validateRequired`, `withRetry`, `ConnectorError`, `runPullScan` lifecycle + abort
- `connectors/index` — registry shape contract: every loaded spec has id,
  displayName, category, and either `fetch` or `receiver.register`
- `connectors/otel-ingest/parse` — OTLP AnyValue unwrapping, key-value maps,
  hex-id decoding, full payload flattening incl. legacy
  `instrumentationLibrarySpans`
- `connectors/terraform-cloud/api` — JSON:API pagination, 404 tolerance,
  pre-signed URL download without bearer header, remote-state-ref extraction
- `plugins/otel-aggregator` — pure helpers + three-sweep aggregator logic
- **Integration:** end-to-end OTLP → otel_spans_raw → three-sweep →
  `:Component` + `:CONNECTED_TO` edges in Neo4j

### When writing a new connector test

- Prefer the `jest.spyOn(globalThis, 'fetch')` pattern from
  `terraform-cloud/__tests__/api.test.js` for REST clients — the default
  mock implementation throws if an unexpected fetch slips through, which
  keeps accidental real-network calls out of CI.
- For cloud SDK clients (S3, Azure Blob, GCS) stub via the SDK's own mock
  client helpers or a local server; spying on `globalThis.fetch` only
  intercepts direct fetch calls, which SDK-internal transports may bypass.
- Pure logic first, framework-bound code last. Move non-trivial functions
  out of route handlers / plugins into siblings that unit tests can import
  directly — `otel-ingest/parse.js` and the exported helpers in
  `otel-aggregator.js` are the pattern.

## Local hygiene — git hooks, Node version, audit

Three small tools live alongside the repo to catch the boring failure modes early. None are wired in automatically (a fresh clone never silently changes git config); enable them once per checkout.

**Node version pin.** `api/.nvmrc` declares Node 22. With `fnm` or `nvm`, running `nvm use` (or letting `fnm` auto-switch) inside `api/` picks it up — one less "wrong Node version" footgun when bouncing between projects.

**Pre-commit hook — stray `api/src/node_modules/`.** A `node_modules` tree under `api/src/` shadows `api/node_modules` because Node's resolver walks upward from the importing file. This cost real time during the Fastify 5 upgrade. The checked-in hook at `.githooks/pre-commit` refuses to commit while that directory exists; running `cd api && npm install` (or `npm ci`) wires it up automatically via the `prepare` lifecycle, which calls `scripts/install-hooks.sh` and points `core.hooksPath` at `.githooks/`. Run the script directly if your workflow skips `npm install`:

```bash
scripts/install-hooks.sh
```

If the stray directory ever appears, remove it with `rm -rf api/src/node_modules`.

**Dependency audit summary.** `scripts/audit-summary.sh` prints the `npm audit` by-severity breakdown for `api/` and compares it against `scripts/audit-baseline.json`. CI calls it without flags and fails on regression; locally:

```bash
scripts/audit-summary.sh                  # print + compare
scripts/audit-summary.sh --update-baseline    # lock in the current state after fixing/accepting findings
scripts/audit-summary.sh --no-fail        # print + compare without exiting non-zero
```

## Internal TLS posture

**Default — plaintext, scoped to the cluster network.** Both database connections (Neo4j over `bolt://`, Postgres over plain TCP) currently run unencrypted on every shipped deployment. The trust boundary is the K8s cluster network: pod-to-pod traffic stays on the CNI overlay, the database services aren't exposed via Ingress, and the Neo4j / Postgres pods don't accept connections from outside their service ClusterIP. Tests use Testcontainers on localhost — also plaintext, by design.

This stance is acceptable while the API and the databases share a cluster. It stops being acceptable the moment any of the following changes:

- Postgres moves to a managed service (RDS, Cloud SQL, Azure Postgres) — those terminate at a public endpoint and require TLS.
- Neo4j moves to AuraDB or any cross-VPC deployment — same reasoning.
- A meshing / zero-trust requirement (mTLS between every pod) lands.

**How to flip it on when needed.**

| Knob | What it does |
|---|---|
| `APPCLOUD_NEO4J_URI=bolt+s://host:7687` (or `neo4j+s://`) | Driver-side TLS with full cert verification. Use `bolt+ssc://` only if the server uses a self-signed cert and you can't bundle the CA. |
| `APPCLOUD_POSTGRES_SSL=true` | Enables `ssl` on the pg pool. With no further config, this disables cert verification (matches `sslmode=require`). |
| `PG_CA_FILE=/path/to/ca.pem` | Combined with `APPCLOUD_POSTGRES_SSL=true`, switches to `rejectUnauthorized: true` against the supplied CA bundle. |
| `APPCLOUD_REQUIRE_TLS=true` | Hard-fail: refuse to start unless TLS is configured for both Neo4j and Postgres. Independent of host shape — operators who set this flag mean it, even for in-cluster hostnames. |

The plugins emit a `WARN` log on startup when the configured host looks remote (anything other than `localhost` / `127.0.0.1` / the in-cluster service names `neo4j` / `postgres`) and TLS isn't on. The warning is deliberately not fatal so existing in-cluster deployments don't refuse to start; treat it as a deploy-time signal that the target is outside the original trust boundary and the env vars above need attention.

If you want the strict version — refuse to start when TLS isn't configured at all, regardless of how local-shaped the hostname looks — set `APPCLOUD_REQUIRE_TLS=true`. Local dev keeps the soft warning by default; flipping the strict knob is a deliberate prod-side decision.

## Operator runbook — common production scenarios

Short, copy-pasteable recipes for the failure modes the alerts in the next section actually fire on. Each entry: symptom → diagnostic → action.

### "audit_log is filling Postgres disk"

**Symptom.** Postgres disk-use alarm fires; `\dt+ audit_log` shows the partitioned table is many GB.

**Diagnostic.** Check the retention window — defaults to 365 days, so a deployment that's been receiving traffic for over a year will have grown one partition per month plus the default. Inspect the per-partition row counts:

```sql
SELECT relname, pg_size_pretty(pg_relation_size(relname::regclass)) AS size, n_live_tup
FROM pg_class c
JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE relname LIKE 'audit_log_%'
ORDER BY pg_relation_size(relname::regclass) DESC;
```

**Action.**
1. Confirm `APPCLOUD_AUDIT_RETENTION_DAYS` matches your compliance requirement. Lower it if oversize is the issue.
2. Trigger an immediate retention pass: `curl -X POST -H "X-API-Key: $ADMIN_KEY" "$BASE/admin/audit-cleanup/run-now"`.
3. If retention's already short and the default partition is huge, see the next entry.

### "audit_log_default has millions of rows"

**Symptom.** Operator notices `audit_log_default` is massively bigger than any monthly partition; retention's `DROP PARTITION` doesn't touch it.

**Diagnostic.** Default partition catches rows whose month has no matching `audit_log_YYYY_MM`. Pre-migration rows OR rows for months where `ensureCurrentAndNextPartitions` lapsed end up there.

**Action.** `curl -X POST -H "X-API-Key: $ADMIN_KEY" "$BASE/admin/audit-cleanup/redistribute-default"`. The endpoint scans the default partition, creates monthly partitions as needed, moves rows in transactions, re-attaches the default. Returns per-month counts.

### "appcloud_audit_log_default_detached == 1"

**Symptom.** The detached-default Prometheus gauge is high — `redistributeDefaultPartition` crashed mid-run and the `finally`-block re-attach failed (rare; a Postgres connectivity blip during the ATTACH).

**Diagnostic.** `curl -H "X-API-Key: $ADMIN_KEY" "$BASE/admin/audit-cleanup/default-partition-state"`. Returns `{ detached: true, recoverySql: "..." }`.

**Action.** Run the SQL the endpoint returned: `ALTER TABLE audit_log ATTACH PARTITION audit_log_default DEFAULT`. Once attached, the gauge drops back to 0.

### "appcloud_auth_disabled == 1 in production"

**Symptom.** A production deploy is running with auth disabled — every request reaches handlers as anonymous-admin. Every audit row records `actor: 'anonymous'`.

**Diagnostic.** The bootstrap secret was lost (deleted ConfigMap, expired Secret, race during secret-mount, mistakenly empty value).

**Action.**
1. *Immediately:* drain the deployment from external traffic if possible (`kubectl scale --replicas=0`), or remove the public Service endpoints.
2. Restore the bootstrap key: regenerate or fetch from your secret store, write to `secrets/appcloud_api_key.txt` (or update the K8s `appcloud-api-key` Secret).
3. Restart the API; verify `appcloud_auth_disabled == 0` and that `/whoami` returns the principal name (not `anonymous`).
4. Audit: pull every row in `audit_log` where `actor = 'anonymous'` and the time window matches the outage. Investigate any mutations attributed to it.

### "the audit retry buffer is at 100+ rows for 5+ minutes"

**Symptom.** `appcloud_audit_buffer_pending > 100` Prometheus alert.

**Diagnostic.** Postgres unreachable or under heavy load. Check connectivity from the API pod (`kubectl exec -it <api-pod> -- psql ...`).

**Action.**
1. Bring Postgres back. The buffer drains automatically on the next periodic tick (default 30s, `APPCLOUD_AUDIT_BUFFER_DRAIN_MS`).
2. If `appcloud_audit_buffer_dropped_total` is rising, raise `APPCLOUD_AUDIT_BUFFER_MAX` (default 1000) and redeploy. Drops are lost rows.
3. If `appcloud_audit_buffer_poisoned_total` is rising, the issue is per-row (FK / constraint failure on a specific actor or resource), not connectivity. Tail `[pg] audit row poison-evicted` log lines for the actor + action + resource — that's the bad row.

### "Neo4j is unreachable; the API is returning 503 from /ready"

**Symptom.** K8s readiness probe is failing (`kubectl describe pod` shows `Readiness probe failed: HTTP probe failed with statuscode: 503`).

**Diagnostic.** `curl http://<api-pod>:3000/ready` returns `{ "status": "unavailable", "neo4j": "neo4j unavailable" }`. The API has decorated `fastify.neo4j` with the 503 stub instead of crashing.

**Action.**
1. Bring Neo4j back; check `kubectl logs neo4j-0`.
2. Restart the API (the stub decoration is set at boot — it doesn't auto-recover until the next process start).
3. While Neo4j is down, write-paths return 503; read-paths that don't touch the graph stay green.

### "the scheduler is firing twice in a multi-replica deployment"

**Symptom.** `[Scheduler] another replica holds the leader lock — skipping tick` is good. The bug shape is: scans running concurrently, audit rows showing two `scheduler:discovery-scan` actors per cycle.

**Diagnostic.** The advisory-lock leader election (`pg_try_advisory_lock`) requires Postgres connectivity; if a replica's `fastify.pg.pool` is the stub (Postgres unreachable), it falls through to "no-pool" and runs unconditionally. Multi-replica + Postgres-degraded = duplicate scans.

**Action.** Restore Postgres connectivity. Confirm by hitting `/ready` on each replica.

---

## Operator alerts — Prometheus rules to copy

The metrics plugin (`api/src/plugins/metrics.js`) exposes a small set of high-leverage gauges + counters. The intended alert vocabulary, with sample PromQL rules suitable for `kube-prometheus`-style stacks:

```yaml
groups:
  - name: appcloud-audit-pipeline
    rules:
      # Audit retry buffer is filling up — Postgres unreachable or slow.
      # 100 rows pending for 5+ minutes means audit data is being held in
      # memory; survives a restart only via the periodic drain.
      - alert: AppCloudAuditBufferGrowing
        expr: appcloud_audit_buffer_pending > 100
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Audit-log retry buffer above threshold for 5m"
          runbook: "Check Postgres connectivity; see /admin/audit-cleanup/buffer-stats for context"

      # Buffer overflow drops — capacity hit. Fix the underlying outage
      # and / or bump APPCLOUD_AUDIT_BUFFER_MAX. Distinct from poison
      # evictions (per-row failures); both alert separately.
      - alert: AppCloudAuditBufferDropping
        expr: rate(appcloud_audit_buffer_dropped_total[5m]) > 0
        for: 5m
        labels: { severity: warning }

      - alert: AppCloudAuditPoisonEvictions
        expr: rate(appcloud_audit_buffer_poisoned_total[15m]) > 0
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "Audit rows being poison-evicted — likely FK / constraint violation"

      # Default partition detached and not re-attached — the
      # redistribute path crashed mid-run. Recovery is manual: see
      # GET /admin/audit-cleanup/default-partition-state for the SQL.
      - alert: AppCloudAuditDefaultPartitionDetached
        expr: appcloud_audit_log_default_detached == 1
        for: 5m
        labels: { severity: critical }

  - name: appcloud-auth
    rules:
      # Auth in open-fallback mode for more than a few minutes in any
      # non-dev environment. A deploy that lost its bootstrap secret.
      - alert: AppCloudAuthDisabled
        expr: appcloud_auth_disabled == 1
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "API running with auth disabled (anonymous-admin)"
          runbook: "Set APPCLOUD_API_KEY / APPCLOUD_ADMIN_API_KEY and restart"
```

Drop the rules into your existing alerting pipeline; tweak thresholds against your actual scrape interval and on-call patience.

## Integration with CI/CD

The development setup mirrors production but with:
- Volume mounts for rapid iteration
- Development dependencies
- Relaxed security settings
- Test databases

Use `docker-compose.yml` (without dev override) for production-like testing.

## Performance Tips

- **Use watch mode**: `./dev.sh test:watch` for continuous testing
- **Selective testing**: Focus on changed files during development
- **Container reuse**: Keep containers running between sessions
- **Resource limits**: Adjust memory limits in `docker-compose.dev.yml` for your system