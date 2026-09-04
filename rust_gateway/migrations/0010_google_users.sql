-- Google OAuth subject (`sub`) owns every workspace. NULL legacy rows are
-- intentionally invisible to Google-authenticated users until migrated.
CREATE TABLE gateway_users (
    google_sub TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
    created_at TEXT NOT NULL
);

ALTER TABLE gateway_sessions ADD COLUMN google_sub TEXT;
ALTER TABLE workspace_creations ADD COLUMN owner_google_sub TEXT;

CREATE INDEX idx_gateway_sessions_google_sub ON gateway_sessions (google_sub);
CREATE INDEX idx_workspace_creations_owner_created
    ON workspace_creations (owner_google_sub, created_at DESC);
