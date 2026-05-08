# Minimal multi-cloud autolink fixture

A small, deliberate Terraform deployment plus its captured native-inventory responses, designed to exercise the four behaviours of `discovery.autolink.js` end-to-end across all three clouds.

This is **not** a coverage fixture. For coverage breadth use the vulnerable-by-design deployments described in `docs/test-bed-validation.md`. This fixture exists so that scoring-table changes and cross-cloud-invariant changes have a single, deterministic test that fails loudly.

## The four shapes

| # | Shape | Triggers | Expected outcome |
|---|---|---|---|
| 1 | Co-location bucket with multiple resources, all mapped to one Component | Rule 1 (co-location vote) | Unanimous vote → score **85**; majority → score **70** |
| 2 | Direct 1-hop structural edge from unmapped Infra to a mapped Infra across a shared `via` | Rule 2 (per-cloud `*_VIA_TO_AUTOLINK_SCORE`, default **60**) | Edge written with `source: 'auto-link'`, `via: 'component-mapping'`, `provider_source: '<cloud>-enrichment'`, plus the firing rule and score |
| 3 | Unmapped Infra reachable to a mapped Infra only via a 2-hop path, with no Rule 1/Rule 2 hit | Rule 3 (`min(58, 40 + paths × 6)`) | 1 path → score **46** (below default minScore 60) → surfaces as a **suggestion**, not a written edge. By design: Rule 3 caps at 58 so 2-hop never beats Rule 1/Rule 2. |
| 4 | GCP Cloud Storage bucket with `allUsers:roles/storage.objectViewer` IAM binding | `gcp-iam-policy` supplement | Bucket node `public = true`, `public_via_iam = "roles/storage.objectViewer"` |

## Per-cloud resource list

### AWS (`aws/main.tf` → `captured/aws-config-aggregator.json`)

Account `111122223333`.

| Bucket | Resource | Component | Notes |
|---|---|---|---|
| us-east-1 | `vpc-aaa1...`             | web-app | Shape 1 — dense bucket |
| us-east-1 | `subnet-aaa1...`          | web-app | |
| us-east-1 | `sg-aaa1...`              | web-app | |
| us-east-1 | `eni-aaa1...`             | web-app | |
| global    | `role/role-web-app`       | (unmapped) | Shared between EC2 and Lambda — the 2-hop bridge |
| global    | `instance-profile/web-instance-profile` | (unmapped) | |
| us-east-1 | `i-aaa1...` (EC2)         | **web-app (mapped)** | Shape 2 — 1-hop to subnet, vpc, eni, sg, iam-role |
| us-west-2 | `vpc-bbb1...`             | (unmapped) | Sparse bucket |
| us-west-2 | `subnet-bbb1...`          | (unmapped) | |
| us-west-2 | `sg-bbb1...`              | (unmapped) | |
| us-west-2 | `function:fn-batch`       | (unmapped) | Shape 3 — 2-hop via role-web-app to mapped EC2 |

### Azure (`azure/main.tf` → `captured/azure-resource-graph.json`)

Subscription `00000000-0000-0000-0000-000000000000`.

| Bucket | Resource | Component | Notes |
|---|---|---|---|
| rg-web-prod | `vnet-web` | web-app | Shape 1 — dense bucket |
| rg-web-prod | `subnet-web` | web-app | |
| rg-web-prod | `nic-web` | web-app | |
| rg-web-prod | `disk-web` | web-app | |
| rg-web-prod | `vm-web` | **web-app (mapped)** | Shape 2 — 1-hop to nic (`via:'nic'` confidence 90), subnet, disk |
| rg-web-prod | `asp-web` | web-app | Shape 2 — exercises Azure `app-service-plan` via |
| rg-web-prod | `app-web-fixture` | web-app | 1-hop to asp-web via `app-service-plan` |
| rg-batch | `stbatchfixture001` | (unmapped) | Sparse bucket |
| rg-batch | `pe-batch-to-web` | (unmapped) | Shape 3 — private endpoint into rg-web-prod's subnet, 2-hop to vm-web |

### GCP (`gcp/main.tf` → `captured/gcp-cloud-asset.json` + `captured/gcp-iam-policy.json`)

| Project | Resource | Component | Notes |
|---|---|---|---|
| gcp-web-prod-001 | `vpc-web` | web-app | Shape 1 — dense bucket |
| gcp-web-prod-001 | `subnet-web` | web-app | |
| gcp-web-prod-001 | `sa-web` | web-app | |
| gcp-web-prod-001 | `disk-web` | web-app | |
| gcp-web-prod-001 | `vm-web` | **web-app (mapped)** | Shape 2 — 1-hop to subnet, vpc, service-account, disk |
| gcp-web-prod-001 | `bucket-public-fixture-001` | **web-app (mapped)** | Shape 4 — `allUsers` binding flips `public=true`, `public_via_iam=roles/storage.objectViewer` |
| gcp-batch-002 | `sa-batch` | (unmapped) | |
| gcp-batch-002 | `svc-batch` (Cloud Run) | (unmapped) | Shape 3 — 2-hop via sa-batch to bucket-public (cross-project IAM grant) |

## File layout — data and metadata are separate

Each captured response is stored as two files in `captured/`:

| Data file | Metadata sidecar |
|---|---|
| `aws-config-aggregator.json` | `aws-config-aggregator.meta.json` |
| `azure-resource-graph.json` | `azure-resource-graph.meta.json` |
| `gcp-cloud-asset.json` | `gcp-cloud-asset.meta.json` |
| `gcp-iam-policy.json` | `gcp-iam-policy.meta.json` |

The data file is byte-for-byte the shape the scanner expects — no extra keys, no comments. This means a strict scanner that rejects unknown top-level fields will still parse it.

The sidecar carries everything *about* the data file that isn't part of the response: the `gcloud` / `az` / `aws` command that produced it, who/when it was captured (or that it's hand-crafted), pagination notes, and — for supplements — the expected post-write Neo4j state (`expected_writes`). Each sidecar has a `target` field naming its data file so the relationship is reversible.

Tests should never load the `.meta.json` files; they're for humans and for re-capture tooling.

## Wiring this into a test

The fixture intentionally has no test file checked in — the assertions belong next to the autolink test, not next to the fixture. A typical wiring in `api/src/routes/__tests__/discovery.autolink.test.js` looks like:

```js
const path = require('node:path');
const fs = require('node:fs');

const FIXTURE_ROOT = path.join(__dirname, '../../../../tests/fixtures/terraform/minimal-multicloud/captured');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8'));
}

describe('autolink — minimal multi-cloud fixture', () => {
  beforeEach(async () => {
    await neo4jTestHarness.reset();

    // Drive each scanner with its captured response.
    await runScannerWithFixture('azure', loadFixture('azure-resource-graph.json'));
    await runScannerWithFixture('gcp',   loadFixture('gcp-cloud-asset.json'));
    await runScannerWithFixture('gcp-iam-policy', loadFixture('gcp-iam-policy.json'));
    await runScannerWithFixture('aws',   loadFixture('aws-config-aggregator.json'));

    // Seed the mapped Components from the .tf labels (web-app in each cloud).
    await bootstrap.runPhase1TagBased();
  });

  test('Shape 1 — Rule 1 unanimous co-location votes for web-app at score 85', async () => {
    const candidates = await autolink.evaluate({ rule: 1, bucket: 'rg-web-prod' });
    expect(candidates.find(c => c.component === 'web-app')).toMatchObject({ score: 85, rule: 'rg-unanimous' });
  });

  test('Shape 2 — Rule 2 direct via writes auto-link edge', async () => {
    const edges = await neo4j.run(`
      MATCH ()-[r:CONNECTS_TO {source: 'auto-link', via: 'component-mapping'}]->()
      WHERE r.rule STARTS WITH 'rule2-'
      RETURN r.via_source AS viaSource, r.score AS score
    `).then(r => r.records.map(rec => rec.toObject()));
    // Asserts at least one Rule 2 hit per cloud across the shared via keys.
    expect(edges.some(e => e.viaSource === 'subnet')).toBe(true);
    expect(edges.some(e => e.viaSource === 'vpc')).toBe(true);
  });

  test('Shape 3 — Rule 3 surfaces fn-batch as suggestion (score 46), no edge written', async () => {
    const writtenEdges = await neo4j.run(`
      MATCH (i:Infra {name: 'fn-batch'})-[r:CONNECTS_TO {source: 'auto-link'}]->()
      RETURN r
    `).then(r => r.records);
    expect(writtenEdges).toHaveLength(0);

    const suggestions = await autolink.suggestionsFor('fn-batch');
    expect(suggestions[0]).toMatchObject({ component: 'web-app', score: 46, rule: expect.stringMatching(/^rule3-/) });
  });

  test('Shape 4 — gcp-iam-policy supplement flips public=true on bucket', async () => {
    const bucket = await neo4j.run(`
      MATCH (b:Infra {name: 'bucket-public-fixture-001'}) RETURN b
    `).then(r => r.records[0].get('b').properties);
    expect(bucket.public).toBe(true);
    expect(bucket.public_via_iam).toBe('roles/storage.objectViewer');
  });

  test('cross-cloud invariant — shared via keys score the same', async () => {
    // If AZURE/GCP/AWS_VIA_TO_AUTOLINK_SCORE drift apart on `subnet`, this fails.
    const subnetScores = await neo4j.run(`
      MATCH ()-[r:CONNECTS_TO {source: 'auto-link', via: 'component-mapping'}]->()
      WHERE r.via_source = 'subnet'
      RETURN DISTINCT r.score AS score
    `).then(r => r.records.map(rec => rec.get('score')));
    expect(new Set(subnetScores).size).toBe(1);
  });
});
```

The exact API surface (`runScannerWithFixture`, `autolink.evaluate`, `autolink.suggestionsFor`) will mirror whatever harness already exists for `discovery.autolink.test.js` — adapt to the local conventions.

## Re-capturing from a real deployment

The captured JSON in `captured/` is hand-crafted to mirror the .tf. To replace it with a true capture (recommended once a sandbox is available), follow the workflow in `docs/test-bed-validation.md` — apply the .tf in a sandbox, wait for the cloud's inventory service to settle, then run the per-cloud capture commands documented there.

When you replace a data file, update its `.meta.json` sidecar — at minimum the `captured_from` field (drop the "hand-crafted" wording, replace with the date and sandbox identifier you captured against) and `real_response_note` (record any notable differences from the previous capture: new fields, retired fields, pagination behaviour).

The hand-crafted version is structurally faithful to each native API's response shape, but real responses carry many more fields (defaulted properties, server-assigned timestamps, etc.) that the scanner ignores. A real capture is more honest as a regression fixture; this version is the bootstrap.

## Updating this fixture

Update when:

- A new shared `via` key is introduced (must be added to all three clouds → cross-cloud invariant test)
- A new supplement layer that emits edges (add both `captured/<source>.json` and `captured/<source>.meta.json`)
- A scoring change moves a fixture-asserted edge across the minScore threshold

Don't update when:

- A new resource type is added to a single scanner (use a focused per-scanner fixture)
- A new auto-link rule is added (build a separate fixture for it; bolting it on dilutes which rule each assertion locks in)
