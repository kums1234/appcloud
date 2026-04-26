-- ── API key registry ─────────────────────────────────────────────────────────
-- Headless API-key auth was previously a single env-var-derived key. This
-- table replaces that with multiple stored keys, each carrying a scope set
-- and an audit trail. The `APPCLOUD_API_KEY` / `APPCLOUD_ADMIN_API_KEY` env
-- vars are still honoured: on startup, the auth plugin upserts a bootstrap
-- row from each env var (admin scope) so existing deployments continue to
-- work without manual key creation.
--
-- We store SHA-256(plaintext) — not the plaintext itself — because the
-- generated keys are 256-bit-random and therefore not grindable; a fast
-- hash is the right primitive (slow KDF is for low-entropy passwords).
-- The plaintext is shown ONCE at creation and never recoverable.

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-readable identifier, used in audit logs as the actor.
  name          TEXT         NOT NULL UNIQUE,
  -- SHA-256 hex of the plaintext. Looked up on every request, so unique +
  -- indexed. Constant-time comparison happens after the index probe.
  key_hash      TEXT         NOT NULL UNIQUE,
  -- First 12 chars of the plaintext (`ak_<10>…`) — shown in lists so admins
  -- can distinguish keys without revealing them.
  key_prefix    TEXT         NOT NULL,
  -- Scope set. 'admin' implies all lower scopes. 'write' implies 'read'.
  -- Stored as a TEXT[] for flexibility (future per-resource scopes), but
  -- the hierarchy is enforced in the application layer.
  scopes        TEXT[]       NOT NULL,
  -- Bookkeeping.
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by    TEXT,                                   -- principal name of the creator
  last_used_at  TIMESTAMPTZ,
  -- Soft delete. Once revoked, never reused.
  revoked_at    TIMESTAMPTZ,
  -- Marks the env-var bootstrap rows so the auth plugin can refresh them
  -- if the env var changes (rotated key). Hand-created keys have FALSE.
  is_bootstrap  BOOLEAN      NOT NULL DEFAULT false,
  CHECK (array_length(scopes, 1) >= 1)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
  ON api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_active
  ON api_keys (revoked_at) WHERE revoked_at IS NULL;
