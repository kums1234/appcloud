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