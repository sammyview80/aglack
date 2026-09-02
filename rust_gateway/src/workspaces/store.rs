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
    /// Host port this workspace's wrapper (Hermes WebUI) is published on
    /// — `None` until the container has actually launched (set together
    /// with `container_name` in `mark_ready`). See
    /// `../../migrations/0002_add_host_port.sql`.
    pub host_port: Option<i64>,
    /// Host port this workspace's webtop desktop (nginx fronting KasmVNC)
    /// is published on — same lifecycle as `host_port`, set together with
    /// it. See `../../migrations/0003_add_desktop_port.sql`.
    pub desktop_port: Option<i64>,
}

/// One row of `WorkspaceStore::list`'s result — deliberately a separate,
/// smaller type from `WorkspaceRecord` rather than reusing it: `name` is
/// meaningful to a caller (it's `idempotency_key`, renamed — see
/// `../../docs/list-workspaces-plan.md`), while `idempotency_key` itself
/// (the column) is an internal retry-mechanism detail no listing consumer
/// needs. Keeping the two types distinct means an internal-only column
/// added to `workspace_creations` later can't leak into the list response
/// by accident.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceListItem {
    pub workspace_id: String,
    pub name: String,
    pub status: WorkspaceStatus,
    pub host_port: Option<i64>,
    pub desktop_port: Option<i64>,
    pub created_at: String,
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
    pub async fn find(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<WorkspaceRecord>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT workspace_id, status, container_name, host_port, desktop_port \
             FROM workspace_creations WHERE idempotency_key = ?",
        )
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Self::record_from_row))
    }

    /// Look up a workspace by its `workspace_id` (NOT the idempotency
    /// key/name — see `mod.rs`, these are different values). Used by the
    /// onboarding/hermes-webui/desktop proxy routes to validate a
    /// caller-supplied id and find which host port to forward to.
    /// `workspace_id` is not the table's primary key (`idempotency_key`
    /// is), but is unique in practice: it is a freshly generated UUID per
    /// row (see `mod.rs::create_workspace`) and never reused.
    pub async fn find_by_workspace_id(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRecord>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT workspace_id, status, container_name, host_port, desktop_port \
             FROM workspace_creations WHERE workspace_id = ?",
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Self::record_from_row))
    }

    /// Every workspace the store currently believes is `Ready` AND has a
    /// real `container_name` — the exact set `daemon_watch.rs` needs to
    /// know "which containers should be running right now" after a
    /// Docker daemon down→up transition. Deliberately excludes
    /// `Creating`/`Failed` rows: those were never a working container
    /// (or the last attempt explicitly failed), so auto-starting them
    /// would resurrect something that was never meant to run, not
    /// recover something that legitimately went down with the daemon.
    pub async fn list_ready_with_container(&self) -> Result<Vec<WorkspaceRecord>, sqlx::Error> {
        let status = WorkspaceStatus::Ready.as_db_str();
        let rows = sqlx::query(
            "SELECT workspace_id, status, container_name, host_port, desktop_port \
             FROM workspace_creations \
             WHERE status = ? AND container_name IS NOT NULL",
        )
        .bind(status)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(Self::record_from_row).collect())
    }

    /// List workspaces, newest first, for a listing/dashboard caller. A
    /// single `SELECT ... ORDER BY ... LIMIT ... OFFSET ...` — no per-row
    /// follow-up query, no container/network call (see
    /// `../../docs/list-workspaces-plan.md` for why that matters). Returns
    /// exactly `limit` rows or fewer (fewer only when there aren't that
    /// many rows left past `offset`); the caller is responsible for
    /// validating `limit`/`offset` before calling this (see `route.rs`) —
    /// this method trusts its inputs and does not re-clamp them.
    ///
    /// Ordered by `created_at DESC, rowid DESC`: `created_at` has only
    /// second resolution (see `chrono_now` below), so two rows created
    /// within the same second would otherwise tie with no defined order.
    /// SQLite's implicit `rowid` increases monotonically with insertion
    /// order and needs no schema change, so it's used as a free, exact
    /// tie-breaker — newest-inserted-first even within the same second.
    pub async fn list(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<WorkspaceListItem>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT workspace_id, idempotency_key, status, host_port, desktop_port, created_at \
             FROM workspace_creations \
             ORDER BY created_at DESC, rowid DESC \
             LIMIT ? OFFSET ?",
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|row| WorkspaceListItem {
                workspace_id: row.get("workspace_id"),
                name: row.get("idempotency_key"),
                status: WorkspaceStatus::from_db_str(row.get("status")),
                host_port: row.get::<Option<i64>, _>("host_port"),
                desktop_port: row.get::<Option<i64>, _>("desktop_port"),
                created_at: row.get("created_at"),
            })
            .collect())
    }

    fn record_from_row(row: sqlx::sqlite::SqliteRow) -> WorkspaceRecord {
        WorkspaceRecord {
            workspace_id: row.get("workspace_id"),
            status: WorkspaceStatus::from_db_str(row.get("status")),
            container_name: row.get("container_name"),
            host_port: row.get::<Option<i64>, _>("host_port"),
            desktop_port: row.get::<Option<i64>, _>("desktop_port"),
        }
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
                host_port: None,
                desktop_port: None,
            }),
            // SQLite raises this specific error when the PRIMARY KEY
            // (idempotency_key) already exists — exactly the race this
            // function exists to handle. Any other error is a real
            // failure and must propagate.
            Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => self
                .find(idempotency_key)
                .await?
                .ok_or(sqlx::Error::RowNotFound),
            Err(other) => Err(other),
        }
    }

    /// Record that `idempotency_key`'s container has finished launching,
    /// including both host ports its wrapper and desktop were published
    /// on (needed by the onboarding/hermes-webui/desktop proxy routes to
    /// forward to this specific workspace). Always set together in one
    /// UPDATE — a `Ready` row's `host_port` and `desktop_port` are both
    /// `Some` or both `None`, never a mix; every reader relies on that
    /// invariant (see e.g. `resolve.rs`) rather than re-checking it.
    pub async fn mark_ready(
        &self,
        idempotency_key: &str,
        container_name: &str,
        host_port: u16,
        desktop_port: u16,
    ) -> Result<WorkspaceRecord, sqlx::Error> {
        let status = WorkspaceStatus::Ready.as_db_str();
        sqlx::query(
            "UPDATE workspace_creations \
             SET status = ?, container_name = ?, host_port = ?, desktop_port = ? \
             WHERE idempotency_key = ?",
        )
        .bind(status)
        .bind(container_name)
        .bind(i64::from(host_port))
        .bind(i64::from(desktop_port))
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

    /// Drop the row for `workspace_id`. Returns `true` if a row was
    /// actually deleted, `false` if no such workspace exists. Does not
    /// touch Docker — `delete_workspace` in `mod.rs` is the one place
    /// that pairs this with `ContainerLauncher::remove`.
    pub async fn delete_by_workspace_id(&self, workspace_id: &str) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("DELETE FROM workspace_creations WHERE workspace_id = ?")
            .bind(workspace_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Same effect as `mark_ready`, keyed by `workspace_id` instead of
    /// `idempotency_key` — for `diagnosis.rs`, the only caller that ever
    /// needs to update a row's status after a stop/start recovery cycle
    /// and only has `workspace_id` in hand (every OTHER writer of status —
    /// `create_workspace_route`'s `name`, etc. — already has the
    /// idempotency key from its own request shape, so this exists as a
    /// distinct method rather than replacing `mark_ready` everywhere).
    /// `Ok(None)` means no row for `workspace_id` (the row was deleted
    /// concurrently — an accepted small race, same tolerance every other
    /// per-workspace route already has; see `resolve.rs`'s module doc).
    pub async fn mark_ready_by_workspace_id(
        &self,
        workspace_id: &str,
        container_name: &str,
        host_port: u16,
        desktop_port: u16,
    ) -> Result<Option<WorkspaceRecord>, sqlx::Error> {
        let status = WorkspaceStatus::Ready.as_db_str();
        sqlx::query(
            "UPDATE workspace_creations \
             SET status = ?, container_name = ?, host_port = ?, desktop_port = ? \
             WHERE workspace_id = ?",
        )
        .bind(status)
        .bind(container_name)
        .bind(i64::from(host_port))
        .bind(i64::from(desktop_port))
        .bind(workspace_id)
        .execute(&self.pool)
        .await?;

        self.find_by_workspace_id(workspace_id).await
    }

    /// Same effect as `mark_failed`, keyed by `workspace_id` — see
    /// `mark_ready_by_workspace_id`'s doc comment for why this distinct
    /// method exists.
    pub async fn mark_failed_by_workspace_id(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRecord>, sqlx::Error> {
        let status = WorkspaceStatus::Failed.as_db_str();
        sqlx::query("UPDATE workspace_creations SET status = ? WHERE workspace_id = ?")
            .bind(status)
            .bind(workspace_id)
            .execute(&self.pool)
            .await?;

        self.find_by_workspace_id(workspace_id).await
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

#[cfg(test)]
mod list_tests {
    use super::super::test_support::temp_store;
    use super::*;

    #[tokio::test]
    async fn list_returns_empty_for_a_store_with_no_workspaces() {
        let store = temp_store().await;
        let result = store.list(50, 0).await.expect("list succeeds");
        assert!(result.is_empty());
    }

    /// `idempotency_key` (the caller-supplied name) must surface as `name`
    /// on the list item — see module doc — not as its own raw column.
    #[tokio::test]
    async fn list_surfaces_idempotency_key_as_name() {
        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "workspace-id-1")
            .await
            .expect("begin_creation succeeds");

        let result = store.list(50, 0).await.expect("list succeeds");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "my-workspace");
        assert_eq!(result[0].workspace_id, "workspace-id-1");
    }

    /// Newest-inserted row first, even when `created_at` (second
    /// resolution) ties across rows inserted in the same test run — the
    /// `rowid DESC` tie-break is what actually guarantees this (see
    /// `list`'s doc comment).
    #[tokio::test]
    async fn list_orders_newest_inserted_first() {
        let store = temp_store().await;
        store
            .begin_creation("first", "id-first")
            .await
            .expect("begin_creation succeeds");
        store
            .begin_creation("second", "id-second")
            .await
            .expect("begin_creation succeeds");
        store
            .begin_creation("third", "id-third")
            .await
            .expect("begin_creation succeeds");

        let result = store.list(50, 0).await.expect("list succeeds");
        let names: Vec<&str> = result.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["third", "second", "first"]);
    }

    #[tokio::test]
    async fn list_respects_limit_and_offset() {
        let store = temp_store().await;
        for name in ["a", "b", "c", "d"] {
            store
                .begin_creation(name, &format!("id-{name}"))
                .await
                .expect("begin_creation succeeds");
        }

        // Inserted a, b, c, d -> ordered newest-first: d, c, b, a.
        let first_page = store.list(2, 0).await.expect("list succeeds");
        let first_names: Vec<&str> = first_page.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(first_names, vec!["d", "c"]);

        let second_page = store.list(2, 2).await.expect("list succeeds");
        let second_names: Vec<&str> = second_page.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(second_names, vec!["b", "a"]);
    }

    /// A `Ready` row's ports must come through unchanged — proves `list`
    /// reads the same columns `find`/`mark_ready` already trust, not a
    /// stale or re-derived value.
    #[tokio::test]
    async fn list_includes_ports_for_ready_workspaces() {
        let store = temp_store().await;
        store
            .begin_creation("ready-ws", "id-ready")
            .await
            .expect("begin_creation succeeds");
        store
            .mark_ready("ready-ws", "container-1", 12345, 12346)
            .await
            .expect("mark_ready succeeds");

        let result = store.list(50, 0).await.expect("list succeeds");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, WorkspaceStatus::Ready);
        assert_eq!(result[0].host_port, Some(12345));
        assert_eq!(result[0].desktop_port, Some(12346));
    }

    #[tokio::test]
    async fn delete_by_workspace_id_removes_the_row() {
        let store = temp_store().await;
        store
            .begin_creation("to-delete", "id-delete")
            .await
            .expect("begin_creation succeeds");

        let deleted = store
            .delete_by_workspace_id("id-delete")
            .await
            .expect("delete succeeds");
        assert!(deleted);
        assert!(store
            .find_by_workspace_id("id-delete")
            .await
            .expect("lookup succeeds")
            .is_none());
    }

    #[tokio::test]
    async fn delete_by_workspace_id_returns_false_for_unknown_id() {
        let store = temp_store().await;
        let deleted = store
            .delete_by_workspace_id("does-not-exist")
            .await
            .expect("delete succeeds");
        assert!(!deleted);
    }

    #[tokio::test]
    async fn mark_ready_by_workspace_id_updates_status_and_ports() {
        let store = temp_store().await;
        store
            .begin_creation("to-heal", "id-heal")
            .await
            .expect("begin_creation succeeds");
        store
            .mark_failed("to-heal")
            .await
            .expect("mark_failed succeeds");

        let updated = store
            .mark_ready_by_workspace_id("id-heal", "container-1", 111, 222)
            .await
            .expect("mark_ready_by_workspace_id succeeds")
            .expect("row exists");

        assert_eq!(updated.status, WorkspaceStatus::Ready);
        assert_eq!(updated.host_port, Some(111));
        assert_eq!(updated.desktop_port, Some(222));
    }

    #[tokio::test]
    async fn mark_ready_by_workspace_id_returns_none_for_unknown_id() {
        let store = temp_store().await;
        let result = store
            .mark_ready_by_workspace_id("does-not-exist", "container-1", 111, 222)
            .await
            .expect("does not error");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn mark_failed_by_workspace_id_updates_status() {
        let store = temp_store().await;
        store
            .begin_creation("to-fail", "id-fail")
            .await
            .expect("begin_creation succeeds");
        store
            .mark_ready("to-fail", "container-1", 111, 222)
            .await
            .expect("mark_ready succeeds");

        let updated = store
            .mark_failed_by_workspace_id("id-fail")
            .await
            .expect("mark_failed_by_workspace_id succeeds")
            .expect("row exists");

        assert_eq!(updated.status, WorkspaceStatus::Failed);
    }

    #[tokio::test]
    async fn mark_failed_by_workspace_id_returns_none_for_unknown_id() {
        let store = temp_store().await;
        let result = store
            .mark_failed_by_workspace_id("does-not-exist")
            .await
            .expect("does not error");
        assert!(result.is_none());
    }
}
