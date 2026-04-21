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
- `JWT_SECRET=dev-jwt-secret-for-local-development`
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