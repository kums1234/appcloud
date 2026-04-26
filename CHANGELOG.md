# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — entries are
grouped by release branch and ordered newest-first within each section.

---

## Unreleased — `multi_key_rbac` branch

DB-backed multi-key RBAC system replacing the previous single-env-var auth.

### Added
- **`api_keys` Postgres table** ([postgres-init/10-api-keys.sql](postgres-init/10-api-keys.sql))
  storing SHA-256(plaintext) hash + 12-char prefix + scope set per key. The
  plaintext is never recoverable.
- **`req.principal`** — every authenticated request carries
  `{ id, name, scopes, prefix }` derived from the matched key.
- **Scope hierarchy** `admin > write > read` enforced per route via the
  onRoute hook. Routes opt-in with `config.scope: 'admin'|'write'|'read'`;
  the default is method-based (GET/HEAD → `read`, mutations → `write`).
- **`/admin/api-keys` CRUD** for creating / listing / revoking / patching
  keys. Plaintext is shown ONCE in the create response. Bootstrap rows
  cannot be revoked or patched via the API — rotate the env var instead.
- **`audit_log` attribution columns** `actor_key_id` (FK → `api_keys.id`,
  `ON DELETE SET NULL`) + `actor_scope` (admin|write|read). Every
  authenticated mutation records both alongside the `actor` text name.
- **`/audit/*` query exposure** — every response row includes
  `actorKeyId` and `actorScope`. New filters on `GET /audit`:
  `?keyId=<uuid>` (exact UUID match; **recommended**), `?scope=admin|write|read`.
- **`GET /audit/stats`** gains `byScope` (per-tier counts; pre-RBAC rows
  surface as `'(none)'`) and `topActors[].actorKeyId` so each entry maps
  back to a specific stored key.

### Changed
- **`actor` query is now exact-match by default.** `GET /audit?actor=…` and
  `GET /audit/actor/:name` previously did case-insensitive substring match
  via `ILIKE %name%`. They now do exact match. Pass `?like=true` to opt
  back into substring (legacy). **The recommended replacement is
  `?keyId=<uuid>`** — it's stable across renames and unique even when keys
  share a display name.
- **`topActors` groups by `(actor_key_id, actor)`** instead of `actor`
  alone. Two keys with the same display name (e.g. a name reused after the
  original key was revoked) surface as separate rows. Rows with NULL
  `actor_key_id` (system jobs, pre-RBAC history) still group together.
- **`pg.audit()` accepts an actor object** `{ name, keyId, scope }` in
  addition to the legacy bare-string form. Route handlers use
  `actorFromReq(req)` to build the object from `req.principal`.
- **`X-Actor` header is informational-only.** When a request authenticates
  with an API key, the audit row's actor is the key's name — not the
  header. Sending both logs a once-per-`(principal, xActor)`-pair warning
  so misconfigured callers are visible without flooding the log.
- **`APPCLOUD_API_KEY` env var bootstraps a `write`-scoped row**;
  `APPCLOUD_ADMIN_API_KEY` bootstraps an `admin`-scoped row. Rotating an
  env var refreshes the row's hash on the next process restart.

### Deprecated
- **Substring matching of `?actor=` / `/audit/actor/:name`** is opt-in
  (`?like=true`) and will be removed in a future release. Migrate any
  internal tooling to `?keyId=<uuid>` — see the api-guide §10.
- **`X-Actor` header** has no effect on authenticated requests. It's only
  consulted as a fallback when auth is disabled (no env vars + no DB
  rows). Stop sending it.

### Migration notes
- Existing routes that called `pg.audit(actor(req), …)` with `actor =
  req.headers['x-actor'] || 'system'` now call `actor = actorFromReq` —
  audit rows record the key principal automatically. No call-site change
  required for new commits.
- The `audit_log.actor_key_id` and `actor_scope` columns are nullable, so
  pre-existing rows continue to read. Pre-RBAC rows show up under
  `actor_scope = '(none)'` in the stats endpoint.

### Security
- Per-route scope enforcement closes the previous all-or-nothing model.
- The two-tier admin model from the security_enhancement branch
  (`APPCLOUD_ADMIN_API_KEY` env var) is now the lower-effort path; for
  multi-team operation, create separate keys via `/admin/api-keys`.

### Added — key lifecycle
- **`api_keys.expires_at TIMESTAMPTZ`** (nullable; NULL = never expires).
  The auth-plugin cache filter (`WHERE revoked_at IS NULL AND (expires_at
  IS NULL OR expires_at > now())`) drops expired keys at refresh time, and
  a per-request expiry check (`new Date(principal.expiresAt) <= new Date()`)
  enforces the moment of expiry without waiting for the cache TTL. Useful
  for time-bound CI tokens.
- `POST /admin/api-keys` accepts an optional `expiresAt` ISO instant
  (rejected with 400 if it's already in the past at create time).
  `PATCH /admin/api-keys/:id` accepts `expiresAt: null` to clear or an
  ISO instant to set/extend (no future-only check on PATCH so it can
  also be used to force-expire a key without bumping `revoked_at`).
- `GET /admin/api-keys` rows expose `expires_at`.

### Reliability — audit log
- **`pg.audit()` retry buffer.** Failed INSERTs no longer disappear into a
  silent try/catch. Rows queue in an in-memory ring buffer (capped via
  `APPCLOUD_AUDIT_BUFFER_MAX`, default 1000) and drain on a timer
  (`APPCLOUD_AUDIT_BUFFER_DRAIN_MS`, default 30s) plus opportunistically
  after every successful audit. Order of original `audit()` calls is
  preserved across recovery — backlog drains FIFO before the new row
  inserts. Buffer overflow evicts the OLDEST row and increments a
  `stats.dropped` counter (logged at every 100 evictions). Final drain on
  graceful shutdown, bounded to 5 seconds.
- **`audit_log` retention.** A new `auditCleanupPlugin` runs at a fixed
  cadence to bound table size. Auto-detects whether `audit_log` is
  partitioned and chooses the right strategy:
    - **partitioned** → DETACH + DROP each partition whose upper bound is
      older than the cutoff. ~O(1) per partition; no row scan.
    - **regular** (pre-partitioning fallback) → CTE-batched DELETE
      bounded by `APPCLOUD_AUDIT_CLEANUP_BATCH_SIZE` (default 10 000).
  Configurable via `APPCLOUD_AUDIT_RETENTION_DAYS` (default 365),
  `APPCLOUD_AUDIT_CLEANUP_INTERVAL_MS` (default 24h). Retention=0
  disables the job. Decorator `fastify.auditCleanup.runNow()` exposed
  for ops automation. First run staggered 30s after startup.

- **`audit_log` partitioned by month on `created_at`.** New
  `postgres-init/12-audit-partitioning.sql` + the runtime migration in
  `utils/audit-partitioning.js` convert `audit_log` to a Postgres-native
  RANGE-partitioned table. Existing rows survive the migration via a
  default partition; current and next-month partitions are auto-created
  on startup and again on each cleanup run, so a row landing on a
  month boundary always has a home. Composite primary key is
  `(id, created_at)` (Postgres requires the partition key be in every
  uniqueness constraint). Retention plugin auto-detects the new shape
  and uses DROP PARTITION instead of DELETE.

---

## release/0.1.0.0

Baseline release including the security_enhancement work
(default-deny auth plugin, scrypt KDF + per-row salts, AWS region
allowlist, CORS allowlist, rate limiting, body-schema strictness,
admin-tier audit/debug routes).
