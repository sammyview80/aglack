-- Gateway's own admin session store (see docs/integrations-plan.md's
-- Phase 0a). One admin credential for the whole deployment, matching the
-- v3 plan's staged approach: this closes "anyone who can reach the
-- gateway can do anything" today; per-user accounts (Phase 0b) are
-- separate, later work and reuse this same table's shape.
--
-- Sessions are opaque random tokens, SHA-256-hashed at rest — same
-- pattern as workspace_runtime_tokens.token_hash (see
-- 0005_integrations.sql): a database read alone cannot recover a valid
-- session cookie, and there is no signing secret to leak or rotate.
CREATE TABLE gateway_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX idx_gateway_sessions_expires_at ON gateway_sessions (expires_at);
