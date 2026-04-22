# AppCloud

AppCloud is a knowledge graph platform for infrastructure dependency mapping and blast radius analysis across multi-cloud environments (Azure, AWS, GCP). The core job is to ingest cloud resource inventory, enrich it with structural and semantic relationships, and answer "if X changes, what's affected?" with traceable evidence.

This file is the durable context for working on AppCloud. Read it at the start of every session. If anything here contradicts the current code, flag it — don't silently paper over the drift.

---

## Stack

- **API / ingestion**: Node.js + Fastify
- **Graph store**: Neo4j (primary source of truth for relationships)
- **Relational store**: PostgreSQL (scheduling, audit trail, job state)
- **Scanners**: per-cloud modules (Azure first-class today; AWS and GCP in varying states)

---

## Graph conventions (Neo4j)

These are load-bearing. Violating them silently corrupts the graph.

### Writes are always idempotent

Every write uses `MERGE`, never `CREATE`, for both nodes and edges. Scanners re-run on a schedule and the graph must converge, not accumulate duplicates. If you're tempted to use `CREATE` for performance, stop and surface the tradeoff — we'd rather be slow and correct.

### Edge types

Two primary edge types, both with traceability properties attached (not just labels):

- `:CONNECTED_TO` — a relationship inferred between resources (the suggest engine produces most of these)
- `:DEPLOYED_ON` — a structural hosting relationship (e.g., web app deployed on App Service Plan)

Every edge carries traceability properties that explain *why* the edge exists:
- `source` — which signal or pipeline stage created it (`tag`, `rgMapped`, `planMapped`, `structuralA`, `structuralB`, etc.)
- `confidence` — numeric score (see scoring model below)
- `createdAt` / `lastSeenAt` — for staleness detection
- `evidence` — human-readable string summarizing the reasoning

Never create an edge without traceability properties. An un-traceable edge is worse than no edge because it cannot be audited, re-scored, or invalidated.

### Node identity

Azure resources are identified by their ARM resource ID (fully qualified). Always parse the ARM ID at ingestion to extract subscription, resource group, provider, type, and name — store these as first-class properties. Do not rely on parsing the ID on every query.

---

## Discovery architecture

Three stages, in order. Each stage's output is the next stage's input.

### 1. Scanner

Per-cloud module that pulls raw inventory. For Azure, this means ARM API calls per resource type. The scanner's job is to:

- Fetch resources for all supported types (AKS, SQL Server, App Services, Redis, VNets, App Service Plans, etc.)
- Parse the ARM ID and extract `resourceGroup` for every resource type (historically this was patchy — don't regress it)
- Write nodes to Neo4j via `MERGE` with full ARM ID provenance
- Emit structural edges (`:DEPLOYED_ON` for ASP → web app, etc.) where the API response makes them unambiguous

The scanner does **not** infer relationships. That's the suggest engine's job.

### 2. Suggest engine

Consumes the raw graph and proposes `:CONNECTED_TO` edges using layered signals. Current signals, in roughly increasing structural weight:

- **Tag-based** — shared application tags, project tags, etc. (lowest confidence, easily misused)
- **Structural Signal A: Resource Group co-location** — resources in the same RG get a base score (45–75 pts depending on type compatibility). This is the fallback when tags are missing.
- **Structural Signal B: Shared App Service Plan** — web apps sharing an ASP score 80 pts. This is a strong structural signal because ASP sharing is a deliberate deployment decision.

The engine uses two lookup indexes built at engine startup:
- `rgMappedIndex` — resources grouped by resource group
- `planMappedIndex` — resources grouped by App Service Plan ID

If you add a new structural signal, it needs a letter (C, D…), a documented score range, a lookup index if appropriate, and a source tag for edge traceability.

### 3. Bootstrap

Runs after initial scan to fill in relationships the scanner and suggest engine didn't catch, particularly for tagless resources. Phased execution:

- **Phase 1**: tag-based linking where tags are present
- **Phase 2**: resource group propagation — for an RG, if ≥60% of tagged resources map to a single application, the remaining tagless resources in that RG inherit the mapping. Below the threshold, we abstain rather than guess.

Bootstrap tracks per-resource whether a link came from tags (`tagLinked`) or RG propagation (`rgLinked`). This distinction matters downstream for confidence reporting and user-facing explanations — don't collapse them into a single "linked" boolean.

---

## Scoring and confidence

Every inferred edge has a numeric confidence. Treat these as engineering quantities, not magic numbers — if you change a score, explain the change in the PR and update any tests that lock in the old value.

Current ranges:
- Tag-based: variable, typically 30–60
- Structural A (RG co-location): 45–75
- Structural B (shared ASP): 80
- Bootstrap Phase 2 (RG propagation ≥60% dominance): inherits from the dominant mapping with a penalty

When signals overlap for the same edge, combine deliberately — don't just take max. The current combination logic lives in the suggest engine and should be reviewed before being extended.

---

## PostgreSQL role

Postgres is for:
- **Scheduling** — scanner job definitions, cron state, backoff
- **Audit** — what ran when, against which subscription, with which outcome
- **Operational state** — things that don't belong in the graph (e.g., API rate-limit windows)

Postgres is **not** a duplicate of the graph. Resource relationships live in Neo4j. Don't migrate relational queries that should be Cypher.

---

## Working conventions

### Test discipline

- Every change to the suggest engine needs a test that locks in the scoring behavior on a representative fixture.
- Every change to bootstrap needs a fixture that demonstrates the `tagLinked` vs `rgLinked` accounting.
- ARM ID parsing has edge cases (nested resources, different provider casing) — don't trust a fix until there's a parser test for the specific shape.

### Logging

Structural decisions (signal fired, score assigned, edge created/skipped) should be logged at a level that lets us reconstruct why the graph looks the way it does. When in doubt, log the evidence string that would go on the edge.

### Naming

Keep the `rgMapped` / `planMapped` / `tagLinked` / `rgLinked` vocabulary consistent across scanner, suggest engine, bootstrap, logs, and edge `source` properties. Renaming any of these is a coordinated change, not a local one.

---

## How to work with me

I'm actively iterating on this codebase and thinking about the product positioning, so I need you working with me, not ahead of me.

**Default to the `propose-before-implementing` skill** for any change that:
- Introduces or modifies a signal in the suggest engine
- Changes bootstrap phase logic or thresholds
- Alters the graph schema (node labels, edge types, required properties)
- Changes scoring numbers or combination logic
- Adds a new resource type to the scanner
- Touches ARM ID parsing
- Refactors across scanner / suggest / bootstrap

For those, produce 2–3 candidate approaches with tradeoffs and wait for my pick before writing code. Include what each option optimizes for and what it costs.

**You can proceed without a proposal** for:
- Bug fixes with an obvious single correct answer
- Test additions that lock in current behavior
- Log message improvements, comment clarifications, doc updates
- Typo and lint fixes

**When you finish a task**, don't just say "done." Surface the top 2–3 adjacent improvements you noticed while working, ranked by blast-radius impact on the system. I'd rather have a candid list of "here's what I'd look at next and why" than a clean handoff that hides friction you saw.

**When you're uncertain**, say so explicitly and propose how to resolve the uncertainty (a test, a query against the graph, a question for me). Don't pick a direction and hope.