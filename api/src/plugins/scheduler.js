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

  const INIT_SQL = `
    CREATE TABLE IF NOT EXISTS discovery_schedule (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scope TEXT NOT NULL DEFAULT 'global',
      enabled BOOLEAN NOT NULL DEFAULT true,
      interval_mins INTEGER NOT NULL DEFAULT 15,
      last_run_at TIMESTAMPTZ,
      last_run_status TEXT,
      last_run_total INTEGER DEFAULT 0,
      next_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (scope)
    );
    INSERT INTO discovery_schedule (scope, enabled, interval_mins)
    VALUES ('global', false, 15)
    ON CONFLICT (scope) DO NOTHING;
  `

  // ── Read current schedule from Postgres ─────────────────────────────────
  const getSchedule = async () => {
    if (!fastify.pg?.pool) return null
    try {
      const rows = await fastify.pg.query(
        `SELECT * FROM discovery_schedule WHERE scope = 'global' LIMIT 1`
      )
      return rows[0] || null
    } catch { return null }
  }

  // ── Update schedule in Postgres ──────────────────────────────────────────
  const updateSchedule = async (fields) => {
    if (!fastify.pg?.pool) return null
    const setClauses = []
    const values = []
    let idx = 1
    for (const [k, v] of Object.entries(fields)) {
      setClauses.push(`${k} = $${idx++}`)
      values.push(v)
    }
    setClauses.push(`updated_at = now()`)
    values.push('global')
    const rows = await fastify.pg.query(
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
      let allAccounts = []
      if (fastify.pg?.pool) {
        try {
          allAccounts = await fastify.pg.query(
            `SELECT id, provider, name, config FROM cloud_accounts
             WHERE enabled = true ORDER BY provider, name`
          )
        } catch (e) {
          fastify.log.warn(`[Scheduler] Postgres query failed: ${e.message}`)
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

      // ── AWS ──────────────────────────────────────────────────────────────
      if (byProvider.aws?.length) {
        const { scanAWSAccounts } = await import('../routes/discovery.js').catch(() => ({}))
        for (const account of byProvider.aws) {
          try {
            const cfg = account.config
            const creds = cfg.accessKeyId
              ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey || cfg.secretKey }
              : null
            const regions = cfg.regions
              ? cfg.regions.split(',').map(r => r.trim())
              : ['us-east-1']

            // Use the internal scan function directly (bypass HTTP layer)
            const res = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/scan/aws`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ accountId: account.id, regions, ...(creds ? { credentials: creds } : {}) })
            })
            const data = await res.json()
            grandTotal += data.total || 0
            fastify.log.info(`[Scheduler] AWS ${account.name}: ${data.total || 0} resources`)
          } catch (e) {
            errors.push(`AWS/${account.name}: ${e.message}`)
          }
        }
      }

      // ── Azure ─────────────────────────────────────────────────────────────
      if (byProvider.azure?.length) {
        for (const account of byProvider.azure) {
          try {
            const cfg = account.config
            const creds = cfg.clientId && cfg.clientSecret
              ? { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret }
              : null
            const res = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/scan/azure`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accountId: account.id,
                subscriptionId: cfg.subscriptionId,
                ...(creds ? { credentials: creds } : {})
              })
            })
            const data = await res.json()
            grandTotal += data.total || 0
            fastify.log.info(`[Scheduler] Azure ${account.name}: ${data.total || 0} resources`)
          } catch (e) {
            errors.push(`Azure/${account.name}: ${e.message}`)
          }
        }
      }

      // ── GCP ───────────────────────────────────────────────────────────────
      if (byProvider.gcp?.length) {
        for (const account of byProvider.gcp) {
          try {
            const cfg = account.config
            let gcpCreds = null
            if (cfg.serviceAccount) {
              try { gcpCreds = JSON.parse(cfg.serviceAccount) } catch {}
            }
            const res = await fetch(`http://localhost:${process.env.PORT || 3000}/discovery/scan/gcp`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accountId: account.id,
                projectId: cfg.projectId,
                ...(gcpCreds ? { credentials: gcpCreds } : {})
              })
            })
            const data = await res.json()
            grandTotal += data.total || 0
            fastify.log.info(`[Scheduler] GCP ${account.name}: ${data.total || 0} resources`)
          } catch (e) {
            errors.push(`GCP/${account.name}: ${e.message}`)
          }
        }
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
        startTimer()
        return
      }
      await runScheduledScan()
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
    // Ensure table exists
    try {
      await fastify.pg.query(INIT_SQL)
    } catch (err) {
      fastify.log.warn(`[Scheduler] Table init: ${err.message}`)
    }
    await startTimer()
  })

  fastify.addHook('onClose', async () => {
    if (timer) { clearInterval(timer); timer = null }
  })
}