import fs from 'fs'
import { makeAuditMachinery } from '../utils/audit-buffer.js'
import { ensureAuditPartitioning, ensureCurrentAndNextPartitions } from '../utils/audit-partitioning.js'

function readSecret(fileEnvVar, plainEnvVar, fallback = '') {
  const filePath = process.env[fileEnvVar]
  if (filePath) {
    try { return fs.readFileSync(filePath, 'utf8').trim() } catch {}
  }
  return process.env[plainEnvVar] || fallback
}

// Stub returned when Postgres isn't reachable. ping() always rejects so
// /ready picks up the degraded state.
const PG_UNAVAILABLE = () => Object.assign(
  new Error('postgres unavailable'),
  { code: 'POSTGRES_UNAVAILABLE', statusCode: 503 },
)
const stub = {
  pool:  null,
  query: async () => [],
  audit: async () => {},
  ping:  async () => { throw PG_UNAVAILABLE() },
}

const AUDIT_BUFFER_MAX      = parseInt(process.env.APPCLOUD_AUDIT_BUFFER_MAX      || '1000',  10)
const AUDIT_BUFFER_DRAIN_MS = parseInt(process.env.APPCLOUD_AUDIT_BUFFER_DRAIN_MS || '30000', 10)

// Called directly on the root fastify instance — no encapsulation issues
export async function postgresPlugin(fastify) {
  const host = process.env.POSTGRES_HOST || ''
  if (!host) {
    fastify.decorate('pg', stub)
    return
  }

  let pg
  try {
    pg = (await import('pg')).default
  } catch {
    fastify.log.warn('pg package not installed — PostgreSQL disabled')
    fastify.decorate('pg', stub)
    return
  }

  const user     = readSecret('PG_USERNAME_FILE', 'POSTGRES_USER', 'postgres')
  const password = readSecret('PG_PASSWORD_FILE', 'POSTGRES_PASSWORD', '')
  const database = process.env.POSTGRES_DB || 'appcloud'
  const port     = parseInt(process.env.POSTGRES_PORT || '5432')

  // TLS — opt-in via APPCLOUD_POSTGRES_SSL=true. Defaults to plaintext
  // because every internal deployment so far has been intra-cluster (K8s
  // Service-to-Service over the cluster CNI) where the network boundary
  // is the trust boundary. See DEVELOPMENT.md "Internal TLS posture" for
  // the rationale and how to flip it on for managed-Postgres setups
  // (RDS, Cloud SQL, etc.) that require encrypted client connections.
  //
  // PG_CA_FILE points at a PEM bundle when the server uses a custom CA;
  // omit it to disable verification (rejectUnauthorized=false), which
  // matches the legacy `?sslmode=require` behaviour.
  const sslEnabled    = /^(true|1|yes)$/i.test(process.env.APPCLOUD_POSTGRES_SSL || '')
  const tlsRequired   = /^(true|1|yes)$/i.test(process.env.APPCLOUD_REQUIRE_TLS || '')
  let ssl = false
  if (sslEnabled) {
    const caPath = process.env.PG_CA_FILE
    if (caPath) {
      try {
        ssl = { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
      } catch (err) {
        fastify.log.warn(`[pg] PG_CA_FILE=${caPath} unreadable (${err.message}) — falling back to ssl: rejectUnauthorized=false`)
        ssl = { rejectUnauthorized: false }
      }
    } else {
      ssl = { rejectUnauthorized: false }
    }
  } else if (tlsRequired) {
    // Hard-fail: APPCLOUD_REQUIRE_TLS=true means refuse to start without
    // an encrypted connection, regardless of host shape. Operators who
    // set this flag mean it — don't second-guess them on in-cluster
    // hostnames.
    throw new Error(
      `[pg] APPCLOUD_REQUIRE_TLS=true but APPCLOUD_POSTGRES_SSL is not enabled — ` +
      `set APPCLOUD_POSTGRES_SSL=true (and PG_CA_FILE for verification) or unset APPCLOUD_REQUIRE_TLS`,
    )
  } else if (host && !/^(localhost|127\.0\.0\.1|::1|postgres)$/i.test(host)) {
    fastify.log.warn(
      `[pg] connecting to ${host}:${port} without TLS — set APPCLOUD_POSTGRES_SSL=true ` +
      `(and PG_CA_FILE for verification) when reaching managed Postgres or any host outside the cluster`,
    )
  }

  // Pool size — bumpable via APPCLOUD_PG_POOL_MAX. 10 was the previous
  // hardcoded default; higher values reduce queueing under bursty
  // load (audit writes + user queries + scheduler ticks compete) at
  // the cost of more idle connections. Tune against expected p95
  // concurrency, not peak.
  const poolMax = parseInt(process.env.APPCLOUD_PG_POOL_MAX || '10', 10)
  const pool = new pg.Pool({ host, port, database, user, password, ssl, max: poolMax,
    connectionTimeoutMillis: 3000 })

  try {
    const client = await pool.connect()
    client.release()
    fastify.log.info('PostgreSQL connected')
  } catch (err) {
    fastify.log.warn(`PostgreSQL unavailable (${err.message}) — disabled`)
    fastify.decorate('pg', stub)
    return
  }

  // Apply the audit_log evolution that adds actor_key_id + actor_scope
  // columns. Idempotent (`ALTER TABLE … ADD COLUMN IF NOT EXISTS …`) so
  // it's safe to run on every startup; mirrors postgres-init/11-audit-evolution.sql.
  // We run this BEFORE the partitioning migration so audit_log_legacy
  // (the renamed table during partitioning) has the up-to-date columns
  // before its rows get copied into the partitioned shell.
  try {
    await pool.query(`
      ALTER TABLE audit_log
        ADD COLUMN IF NOT EXISTS actor_key_id UUID
          REFERENCES api_keys(id) ON DELETE SET NULL;
      ALTER TABLE audit_log
        ADD COLUMN IF NOT EXISTS actor_scope TEXT;
      CREATE INDEX IF NOT EXISTS idx_audit_log_actor_key
        ON audit_log(actor_key_id) WHERE actor_key_id IS NOT NULL;
    `)
  } catch (err) {
    // The api_keys FK may not exist yet on a brand-new DB if the auth
    // plugin runs after this. Log + continue; the auth plugin's CREATE
    // TABLE IF NOT EXISTS api_keys runs before any audit() call.
    fastify.log.warn(`[pg] audit_log evolution skipped: ${err.message}`)
  }

  // Convert audit_log to a partitioned table (or create it as one on a
  // fresh DB). Idempotent — no-op if already partitioned. The retention
  // plugin (plugins/audit-cleanup.js) detects partitioning at runtime
  // and switches from CTE DELETE → DROP PARTITION.
  try {
    const runQuery = async (sql, params) => (await pool.query(sql, params)).rows
    await ensureAuditPartitioning(runQuery, fastify.log)
    await ensureCurrentAndNextPartitions(runQuery, fastify.log)
  } catch (err) {
    fastify.log.warn(`[pg] audit_log partitioning skipped: ${err.message}`)
  }

  // Audit machinery — buffer + retry. The factory in utils/audit-buffer.js
  // owns the algorithm so the integration test can exercise the same
  // logic without spinning a duplicate pool.
  const auditMachinery = makeAuditMachinery({
    runQuery: (sql, params) => pool.query(sql, params),
    log:      fastify.log,
    bufferMax: AUDIT_BUFFER_MAX,
  })

  // Periodic drain — rescues rows that piled up while Postgres was
  // unavailable. Cleared in onClose. unref() so the timer alone doesn't
  // keep the process alive. Errors are logged at WARN with structured
  // fields so a sustained outage shows up in incident triage instead
  // of being a silent gauge climb.
  const drainTimer = setInterval(() => {
    auditMachinery.drain().catch(err =>
      fastify.log.warn(
        { err: err.message, code: err.code, pending: auditMachinery.pending() },
        '[pg] audit-buffer drain failed — rows still queued for next tick',
      ),
    )
  }, AUDIT_BUFFER_DRAIN_MS)
  drainTimer.unref?.()

  // Schema names go straight into a dynamic-SQL string (`SET LOCAL
  // search_path` cannot be parameterized). Reject anything outside the
  // conservative tenant-schema shape so a caller can't smuggle SQL
  // through schemaName. Identical to the guard in
  // utils/tenant-schema-runner.js — kept duplicated rather than imported
  // to avoid a circular dependency at plugin load.
  const quoteSchemaIdent = (name) => {
    if (!/^[a-z_][a-z0-9_]{1,62}$/.test(name)) {
      throw new Error(`pg.forTenant: refusing unsafe schema name '${name}'`)
    }
    return `"${name}"`
  }

  // Open a checked-out connection, BEGIN, optionally set search_path,
  // run `fn(client)`, COMMIT (or ROLLBACK on throw). Always releases.
  // The `searchPathClause` is a pre-built `SET LOCAL search_path = …`
  // string when set (validated at forTenant() time so we can't
  // smuggle SQL through it here) or null for control-plane work.
  const runInTransaction = async (searchPathClause, fn) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (searchPathClause) {
        await client.query(searchPathClause)
      }
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try { await client.query('ROLLBACK') } catch {}
      throw err
    } finally {
      client.release()
    }
  }

  // Tenant-scoped query helper. Validates the schema name eagerly so
  // an unsafe name fails before any connection is checked out. Each
  // .query() / .transaction() call opens its own transaction so
  // search_path stays bounded to the call.
  const forTenant = (schemaName) => {
    const ident = quoteSchemaIdent(schemaName)                          // throws on unsafe
    const searchPathClause = `SET LOCAL search_path = ${ident}, public`
    return {
      schemaName,
      query: async (sql, params = []) =>
        runInTransaction(searchPathClause, async (client) =>
          (await client.query(sql, params)).rows,
        ),
      transaction: (fn) => runInTransaction(searchPathClause, fn),
    }
  }

  fastify.decorate('pg', {
    pool,
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    // ping() — used by /ready to probe connectivity per request. Tight
    // SELECT 1 so a degraded pool / slow connection surfaces fast and
    // the readinessProbe can mark the pod unready before the request
    // backlog grows.
    ping: async () => { await pool.query('SELECT 1'); return true },
    // forTenant(schemaName) — returns { query, transaction } that run
    // against a connection with `SET LOCAL search_path = <schema>, public`.
    // Used by the tenantContext preHandler to attach `req.pg` and by
    // out-of-request callers (the scheduler iterates per-tenant) that
    // need tenant-scoped writes.
    forTenant,
    // transaction(fn) — control-plane transaction without setting
    // search_path. Useful for /admin/tenants where row-insert and
    // schema-provision must succeed together.
    transaction: (fn) => runInTransaction(null, fn),
    // audit() — see utils/audit-buffer.js for full semantics. Briefly:
    //   - hot path: direct INSERT
    //   - on failure or backlog: queue + periodic retry
    //   - bounded buffer with oldest-eviction on overflow
    audit: auditMachinery.audit,
    // Test/inspection accessors so an integration test (or a future ops
    // endpoint) can assert on buffer state without poking module internals.
    auditBuffer: {
      pending: auditMachinery.pending,
      stats:   auditMachinery.stats,
      drain:   auditMachinery.drain,
    },
  })

  fastify.addHook('onClose', async () => {
    clearInterval(drainTimer)
    // Best-effort final flush so rows queued during the last request
    // survive the process exit. Bounded by 5s so a hard outage doesn't
    // hang shutdown.
    try {
      await Promise.race([
        auditMachinery.drain(),
        new Promise(r => setTimeout(r, 5000)),
      ])
    } catch {}
    if (auditMachinery.pending() > 0) {
      fastify.log.warn(
        { pending: auditMachinery.pending(), dropped: auditMachinery.stats().dropped },
        '[pg] shutdown with audit rows still buffered — they will be lost',
      )
    }
    await pool.end()
  })
}
