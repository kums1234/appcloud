-- postgres-init/06-ai-jobs.sql
-- Async AI job queue for cloud AI planning endpoints.
-- Matches the enqueueJob / completeJob / failJob helpers in routes/ai.js.

CREATE TABLE IF NOT EXISTS ai_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT        NOT NULL,         -- plan-decommission | plan-change | governance-advice | drift-report
  input         JSONB       NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  result        TEXT,                          -- JSON string (cloud AI response)
  error         TEXT,
  actor         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ai_jobs_status_idx ON ai_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_jobs_actor_idx  ON ai_jobs (actor, created_at DESC);

-- Auto-expire completed jobs after 30 days (keep failed for review)
-- Run as a periodic job or pg_cron if available:
-- DELETE FROM ai_jobs WHERE status = 'done' AND completed_at < NOW() - INTERVAL '30 days';