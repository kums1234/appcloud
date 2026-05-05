# Test-bed validation

How to exercise AppCloud's discovery pipeline (primary scanner → supplements → auto-link → bootstrap) against realistic fixtures without standing up a production tenant.

There are two tiers of validation:

1. **Vulnerable-by-design deployments** — public Terraform projects that deploy a wide spread of real cloud resources. High coverage, useful for shaking out edge cases the scanners don't yet handle.
2. **Minimal multi-cloud fixture** — a hand-tuned, four-shape fixture that exists specifically to exercise auto-link's three rules and the GCP `public_via_iam` flip. Lives under `tests/fixtures/terraform/minimal-multicloud/`. See its README for the contract.

Use the minimal fixture in CI for fast, deterministic regression. Use the vulnerable-by-design deployments periodically for breadth and coverage audits.

---

## Tier 1 — Vulnerable-by-design deployments

These projects exist for security tooling, but for AppCloud they're free, varied, deploy-ready Terraform that produces real ARM IDs / self-links / ARNs with the cross-resource fields our scanners depend on.

| Project | Cloud(s) | Why useful for AppCloud |
|---|---|---|
| **TerraGoat** (Bridgecrew/Prisma) | AWS, Azure, GCP | Broad multi-cloud surface in one repo. Matches our three-cloud scope 1:1. |
| **CloudGoat** (Rhino Security Labs) | AWS | Scenario-based attack chains — IAM, EC2, Lambda, S3. Rich for IAM-binding edges and component groupings. |
| **AWSGoat / AzureGoat / GCPGoat** (INE Security) | One per cloud | Multi-tier app deployments. Resources cluster naturally into Components (web → app → data), so they exercise bootstrap and auto-link Rule 1 well. |
| **Sadcloud** | AWS | Older, narrower than the above, but adds variety in the long tail of AWS service types. |

### Recommended workflow

The cycle is the same regardless of which project you pick. Pin a specific commit so the resource shape is reproducible.

**1. Deploy into a sandbox.**

For AWS, you have three options ranked by cost and fidelity:

- *LocalStack Pro* — emulates `SelectAggregateResourceConfig` (the call `discovery.aws.js` makes). Fastest, free for what we need, but coverage is uneven for advanced resource types.
- *Free-tier AWS account* — real Config aggregator, real ARNs, real IAM. Best fidelity. Tear down with `terraform destroy` to avoid charges.
- *AWS Workshops / AWS Jam* — temporary credentials, but locked-down permissions usually mean Config aggregator can't be enabled. Avoid for our use case.

For Azure, you need a real tenant — there is no functional emulator for Resource Graph. A Visual Studio subscription or free trial works.

For GCP, the $300 free credit covers a CAI-enabled project comfortably.

**2. Capture the native-inventory response.**

Once Terraform is applied and the cloud's inventory service has caught up (Resource Graph is near-real-time; Config aggregator can lag 5–15 minutes; CAI is usually <1 minute), record the raw API response. The scanners are deterministic functions of these responses — so the captured JSON is everything you need for downstream replay.

```bash
# Azure
az graph query -q "Resources | project id, name, type, location, properties, tags, subscriptionId, resourceGroup" \
  --output json > azure-resource-graph.capture.json

# GCP
gcloud asset list --project=$PROJECT_ID --content-type=resource --format=json > gcp-cloud-asset.capture.json
gcloud asset list --project=$PROJECT_ID --content-type=iam-policy --format=json > gcp-iam-policy.capture.json

# AWS
aws configservice select-aggregate-resource-config \
  --configuration-aggregator-name <name> \
  --expression "SELECT * WHERE awsRegion IN ('us-east-1','us-west-2')" \
  > aws-config-aggregator.capture.json
```

Pagination matters: the scanners page end-to-end, and so should your capture. Strip credentials and account-specific data before checking anything in.

**3. Replay against the scanner under test.**

Drop the capture into `api/src/routes/__tests__/fixtures/<project>/` and write a fixture test that mocks the cloud client to return the captured page(s) and asserts:

- Node count by typed label matches what's in the .tf
- Every node has a parseable `cloud_id`
- Every emitted edge has `source`, `via`, `confidence`, `evidence` (the property contract from CLAUDE.md — un-traceable edges are worse than no edges)
- Re-running the scanner against the same capture produces zero new MERGE writes (idempotency)

**4. Run auto-link and bootstrap on top.**

The vulnerable-by-design projects often tag resources by app/component, so bootstrap Phase 1 (tag-based) should produce non-empty Components. With Components seeded, run `discovery.autolink.js` and assert that:

- Rule 1 fires for resources sharing the same RG / project / account+region
- Rule 2 fires across the shared via keys (`subnet`, `vpc`, `disk`, `service-account`, `iam-role`, `security-group`)
- Rule 3 fires only when 1+2 produced nothing ≥ minScore (the order is load-bearing — see `discovery.autolink.test.js`)

**5. Diff against the previous run.**

Check the resulting Neo4j state into a git-friendly format (Cypher dump or our own snapshot) and diff against the prior run. Any unexplained delta is a regression — either a scanner change, a scoring change, or an upstream API drift.

### Coverage expectations per project

Don't expect any single project to exercise everything. Roughly:

- **TerraGoat** covers all three clouds but is shallow on cross-resource references — good for *node coverage* and the property-promotion path. Weak for auto-link Rule 2 (sparse 1-hop graph).
- **CloudGoat** is dense on IAM edges. Best signal for the IAM-binding edge contract and `public_via_iam` paths (its CGID scenarios include public S3 buckets — analogous fidelity even though the GCP supplement is the only one that flips `public = true` today).
- **AWSGoat / AzureGoat / GCPGoat** deploy real multi-tier apps with web/app/data clustering — best for bootstrap tag-propagation (Phase 1) and Rule 1 co-location voting.

If a scanner change needs broader coverage than any single project provides, deploy two side-by-side into the same sandbox account and capture against the union.

### What vulnerable-by-design *won't* test

- The deterministic scoring contract — those projects evolve, and their inter-resource topology drifts between commits. Use the minimal fixture for that.
- Edge cases at the cloud_id parser layer — e.g., GCP self-links missing the `projects/.../zones/...` prefix, AWS resources that surface `resourceId` but not `arn`. Add targeted unit fixtures for those, not deployment-based ones.
- The `:IngestionEpisode` provenance writes — those need a Postgres-aware test, not a graph fixture.

---

## Tier 2 — Minimal multi-cloud fixture

`tests/fixtures/terraform/minimal-multicloud/` deliberately produces the smallest deployment that exercises the four shapes auto-link cares about:

1. **Co-location bucket with multiple resources** — Rule 1 (unanimous = 85, majority = 70)
2. **Direct structural 1-hop across shared via keys** — Rule 2 (per-cloud `*_VIA_TO_AUTOLINK_SCORE`)
3. **2-hop chain where Rules 1+2 stay below minScore** — Rule 3 (`min(58, 40 + paths × 6)`)
4. **`allUsers` IAM binding on a GCP resource** — gcp-iam-policy supplement, `public_via_iam` flip

The `.tf` files are the source of truth for what the captured-response fixtures *should* look like. The `captured/` directory holds hand-crafted JSON in the same shape as a real Resource Graph / CAI / Config aggregator response, so CI can run end-to-end without applying Terraform.

When the scoring tables in `discovery.{azure,gcp,aws}.js` or the per-cloud `*_VIA_TO_AUTOLINK_SCORE` tables in `discovery.autolink.js` change, the fixture's expected-score assertions in the test file change in lockstep. That coupling is intentional — it's what makes this a regression fixture rather than a smoke test.

See `tests/fixtures/terraform/minimal-multicloud/README.md` for the per-shape resource list, the expected node/edge counts, and the wiring snippet for an `__tests__` file.

### When to update the minimal fixture

- A new shared via key is introduced (must show up in Rule 2 for all three clouds → invariant test)
- A new supplement layer that emits edges (add the captured-response file under `captured/`)
- A scoring table change that moves a fixture-asserted edge across the minScore threshold (update the assertions, document the change in the PR per CLAUDE.md scoring discipline)

### When *not* to update the minimal fixture

- New resource type added to a scanner — test that with a focused scanner-level fixture. The minimal fixture is for cross-cloud invariants, not coverage.
- New auto-link rule — that needs its own fixture set; bolting it onto the minimal one muddies which rule each assertion is testing.
