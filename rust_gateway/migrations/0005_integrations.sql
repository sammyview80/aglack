-- Third-party service integrations (see docs/integrations-plan.md and
-- docs/integrations-poc-findings.md).
--
-- Scope of THIS migration: the minimum needed for one connection per
-- workspace per provider and one runtime token per workspace, enough to
-- exercise the MCP tenancy proxy end to end. Deliberately NOT included
-- yet (tracked as follow-up work, see integrations-plan.md's outbox/audit
-- design): integration_outbox (durable rotation steps), integration_audit
-- (action-level audit log), oauth state binding columns for the real
-- authorization-code flow (this slice only exercises api_key auth, per
-- the POC). Add those in a later migration rather than half-building them
-- here.

CREATE TABLE integration_connections (
    id                          TEXT PRIMARY KEY,
    workspace_id                TEXT NOT NULL,
    provider_id                 TEXT NOT NULL,
    connection_name             TEXT NOT NULL,
    openconnector_connection_id TEXT,
    status                      TEXT NOT NULL CHECK (
        status IN ('pending', 'connected', 'needs_reauth', 'disconnected', 'error')
    ),
    account_label                TEXT,
    last_error                   TEXT,
    created_at                   TEXT NOT NULL,
    updated_at                   TEXT NOT NULL,
    UNIQUE (workspace_id, provider_id)
);

CREATE TABLE workspace_runtime_tokens (
    workspace_id           TEXT PRIMARY KEY,
    generation              INTEGER NOT NULL,
    openconnector_token_id TEXT NOT NULL,
    -- sha256 hex digest of the bearer handed to the workspace container —
    -- compared against the container's `Authorization` header to
    -- authenticate the inbound MCP request (see mcp_proxy.rs).
    token_hash              TEXT NOT NULL,
    -- The plaintext OpenConnector runtime token this workspace's
    -- container-facing bearer maps to, needed to forward to
    -- OpenConnector's own /mcp (a DIFFERENT credential from
    -- token_hash's subject — see mcp_proxy.rs's module doc). Stored in
    -- plaintext in this slice; encryption-at-rest for this column is
    -- required before production, same gap the integrations plan already
    -- calls out for provider tokens generally (docs/integrations-plan.md's
    -- security model). Do not ship this table as-is without addressing it.
    openconnector_bearer    TEXT NOT NULL,
    rotated_at               TEXT NOT NULL
);

CREATE TABLE integration_agent_enablement (
    workspace_id TEXT NOT NULL,
    agent_slug   TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (workspace_id, agent_slug)
);

CREATE INDEX idx_integration_connections_workspace_id ON integration_connections (workspace_id);
