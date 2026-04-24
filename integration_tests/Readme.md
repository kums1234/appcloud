# AppCloud Integration Tests

Isolated test stack that runs against **LocalStack** (AWS emulation) and a
dedicated test Neo4j instance. No cloud accounts or real AWS credentials needed.

```
integration_tests/
├── docker-compose.yml   — LocalStack + test Neo4j + test API + test runner
├── seed.sh              — creates AWS resources in LocalStack
├── README.md
└── tests/
    ├── package.json
    ├── discovery.test.js  — AWS scan, graph population, idempotency
    └── accounts.test.js   — cloud account CRUD, infra→component linking
```

---

## Ports (do not conflict with the production stack)

| Service       | Port  |
|---------------|-------|
| LocalStack    | 4566  |
| Neo4j browser | 7475  |
| Neo4j bolt    | 7688  |
| Test API      | 3001  |

---

## Quick start

### 1 — Start the test infrastructure

```bash
cd integration_tests

docker compose up -d
```

Wait for LocalStack and Neo4j to pass their health checks (about 20–30 seconds):

```bash
docker compose ps        # all services should show "healthy" or "running"
```

### 2 — Seed AWS resources into LocalStack

```bash
docker compose run --rm seed
```

This creates 3 EC2 instances, 2 RDS instances, 3 Lambda functions, 2 ECS
clusters, 1 EKS cluster, 2 load balancers, 2 ElastiCache clusters and 3 S3
buckets — one representative resource for every type AppCloud scans.

### 3 — Run the tests

Run the full suite:

```bash
docker compose run --rm test
```

Or run a specific suite:

```bash
docker compose run --rm test npm run test:discovery
docker compose run --rm test npm run test:accounts
```

### 4 — Tear down

```bash
docker compose down -v   # -v removes volumes so next run starts clean
```

---

## Running tests without Docker (against a local API)

If you have the main stack running locally and want to run tests directly:

```bash
cd integration_tests/tests
npm install

API_URL=http://localhost:3000 \
AWS_ENDPOINT_URL=http://localhost:4566 \
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_DEFAULT_REGION=us-east-1 \
npm test
```

---

## Manual scan via curl

After seeding, you can trigger a discovery scan manually:

```bash
curl -s -X POST http://localhost:3001/discovery/scan/aws \
  -H 'Content-Type: application/json' \
  -d '{"regions":["us-east-1"],"credentials":{"accessKeyId":"test","secretAccessKey":"test"}}' \
  | jq '{total, duration, breakdown}'
```

Expected output:
```json
{
  "total": 15,
  "duration": 1200,
  "breakdown": {
    "ec2_instance": 3,
    "rds_instance": 2,
    "function": 3,
    "ecs_cluster": 2,
    "load_balancer": 2,
    "elasticache": 2,
    "s3_bucket": 3
  }
}
```

---

## Notes

- **No real AWS credentials needed.** LocalStack accepts any value for
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — the seed script and tests
  use `test` / `test`.
- **EKS** may report as skipped in LocalStack community edition — this is
  expected and the test suite accounts for it.
- **Azure and GCP** are not emulated by LocalStack. Validate those scanners
  against real free-tier accounts when ready (see the main README for cost
  guidance).
- The test Neo4j instance starts clean each time you `docker compose down -v`.
  This ensures tests are not affected by leftover data from previous runs.