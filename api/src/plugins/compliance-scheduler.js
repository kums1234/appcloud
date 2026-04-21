// plugins/compliance-scheduler.js
// Automatic scheduled compliance evaluation — runs all configured frameworks
// against the graph on a configurable interval (default 60 minutes).
//
// The schedule is persisted in PostgreSQL (compliance_schedule table).
// Follows the same pattern as plugins/scheduler.js for discovery.
// Each framework is evaluated separately and its last-run state is recorded
// so the UI can show when each was last assessed.

import { loadFrameworks, evaluateFramework } from '../compliance/evaluator.js'

export async function complianceSchedulerPlugin(fastify) {
  let timer = null
  let running = false

  const INIT_SQL = `
    CREATE TABLE IF NOT EXISTS compliance_schedule (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scope TEXT NOT NULL DEFAULT 'global',
      enabled BOOLEAN NOT NULL DEFAULT false,
      interval_mins INTEGER NOT NULL DEFAULT 60,
      last_run_at TIMESTAMPTZ,
      last_run_status TEXT,
      next_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (scope)
    );
    INSERT INTO compliance_schedule (scope, enabled, interval_mins)
    VALUES ('global', false, 60)
    ON CONFLICT (scope) DO NOTHING;

    CREATE TABLE IF NOT EXISTS compliance_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      framework_id TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      status TEXT,
      score INTEGER,
      pass_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      na_count INTEGER DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_compliance_runs_framework
      ON compliance_runs(framework_id, started_at DESC);
  `

  const getSchedule = async () => {
    if (!fastify.pg?.pool) return null
    try {
      const rows = await fastify.pg.query(
        `SELECT * FROM compliance_schedule WHERE scope = 'global' LIMIT 1`
      )
      return rows[0] || null
    } catch { return null }
  }

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
      `UPDATE compliance_schedule SET ${setClauses.join(', ')}
       WHERE scope = $${idx} RETURNING *`,
      values
    )
    return rows[0] || null
  }

  const recordRun = async (frameworkId, result, error) => {
    if (!fastify.pg?.pool) return
    try {
      await fastify.pg.query(
        `INSERT INTO compliance_runs
         (framework_id, started_at, completed_at, status, score,
          pass_count, fail_count, na_count, error)
         VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)`,
        [
          frameworkId,
          result?.startedAt || new Date(),
          error ? 'error' : 'success',
          result?.score ?? null,
          result?.counts?.PASS ?? 0,
          result?.counts?.FAIL ?? 0,
          result?.counts?.NOT_APPLICABLE ?? 0,
          error || null,
        ]
      )
    } catch (e) {
      fastify.log.warn(`[ComplianceScheduler] Failed to record run: ${e.message}`)
    }
  }

  const runScheduledEvaluation = async () => {
    if (running) {
      fastify.log.info('[ComplianceScheduler] Evaluation already running — skipping tick')
      return
    }
    running = true
    fastify.log.info('[ComplianceScheduler] Starting scheduled evaluation of all frameworks')
    await updateSchedule({ last_run_status: 'running', last_run_at: new Date() })

    const frameworks = await loadFrameworks(fastify.pg, fastify.log)
    const { query } = fastify.neo4j
    const results = []

    for (const fw of frameworks) {
      try {
        const result = await evaluateFramework(query, fw)
        await recordRun(fw.id, result, null)
        results.push({
          framework: fw.id,
          score: result.score,
          fail: result.counts.FAIL,
          pass: result.counts.PASS,
        })
        fastify.log.info(
          `[ComplianceScheduler] ${fw.id}: score=${result.score}, pass=${result.counts.PASS}, fail=${result.counts.FAIL}`
        )
      } catch (err) {
        await recordRun(fw.id, null, err.message)
        fastify.log.warn(`[ComplianceScheduler] ${fw.id} failed: ${err.message}`)
        results.push({ framework: fw.id, error: err.message })
      }
    }

    const nextRun = new Date(Date.now() + (await getSchedule())?.interval_mins * 60_000)
    await updateSchedule({
      last_run_status: 'success',
      last_run_at: new Date(),
      next_run_at: nextRun,
    })
    running = false
  }

  const startTimer = async () => {
    if (timer) { clearInterval(timer); timer = null }
    const schedule = await getSchedule()
    if (!schedule?.enabled) {
      fastify.log.info('[ComplianceScheduler] Disabled — no timer started')
      return
    }
    const intervalMs = (schedule.interval_mins || 60) * 60_000
    fastify.log.info(`[ComplianceScheduler] Starting timer: every ${schedule.interval_mins} minutes`)

    let lastInterval = schedule.interval_mins
    timer = setInterval(async () => {
      const current = await getSchedule()
      if (!current?.enabled) {
        fastify.log.info('[ComplianceScheduler] Disabled — stopping timer')
        clearInterval(timer); timer = null
        return
      }
      if (current.interval_mins !== lastInterval) {
        lastInterval = current.interval_mins
        fastify.log.info(`[ComplianceScheduler] Interval changed to ${current.interval_mins}m — restarting timer`)
        clearInterval(timer); timer = null
        startTimer()
        return
      }
      runScheduledEvaluation().catch(e =>
        fastify.log.error(`[ComplianceScheduler] Run failed: ${e.message}`)
      )
    }, intervalMs)
  }

  fastify.decorate('complianceScheduler', {
    getSchedule,
    updateSchedule,
    runNow: runScheduledEvaluation,
    restart: startTimer,
  })

  fastify.addHook('onReady', async () => {
    if (!fastify.pg?.pool) {
      fastify.log.warn('[ComplianceScheduler] Postgres not available — scheduling disabled')
      return
    }
    try {
      await fastify.pg.query(INIT_SQL)
      fastify.log.info('[ComplianceScheduler] Table ready')
    } catch (err) {
      fastify.log.warn(`[ComplianceScheduler] Init failed: ${err.message}`)
      return
    }
    await startTimer()
  })

  fastify.addHook('onClose', async () => {
    if (timer) { clearInterval(timer); timer = null }
  })
}
