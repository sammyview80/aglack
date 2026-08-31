//! The idempotency record, backed by SQLite. See
//! ../../docs/create-workspace-plan.md and
//! ../../migrations/0001_workspace_creations.sql for the schema this reads
//! and writes.
//!
//! `begin_creation` is the one place that must be race-safe: two requests
//! carrying the same idempotency key can arrive at almost the same instant
//! (e.g. a double-click, or a client retry firing before the first
//! request's response comes back). SQLite's own PRIMARY KEY constraint on
//! `idempotency_key` is what actually prevents two rows for the same key —
//! this code relies on that constraint rejecting the second INSERT, then
//! reads back whichever row won, rather than trying to check-then-insert
//! in application code (which cannot be made race-safe without a database
//! constraint doing the real work).
//!
//! Queries use `sqlx::query()` (checked against the schema at runtime via
//! bound parameters, safe from SQL injection) rather than the `sqlx::query!`
//! compile-time macro: the macro needs a live database reachable at BUILD
//! time (or a checked-in `.sqlx` query cache kept in sync via `cargo sqlx
//! prepare`), which is an extra build-time dependency this project does
//! not need for four small, stable queries. Revisit if this file grows
//! enough queries that compile-time column-name checking earns its cost.

use sqlx::{Row, SqlitePool};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceStatus {
    Creating,
    Ready,
    Failed,
}

impl WorkspaceStatus {
    fn as_db_str(&self) -> &'static str {
        match self {
            WorkspaceStatus::Creating => "creating",
            WorkspaceStatus::Ready => "ready",
            WorkspaceStatus::Failed => "failed",
        }
    }

    fn from_db_str(raw: &str) -> Self {
        match raw {
            "ready" => WorkspaceStatus::Ready,
            "failed" => WorkspaceStatus::Failed,
            // The CHECK constraint in the migration guarantees the column
            // can only ever be one of the three values; "creating" is the
            // only remaining possibility for any other value the database
            // could legally contain.
            _ => WorkspaceStatus::Creating,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRecord {
    pub workspace_id: String,
    pub status: WorkspaceStatus,
    pub container_name: Option<String>,
}

pub struct WorkspaceStore {
    pool: SqlitePool,
}

impl WorkspaceStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Look up an idempotency key. `None` means this key has never been
    /// seen — the caller should proceed to `begin_creation`.
    pub async fn find(&self, idempotency_key: &str) -> Result<Option<WorkspaceRecord>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT workspace_id, status, container_name \
             FROM workspace_creations WHERE idempotency_key = ?",
        )
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|row| WorkspaceRecord {
            workspace_id: row.get("workspace_id"),
            status: WorkspaceStatus::from_db_str(row.get("status")),
            container_name: row.get("container_name"),
        }))
    }

    /// Claim `idempotency_key` for `workspace_id`, or — if another request
    /// already claimed this exact key first — return that pre-existing
    /// record instead. Callers must check `container_name`: `Some` means
    /// someone else already finished (or is finishing) this creation and
    /// no container should be launched; `None` means this call won the
    /// race and must proceed to actually launch one.
    pub async fn begin_creation(
        &self,
        idempotency_key: &str,
        workspace_id: &str,
    ) -> Result<WorkspaceRecord, sqlx::Error> {
        let now = chrono_now();
        let status = WorkspaceStatus::Creating.as_db_str();

        let insert_result = sqlx::query(
            "INSERT INTO workspace_creations \
                (idempotency_key, workspace_id, status, container_name, created_at) \
             VALUES (?, ?, ?, NULL, ?)",
        )
        .bind(idempotency_key)
        .bind(workspace_id)
        .bind(status)
        .bind(&now)
        .execute(&self.pool)
        .await;

        match insert_result {
            Ok(_) => Ok(WorkspaceRecord {
                workspace_id: workspace_id.to_string(),
                status: WorkspaceStatus::Creating,
                container_name: None,
            }),
            // SQLite raises this specific error when the PRIMARY KEY
            // (idempotency_key) already exists — exactly the race this
            // function exists to handle. Any other error is a real
            // failure and must propagate.
            Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
                self.find(idempotency_key)
                    .await?
                    .ok_or(sqlx::Error::RowNotFound)
            }
            Err(other) => Err(other),
        }
    }

    /// Record that `idempotency_key`'s container has finished launching.
    pub async fn mark_ready(
        &self,
        idempotency_key: &str,
        container_name: &str,
    ) -> Result<WorkspaceRecord, sqlx::Error> {
        let status = WorkspaceStatus::Ready.as_db_str();
        sqlx::query(
            "UPDATE workspace_creations SET status = ?, container_name = ? \
             WHERE idempotency_key = ?",
        )
        .bind(status)
        .bind(container_name)
        .bind(idempotency_key)
        .execute(&self.pool)
        .await?;

        self.find(idempotency_key)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Record that `idempotency_key`'s container launch failed. Leaves
    /// `container_name` null. A `Failed` status is what tells
    /// `create_workspace` this key is safe (and necessary) to retry —
    /// without this, a launch failure would leave the row stuck at
    /// `Creating` forever, and a retry would just return that incomplete
    /// record instead of trying again.
    pub async fn mark_failed(&self, idempotency_key: &str) -> Result<WorkspaceRecord, sqlx::Error> {
        let status = WorkspaceStatus::Failed.as_db_str();
        sqlx::query("UPDATE workspace_creations SET status = ? WHERE idempotency_key = ?")
            .bind(status)
            .bind(idempotency_key)
            .execute(&self.pool)
            .await?;

        self.find(idempotency_key)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }
}

/// Current UTC time as an ISO-8601 string. A tiny local helper rather than
/// pulling in a heavier time-handling dependency for one timestamp column.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    seconds.to_string()
}
