-- Audit trail for integration events (connect, disconnect, OAuth start,
-- MCP-proxy rejections). Deliberately holds NO secrets — never a bearer,
-- never a raw session token, never a full error message that might echo
-- one back. `detail` is a short, hand-written, secret-free description.
CREATE TABLE integration_audit (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               TEXT NOT NULL,
    workspace_id     TEXT,
    provider_id      TEXT,
    event            TEXT NOT NULL,
    outcome          TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
    detail           TEXT
);

CREATE INDEX idx_integration_audit_workspace_id ON integration_audit (workspace_id);
CREATE INDEX idx_integration_audit_ts ON integration_audit (ts);
