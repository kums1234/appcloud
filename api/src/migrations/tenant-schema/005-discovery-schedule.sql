-- ── Per-tenant discovery_schedule (Phase 1d) ─────────────────────────────────
-- Auto-scan schedule per tenant. Each tenant has its own 'global' row
-- (plus any per-cloud-account overrides) — the scheduler now iterates
-- tenants and reads each one's schedule via fastify.pg.forTenant().

CREATE TABLE IF NOT EXISTS discovery_schedule (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                  TEXT         NOT NULL DEFAULT 'global',
  enabled                BOOLEAN      NOT NULL DEFAULT true,
  interval_mins          INTEGER      NOT NULL DEFAULT 15,
  last_run_at            TIMESTAMPTZ,
  last_run_status        TEXT,
  last_run_total         INTEGER      DEFAULT 0,
  next_run_at            TIMESTAMPTZ,
  auto_create            BOOLEAN      NOT NULL DEFAULT false,
  auto_create_min_score  INTEGER      NOT NULL DEFAULT 70,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (scope)
);

-- Default 'global' row. Disabled until the operator opts in.
INSERT INTO discovery_schedule (scope, enabled, interval_mins)
VALUES ('global', false, 15)
ON CONFLICT (scope) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_discovery_schedule_scope ON discovery_schedule(scope);
