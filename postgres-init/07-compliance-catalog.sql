-- postgres-init/07-compliance-catalog.sql
-- Central storage for compliance framework definitions.
--
-- Authoritative source for benchmarks, controls, and per-organisation overrides.
-- Built-in controls are seeded from JSON files at startup; imported/custom controls
-- and all overrides persist across re-seeds.

-- ── Benchmarks (frameworks) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS benchmarks (
  id          TEXT PRIMARY KEY,                 -- 'cis-aws-v3', 'cis-azure-v2', 'custom', ...
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  provider    TEXT NOT NULL,                    -- aws | azure | gcp | custom | other
  description TEXT,
  reference   TEXT,                             -- public URL
  source      TEXT NOT NULL,                    -- builtin | imported | custom
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_benchmarks_provider ON benchmarks(provider);
CREATE INDEX IF NOT EXISTS idx_benchmarks_source   ON benchmarks(source);

-- ── Controls (individual test cases) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS controls (
  id             TEXT NOT NULL,                 -- 'CIS-AWS-1.4' or 'CUSTOM-001'
  benchmark_id   TEXT NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  section        TEXT,
  section_title  TEXT,
  level          INTEGER,
  title          TEXT NOT NULL,
  description    TEXT,
  rationale      TEXT,
  severity       TEXT NOT NULL,                 -- CRITICAL | HIGH | MEDIUM | LOW
  rating         INTEGER,                       -- 1-10
  automated      BOOLEAN NOT NULL DEFAULT true,
  evaluator      TEXT NOT NULL,                 -- cypher | form | manual
  resource_type  TEXT,                          -- Neo4j label or provider:type
  query          TEXT,                          -- cypher query (built-ins only)
  params         JSONB NOT NULL DEFAULT '{}',
  form_rule      JSONB,                         -- structured form rule (evaluator=form)
  remediation    JSONB NOT NULL DEFAULT '{}',   -- { summary, steps[], references[] }
  source         TEXT NOT NULL,                 -- builtin | imported | custom
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (benchmark_id, id)
);

CREATE INDEX IF NOT EXISTS idx_controls_benchmark ON controls(benchmark_id);
CREATE INDEX IF NOT EXISTS idx_controls_enabled   ON controls(benchmark_id) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_controls_source    ON controls(source);

-- ── Per-org overrides for built-in controls ──────────────────────────────────
-- null fields mean "inherit from the built-in definition". The disabled flag
-- lets admins switch off individual controls without editing the JSON.
CREATE TABLE IF NOT EXISTS control_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_id  TEXT NOT NULL,
  control_id    TEXT NOT NULL,
  disabled      BOOLEAN NOT NULL DEFAULT false,
  severity      TEXT,                           -- null = inherit
  rating        INTEGER,                        -- null = inherit
  remediation   JSONB,                          -- null = inherit
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (benchmark_id, control_id)
);
