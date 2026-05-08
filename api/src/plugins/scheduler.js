// plugins/scheduler.js
// Automatic scheduled discovery — runs scan/all against all configured
// cloud accounts on a configurable interval (default 15 minutes).
//
// The schedule is persisted in PostgreSQL (discovery_schedule table).
// The scheduler starts when the server starts and respects the enabled flag.
// Interval changes take effect on the next tick without a server restart.

import { systemActor, SYSTEM_ACTORS }     from '../utils/audit.js'
import { makeOnceLock }                    from '../utils/once-lock.js'
import { withLeaderLock, SCHEDULER_LOCK_KEYS } from '../utils/leader-lock.js'

export async function schedulerPlugin(fastify) {
  let timer = null
  // Replaces the old `let running = false` flag — that pattern raced
  // across the await between `if (running) return` and `running = true`,
  // letting two concurrent ticks both enter the scan. The promise-based
  // lock holds atomically across awaits — covers the in-process case.
  // For multi-pod (K8s replicas > 1), withLeaderLock adds a Postgres
  // advisory-lock outer gate so only one replica's tick wins per
  // interval. Both layers run together: the in-process lock prevents
  // overlapping ticks within a single replica; the Postgres lock
  // prevents concurrent ticks across replicas.
  const scanLock = makeOnceLock()

  // Phase 1d: discovery_schedule lives in tenant_default. The runner
  // applies api/src/migrations/tenant-schema/005-discovery-schedule.sql
  // to new tenants on creation; the cutover migrates the legacy default
  // tenant's row in place. The scheduler runs on the default tenant's
  // schedule for now — Phase 1e will iterate per-tenant schedules so
  // each tenant can pick its own interval.
  const SCHEDULER_TENANT_SCHEMA = 'tenant_default'
  const tenantPg = () =>
    typeof fastify.pg?.forTenant === 'function'
      ? fastify.pg.forTenant(SCHEDULER_TENANT_SCHEMA)
      : null

  // ── Read current schedule from Postgres ─────────────────────────────────
  const getSchedule = async () => {
    const pg = tenantPg()
    if (!pg) return null
    try {
      const rows = await pg.query(
        `SELECT * FROM discovery_schedule WHERE scope = 'global' LIMIT 1`
      )
      return rows[0] || null
    } catch { return null }
  }

  // ── Update schedule in Postgres ──────────────────────────────────────────
  const updateSchedule = async (fields) => {
    const pg = tenantPg()
    if (!pg) return null
    const setClauses = []
    const values = []
    let idx = 1
    for (const [k, v] of Object.entries(fields)) {
      setClauses.push(`${k} = $${idx++}`)
      values.push(v)
    }
    setClauses.push(`updated_at = now()`)
    values.push('global')
    const rows = await pg.query(
      `UPDATE discovery_schedule SET ${setClauses.join(', ')}
       WHERE scope = $${idx} RETURNING *`,
      values
    )
    return rows[0] || null
  }

  // ── Run a full scan across all configured accounts ───────────────────────
  // The two-layer lock: outer Postgres advisory lock (inter-pod), inner
  // in-process promise lock (intra-pod). The outer one is opportunistic
  // — if Postgres is unavailable it falls through, and we still get the
  // in-process gate. The inner one always runs.
  const runScheduledScan = async () => {
    const outer = await withLeaderLock(fastify.pg?.pool, SCHEDULER_LOCK_KEYS.discoveryScan, async () => {
      return scanLock.run(scan)
    })
    if (outer.skipped === 'leader-elsewhere') {
      fastify.log.info('[Scheduler] another replica holds the leader lock — skipping tick')
    }
    return outer
  }
  const scan = async () => {
    fastify.log.info('[Scheduler] Starting scheduled discovery scan')
    await updateSchedule({ last_run_status: 'running', last_run_at: new Date() })

    const startedAt = Date.now()
    let grandTotal = 0
    const errors = []

    try {
      // Load all enabled cloud accounts grouped by provider
      // Load from Postgres cloud_accounts first, fall back to Neo4j CloudAccount nodes
      //
      // Phase 1b: cloud_accounts lives in `tenant_default` (per the
      // default-tenant cutover). Iterate active tenants from
      // control.tenants and run each through fastify.pg.forTenant(),
      // which sets `search_path = <schema>, public` on the connection.
      // In Phase 1b only `tenant_default` actually has cloud_accounts —
      // other tenants 503 in tenant-context anyway, but the loop shape
      // is forward-compatible with Phase 1c.
      let allAccounts = []
      if (fastify.pg?.pool && typeof fastify.pg.forTenant === 'function') {
        let tenants = []
        try {
          tenants = await fastify.pg.query(
            `SELECT id, slug, schema_name FROM control.tenants WHERE status = 'active'`,
          )
        } catch (e) {
          fastify.log.warn(`[Scheduler] Failed to list tenants: ${e.message}`)
        }
        for (const t of tenants) {
          try {
            const tenantPg = fastify.pg.forTenant(t.schema_name)
            const rows = await tenantPg.query(
              `SELECT id, provider, name, config FROM cloud_accounts
               WHERE enabled = true ORDER BY provider, name`,
            )
            for (const r of rows) {
              // Stamp the tenant on each row so a fan-out scan later
              // can route results back to the right tenant. Phase 1c
              // promotes this to a first-class field on every audit /
              // sync_jobs row.
              allAccounts.push({ ...r, _tenantSchema: t.schema_name, _tenantSlug: t.slug })
            }
          } catch (e) {
            // Tables-not-yet-provisioned for non-default tenants is the
            // common case in 1b — log at debug so we don't drown the
            // scheduler log in expected misses.
            fastify.log.debug?.({ tenant: t.slug, err: e.message }, '[Scheduler] cloud_accounts read skipped for tenant')
          }
        }
      }

      // If no accounts in Postgres, fall back to Neo4j CloudAccount nodes
      if (!allAccounts.length && fastify.neo4j) {
        try {
          const { query } = fastify.neo4j
          const neo4jAccounts = await query(
            `MATCH (a:CloudAccount) RETURN a.provider AS provider, a.name AS name, a.config AS config`
          )
          allAccounts = neo4jAccounts.map(r => ({
            id:       null,
            provider: r.get('provider'),
            name:     r.get('name'),
            config:   (() => { try { return JSON.parse(r.get('config') || '{}') } catch { return {} } })()
          }))
          if (allAccounts.length) {
            fastify.log.info(`[Scheduler] Using ${allAccounts.length} account(s) from Neo4j (Postgres empty)`)
          }
        } catch (e) {
          fastify.log.warn(`[Scheduler] Neo4j fallback failed: ${e.message}`)
        }
      }

      const { decryptConfig } = await import('../utils/encrypt.js')

      // Group by provider
      const byProvider = {}
      for (const row of allAccounts) {
        if (!byProvider[row.provider]) byProvider[row.provider] = []
        byProvider[row.provider].push({ ...row, config: decryptConfig(row.config || {}) })
      }

      // Per-provider scanner function. Each handles one account at a
      // time (the cloud APIs themselves rate-limit cross-account
      // concurrency anyway), but the THREE providers run in parallel —
      // AWS+Azure+GCP no longer serialize at 30s+20s+40s = 90s per
      // tick. The Promise.all aggregates each provider's local
      // grandTotal/errors back into the outer accumulators.
      // Base URL for the in-process discovery routes. Default points
      // at this same pod's loopback (PORT env). Override via
      // APPCLOUD_INTERNAL_BASE_URL when:
      //   - The API binds to a non-default port the scheduler can't
      //     guess (uncommon — `PORT` should be set consistently).
      //   - You want the scheduler to call a *different* replica's
      //     handler (typically a bad idea — the leader-lock already
      //     gates one tick per replica via Postgres advisory lock).
      const aiBaseUrl = process.env.APPCLOUD_INTERNAL_BASE_URL
        || `http://localhost:${process.env.PORT || 3000}`
      // Per-tick request id — the scheduler isn't a request handler so
      // there's no inbound `req.id`; generate one and attach it to
      // every internal fetch + log line so a single tick's work is
      // grep-able across the discovery scan + audit + downstream
      // structured logs. Server.js's `requestIdHeader: 'x-request-id'`
      // picks this up on the receiving handler.
      const tickId = `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      fastify.log.info({ tickId }, '[Scheduler] beginning tick')
      // Wall-clock cap on each provider's scan via AbortSignal. Without
      // a timeout, a hung scanner blocks the entire scheduler tick (and
      // every subsequent tick, since runScheduledScan is gated on the
      // promise lock). 10 minutes is generous for a real cloud scan
      // and decisive enough that an operator notices.
      const SCHED_FETCH_TIMEOUT_MS = parseInt(process.env.APPCLOUD_SCHED_FETCH_TIMEOUT_MS || '600000', 10)
      const fetchWithTimeout = (url, init) => fetch(url, {
        ...init,
        headers: { ...(init?.headers || {}), 'x-request-id': tickId },
        signal:  AbortSignal.timeout(SCHED_FETCH_TIMEOUT_MS),
      })
      async function scanAws(account) {
        const cfg = account.config
        const creds = cfg.accessKeyId
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey || cfg.secretKey }
          : null
        const regions = cfg.regions
          ? cfg.regions.split(',').map(r => r.trim())
          : ['us-east-1']
        const res = await fetchWithTimeout(`${aiBaseUrl}/discovery/scan/aws`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: account.id, regions, ...(creds ? { credentials: creds } : {}) }),
        })
        return res.json()
      }
      async function scanAzure(account) {
        const cfg = account.config
        const creds = cfg.clientId && cfg.clientSecret
          ? { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret }
          : null
        const res = await fetchWithTimeout(`${aiBaseUrl}/discovery/scan/azure`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: account.id, subscriptionId: cfg.subscriptionId, ...(creds ? { credentials: creds } : {}) }),
        })
        return res.json()
      }
      async function scanGcp(account) {
        const cfg = account.config
        let gcpCreds = null
        if (cfg.serviceAccount) { try { gcpCreds = JSON.parse(cfg.serviceAccount) } catch {} }
        const res = await fetchWithTimeout(`${aiBaseUrl}/discovery/scan/gcp`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: account.id, projectId: cfg.projectId, ...(gcpCreds ? { credentials: gcpCreds } : {}) }),
        })
        return res.json()
      }

      const PROVIDERS = [
        { name: 'aws',   accounts: byProvider.aws   ?? [], fn: scanAws   },
        { name: 'azure', accounts: byProvider.azure ?? [], fn: scanAzure },
        { name: 'gcp',   accounts: byProvider.gcp   ?? [], fn: scanGcp   },
      ]

      const perProviderResults = await Promise.all(
        PROVIDERS.filter(p => p.accounts.length > 0).map(async (p) => {
          let provTotal = 0
          const provErrors = []
          for (const account of p.accounts) {
            try {
              const data = await p.fn(account)
              provTotal += data.total || 0
              fastify.log.info(`[Scheduler] ${p.name.toUpperCase()} ${account.name}: ${data.total || 0} resources`)
            } catch (e) {
              provErrors.push(`${p.name.toUpperCase()}/${account.name}: ${e.message}`)
              fastify.log.error(
                { provider: p.name, accountId: account.id, accountName: account.name, err: e.message, code: e.code },
                `[Scheduler] ${p.name.toUpperCase()} scan failed`,
              )
            }
          }
          return { provTotal, provErrors }
        }),
      )
      for (const r of perProviderResults) {
        grandTotal += r.provTotal
        errors.push(...r.provErrors)
      }

      const duration = Date.now() - startedAt
      const status = errors.length === 0 ? 'success' : grandTotal > 0 ? 'partial' : 'error'
      fastify.log.info(`[Scheduler] Scan complete: ${grandTotal} resources in ${duration}ms, ${errors.length} errors`)

      // Record result and schedule next run
      const schedule = await getSchedule()
      const intervalMs = (schedule?.interval_mins || 15) * 60 * 1000

      // ── Auto-create: run suggest → apply-all if enabled ─────────────────
      let autoCreateTotal = 0
      if (schedule?.auto_create) {
        const minScore = schedule.auto_create_min_score ?? 70
        fastify.log.info(`[Scheduler] Auto-create enabled — running suggest (minScore=${minScore})`)
        try {
          // Fetch suggestions
          const suggestRes = await fetch(
            `http://localhost:${process.env.PORT || 3000}/discovery/suggest?minScore=${minScore}&limit=200`
          )
          const suggestData = await suggestRes.json()
          const suggestions = Array.isArray(suggestData)
            ? suggestData
            : (suggestData.suggestions || [])

          if (suggestions.length > 0) {
            // Build actions — take the top suggestion per resource
            const actions = suggestions
              .map(item => item.suggestions?.[0])
              .filter(Boolean)
              .filter(s => (s.score || 0) >= minScore)

            fastify.log.info(`[Scheduler] Auto-create: ${actions.length} action(s) to apply`)

            if (actions.length > 0) {
              const applyRes = await fetch(
                `http://localhost:${process.env.PORT || 3000}/discovery/suggest/apply-all`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ actions }),
                }
              )
              const applyData = await applyRes.json()
              autoCreateTotal = (applyData.linked || 0) +
                                (applyData.componentsCreated || 0) +
                                (applyData.applicationsCreated || 0)

              fastify.log.info(
                `[Scheduler] Auto-create complete: ` +
                `${applyData.linked || 0} linked, ` +
                `${applyData.componentsCreated || 0} components created, ` +
                `${applyData.applicationsCreated || 0} applications created`
              )

              fastify.pg?.audit?.(systemActor(SYSTEM_ACTORS.schedulerAutoCreate), 'auto-create', 'CloudAccount', 'all',
                'Auto-Create after Scheduled Scan', {
                  linked:               applyData.linked,
                  componentsCreated:    applyData.componentsCreated,
                  applicationsCreated:  applyData.applicationsCreated,
                  minScore,
                  errors:               applyData.errors,
                }).catch(() => {})
            }
          } else {
            fastify.log.info('[Scheduler] Auto-create: no suggestions above threshold')
          }
        } catch (e) {
          fastify.log.error(`[Scheduler] Auto-create failed: ${e.message}`)
          errors.push(`AutoCreate: ${e.message}`)
        }
      }

      await updateSchedule({
        last_run_status:       status,
        last_run_total:        grandTotal,
        last_auto_create_total: autoCreateTotal,
        last_run_at:           new Date(),
        next_run_at:           new Date(Date.now() + intervalMs),
      })

      fastify.pg?.audit?.(systemActor(SYSTEM_ACTORS.schedulerDiscoveryScan), 'scan', 'CloudAccount', 'all', 'Scheduled Scan',
        { grandTotal, errors, duration, providers: Object.keys(byProvider) })
        .catch(() => {})

    } catch (err) {
      fastify.log.error(`[Scheduler] Scan failed: ${err.message}`)
      await updateSchedule({ last_run_status: 'error', last_run_at: new Date() })
    }
    // Lock release happens automatically in scanLock.run's finally block.
  }

  // ── Start/restart the timer ──────────────────────────────────────────────
  const startTimer = async () => {
    if (timer) { clearInterval(timer); timer = null }
    const schedule = await getSchedule()
    if (!schedule?.enabled) {
      fastify.log.info('[Scheduler] Auto-discovery disabled')
      return
    }
    const intervalMs = Math.max(5, schedule.interval_mins) * 60 * 1000
    fastify.log.info(`[Scheduler] Auto-discovery enabled — every ${schedule.interval_mins} minutes`)

    // Set next_run_at on startup
    await updateSchedule({ next_run_at: new Date(Date.now() + intervalMs) })

    timer = setInterval(async () => {
      // Top-level try/catch so a thrown error from getSchedule, the
      // recursive startTimer(), or runScheduledScan never bubbles up
      // as an unhandled rejection — Node would log it but the next
      // tick still fires, just with no structured context. With this
      // in place the operator gets `[Scheduler] tick failed` plus the
      // error code on every transient blip.
      try {
        // Re-read schedule each tick so interval changes apply without restart
        const current = await getSchedule()
        if (!current?.enabled) {
          fastify.log.info('[Scheduler] Disabled — stopping timer')
          clearInterval(timer); timer = null
          return
        }
        // If interval changed, restart timer with new interval
        const currentMs = current.interval_mins * 60 * 1000
        if (Math.abs(currentMs - intervalMs) > 1000) {
          fastify.log.info(`[Scheduler] Interval changed to ${current.interval_mins}m — restarting timer`)
          await startTimer()
          return
        }
        await runScheduledScan()
      } catch (err) {
        fastify.log.warn(
          { err: err.message, code: err.code },
          '[Scheduler] periodic tick failed — next tick will retry',
        )
      }
    }, intervalMs)
  }

  // ── Expose schedule control on the fastify instance ─────────────────────
  fastify.decorate('scheduler', {
    getSchedule,
    updateSchedule,
    runNow: runScheduledScan,
    restart: startTimer,
  })

  // ── Start after server is ready ──────────────────────────────────────────
  fastify.addHook('onReady', async () => {
    if (!fastify.pg?.pool) {
      fastify.log.warn('[Scheduler] PostgreSQL not available — scheduler disabled')
      return
    }
    // Phase 1d: discovery_schedule is provisioned by the runner (for
    // new tenants) and by postgres-init/18-tables-cutover.sql (for the
    // default tenant). No init SQL here anymore — the table existence
    // is the runner's responsibility.
    await startTimer()
  })

  fastify.addHook('onClose', async () => {
    if (timer) { clearInterval(timer); timer = null }
  })
}