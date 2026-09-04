//! SQLite-backed store for `integration_connections` and
//! `workspace_runtime_tokens` (see `../../migrations/0005_integrations.sql`).
//! Pattern mirrors `crate::workspaces::WorkspaceStore` — plain rows in,
//! plain structs out, no business logic here (that lives in `route.rs`).

use sqlx::{Row, SqlitePool};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionStatus {
    Pending,
    Connected,
    NeedsReauth,
    Disconnected,
    Error,
}

impl ConnectionStatus {
    fn as_db_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Connected => "connected",
            Self::NeedsReauth => "needs_reauth",
            Self::Disconnected => "disconnected",
            Self::Error => "error",
        }
    }

    fn from_db_str(value: &str) -> Self {
        match value {
            "connected" => Self::Connected,
            "needs_reauth" => Self::NeedsReauth,
            "disconnected" => Self::Disconnected,
            "error" => Self::Error,
            // Unknown values fall back to `Pending` rather than panicking —
            // a forward-compatible new status added later must not crash
            // an older binary reading the row.
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone)]
pub struct IntegrationConnection {
    pub id: String,
    pub workspace_id: String,
    pub provider_id: String,
    pub connection_name: String,
    pub openconnector_connection_id: Option<String>,
    pub status: ConnectionStatus,
    pub account_label: Option<String>,
    pub last_error: Option<String>,
    /// Epoch-seconds string (see `now_rfc3339`'s doc comment on the
    /// actual format) of the last write to this row — used by the
    /// reconciliation pass to expire a `pending` OAuth connection that
    /// never completed (see `route.rs`'s `list_integrations_route`).
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRuntimeToken {
    pub workspace_id: String,
    pub openconnector_token_id: String,
    pub token_hash: String,
    /// See migration 0005's column comment: plaintext, needs
    /// encryption-at-rest before production.
    pub openconnector_bearer: String,
}

pub struct IntegrationStore {
    pool: SqlitePool,
}

impl IntegrationStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    fn connection_from_row(row: sqlx::sqlite::SqliteRow) -> IntegrationConnection {
        IntegrationConnection {
            id: row.get("id"),
            workspace_id: row.get("workspace_id"),
            provider_id: row.get("provider_id"),
            connection_name: row.get("connection_name"),
            openconnector_connection_id: row.get("openconnector_connection_id"),
            status: ConnectionStatus::from_db_str(row.get::<String, _>("status").as_str()),
            account_label: row.get("account_label"),
            last_error: row.get("last_error"),
            updated_at: row.get("updated_at"),
        }
    }

    /// Insert or replace a `pending` row for `(workspace_id, provider_id)`
    /// — used by the OAuth start route to mark "a popup was just opened
    /// for this provider" BEFORE the OAuth exchange completes. No
    /// OpenConnector connection id yet (that only exists once the
    /// reconciliation pass in `route.rs` observes the connection as
    /// `configured`).
    pub async fn mark_pending(
        &self,
        id: &str,
        workspace_id: &str,
        provider_id: &str,
        connection_name: &str,
    ) -> Result<(), sqlx::Error> {
        self.upsert_connection(
            id,
            workspace_id,
            provider_id,
            connection_name,
            None,
            ConnectionStatus::Pending,
            None,
        )
        .await
    }

    pub async fn find_connection(
        &self,
        workspace_id: &str,
        provider_id: &str,
    ) -> Result<Option<IntegrationConnection>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, workspace_id, provider_id, connection_name, \
             openconnector_connection_id, status, account_label, last_error, updated_at \
             FROM integration_connections WHERE workspace_id = ? AND provider_id = ?",
        )
        .bind(workspace_id)
        .bind(provider_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(Self::connection_from_row))
    }

    pub async fn list_connections(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<IntegrationConnection>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, workspace_id, provider_id, connection_name, \
             openconnector_connection_id, status, account_label, last_error, updated_at \
             FROM integration_connections WHERE workspace_id = ? ORDER BY provider_id",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(Self::connection_from_row).collect())
    }

    /// Insert or replace the row for `(workspace_id, provider_id)` —
    /// connect is idempotent per the `UNIQUE (workspace_id, provider_id)`
    /// constraint, so re-connecting a provider replaces its prior row
    /// rather than erroring.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_connection(
        &self,
        id: &str,
        workspace_id: &str,
        provider_id: &str,
        connection_name: &str,
        openconnector_connection_id: Option<&str>,
        status: ConnectionStatus,
        account_label: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO integration_connections \
             (id, workspace_id, provider_id, connection_name, openconnector_connection_id, \
              status, account_label, last_error, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) \
             ON CONFLICT (workspace_id, provider_id) DO UPDATE SET \
               connection_name = excluded.connection_name, \
               openconnector_connection_id = excluded.openconnector_connection_id, \
               status = excluded.status, \
               account_label = excluded.account_label, \
               last_error = NULL, \
               updated_at = excluded.updated_at",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(provider_id)
        .bind(connection_name)
        .bind(openconnector_connection_id)
        .bind(status.as_db_str())
        .bind(account_label)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_disconnected(
        &self,
        workspace_id: &str,
        provider_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE integration_connections SET status = ?, updated_at = ? \
             WHERE workspace_id = ? AND provider_id = ?",
        )
        .bind(ConnectionStatus::Disconnected.as_db_str())
        .bind(now_rfc3339())
        .bind(workspace_id)
        .bind(provider_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Mark a `pending` row that never completed as `error` with a
    /// human-readable reason — used when the reconciliation pass in
    /// `route.rs` finds a pending row too old to still be a live OAuth
    /// popup (see that function's expiry check).
    pub async fn mark_error(
        &self,
        workspace_id: &str,
        provider_id: &str,
        reason: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE integration_connections SET status = ?, last_error = ?, updated_at = ? \
             WHERE workspace_id = ? AND provider_id = ?",
        )
        .bind(ConnectionStatus::Error.as_db_str())
        .bind(reason)
        .bind(now_rfc3339())
        .bind(workspace_id)
        .bind(provider_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn find_runtime_token(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRuntimeToken>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT workspace_id, openconnector_token_id, token_hash, \
             openconnector_bearer FROM workspace_runtime_tokens WHERE workspace_id = ?",
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| WorkspaceRuntimeToken {
            workspace_id: row.get("workspace_id"),
            openconnector_token_id: row.get("openconnector_token_id"),
            token_hash: row.get("token_hash"),
            openconnector_bearer: row.get("openconnector_bearer"),
        }))
    }

    /// Replace (or create) the workspace's runtime token record. A stale
    /// bearer post-rotation is rejected by `mcp_proxy.rs`'s token_hash
    /// comparison alone (it simply stops matching) — no separate
    /// generation counter needed.
    pub async fn upsert_runtime_token(
        &self,
        workspace_id: &str,
        openconnector_token_id: &str,
        token_hash: &str,
        openconnector_bearer: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO workspace_runtime_tokens \
             (workspace_id, openconnector_token_id, token_hash, \
              openconnector_bearer, rotated_at) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT (workspace_id) DO UPDATE SET \
               openconnector_token_id = excluded.openconnector_token_id, \
               token_hash = excluded.token_hash, \
               openconnector_bearer = excluded.openconnector_bearer, \
               rotated_at = excluded.rotated_at",
        )
        .bind(workspace_id)
        .bind(openconnector_token_id)
        .bind(token_hash)
        .bind(openconnector_bearer)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_runtime_token(&self, workspace_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM workspace_runtime_tokens WHERE workspace_id = ?")
            .bind(workspace_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Record one audit event (see `../../migrations/0007_integration_audit.sql`).
    /// `detail` must never contain a secret — a bearer, a session token,
    /// or a raw upstream error message that might echo one back; callers
    /// pass a short, hand-written, secret-free description only. This
    /// never fails the caller's own request if the write itself fails —
    /// every call site treats audit logging as best-effort (`let _ =
    /// store.record_audit(...).await;`), matching this crate's existing
    /// convention for non-critical side effects (see e.g.
    /// `route.rs`'s revoke-on-disconnect calls).
    #[allow(clippy::too_many_arguments)]
    pub async fn record_audit(
        &self,
        workspace_id: Option<&str>,
        provider_id: Option<&str>,
        event: &str,
        success: bool,
        detail: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO integration_audit (ts, workspace_id, provider_id, event, outcome, detail) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(now_rfc3339())
        .bind(workspace_id)
        .bind(provider_id)
        .bind(event)
        .bind(if success { "success" } else { "failure" })
        .bind(detail)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// Current time as a string, for ordering only (not parsed as a calendar
/// date anywhere yet) — same convention as `workspaces::store::chrono_now`.
fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}
