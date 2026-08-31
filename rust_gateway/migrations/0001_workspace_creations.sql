-- One row per workspace name ever requested via POST /workspaces.
-- See ../docs/create-workspace-plan.md for the "why".
--
-- idempotency_key: the value that identifies one logical creation attempt,
--   reused across retries/refreshes of that same attempt. Currently the
--   caller-supplied workspace `name` (see route.rs) — two requests for the
--   same name are treated as the same request, so a page refresh or retry
--   never creates a second container. Column name kept generic in case the
--   actual idempotency source changes later (e.g. a dedicated key once the
--   frontend sends one) without needing another migration.
-- workspace_id: the workspace this key resulted in. Set as soon as the key
--   is first seen (before the container finishes creating) so a retry that
--   arrives mid-creation still finds a row and can be told "already in
--   progress" rather than racing a second container into existence.
-- status: 'creating' | 'ready' | 'failed'. A retry while status is
--   'creating' must not start a second container.
-- container_name: the Docker container name once creation has started;
--   null until then.
-- created_at: when this key was first seen.
CREATE TABLE workspace_creations (
    idempotency_key TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'failed')),
    container_name TEXT,
    created_at TEXT NOT NULL
);
