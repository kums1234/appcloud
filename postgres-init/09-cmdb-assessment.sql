-- ── CMDB assessment state ──────────────────────────────────────────────────
-- Single-row table tracking whether the graph has accepted new data since
-- the last /cmdb/assessment run. Scanners and the ServiceNow connector
-- set `dirty=true` after their ingest completes (see plugins/cmdb-assessment
-- -scheduler.js and routes/discovery.js).
--
-- The scheduler ticks every CMDB_ASSESSMENT_INTERVAL_MS (default 60s). On
-- each tick it runs an assessment if `dirty=true`, OR if `last_run_at` is
-- older than CMDB_ASSESSMENT_BACKSTOP_MS (default 30min). After a run it
-- clears `dirty` and updates `last_run_at` + `last_episode_id`.
--
-- Additionally we keep a short history of run metadata for operability
-- (how many CIs, how many matched, duration) — lives in
-- `cmdb_assessment_runs` with an index on started_at DESC.

CREATE TABLE IF NOT EXISTS cmdb_assessment_state (
  scope         TEXT PRIMARY KEY,
  dirty         BOOLEAN NOT NULL DEFAULT false,
  dirty_since   TIMESTAMPTZ,
  last_run_at   TIMESTAMPTZ,
  last_episode_id TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO cmdb_assessment_state (scope, dirty, dirty_since)
VALUES ('global', true, now())
ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS cmdb_assessment_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      TEXT NOT NULL,
  trigger         TEXT NOT NULL,        -- 'dirty','backstop','manual','scanner-hook'
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  cis_total       INTEGER,
  infra_total     INTEGER,
  matched_count   INTEGER,
  unmatched_count INTEGER,
  outcome         TEXT NOT NULL,        -- 'ok','error'
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_cmdb_assessment_runs_started
  ON cmdb_assessment_runs(started_at DESC);
