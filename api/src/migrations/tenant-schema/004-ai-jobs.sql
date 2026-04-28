-- ── Per-tenant ai_jobs (Phase 1d) ────────────────────────────────────────────
-- Async AI job queue (plan-decommission, plan-change, governance-advice,
-- drift-report). Each tenant gets its own queue.

CREATE TABLE IF NOT EXISTS ai_jobs (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT         NOT NULL,
  input         JSONB        NOT NULL DEFAULT '{}',
  status        TEXT         NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'done', 'failed')),
  result        TEXT,
  error         TEXT,
  actor         TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ai_jobs_status_idx ON ai_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_jobs_actor_idx  ON ai_jobs (actor, created_at DESC);
