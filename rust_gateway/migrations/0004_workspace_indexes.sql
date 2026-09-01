-- workspace_id: plain index. Every per-workspace proxy route (onboarding/
-- agent-seeder/hermes-webui/desktop) resolves via `WHERE workspace_id = ?`
-- on every proxied request; without an index this is a full table scan.
-- NOT unique: begin_creation only dedupes on idempotency_key, not
-- workspace_id, so two rows can legally share a workspace_id. A UNIQUE
-- index would brick connect() at migration time on legally-reachable data.
CREATE INDEX idx_workspace_creations_workspace_id
    ON workspace_creations (workspace_id);

-- created_at: supports GET /workspaces' `ORDER BY created_at DESC, rowid DESC`.
CREATE INDEX idx_workspace_creations_created_at
    ON workspace_creations (created_at);
