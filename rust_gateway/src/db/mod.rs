//! SQLite connection setup. See `../../docs/create-workspace-plan.md` for
//! why SQLite and what it stores.
//!
//! This module's only job: given a database file path, open a connection
//! pool and make sure the schema exists. It does not know what a
//! "workspace" or an "idempotency key" is — that lives in
//! `crate::workspaces`. Keeping this module schema-aware but
//! feature-unaware means a second feature that also needs SQLite storage
//! adds its own migration file here without touching workspace code.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;

/// Open (creating if missing) the SQLite database at `path` and apply any
/// pending migrations. Safe to call every time the process starts — an
/// already-up-to-date database is a no-op.
pub async fn connect(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            sqlx::Error::Io(std::io::Error::new(
                err.kind(),
                format!(
                    "failed to create database directory {}: {err}",
                    parent.display()
                ),
            ))
        })?;
    }

    // WAL: readers (MCP proxy's per-call token lookup) no longer block
    // writers (audit inserts) and vice versa — the plain default
    // (rollback journal) serializes every writer against every reader,
    // which surfaces as `SQLITE_BUSY` under the concurrency this gateway
    // actually has (one audit insert per proxied MCP call, alongside
    // reads for the same request). `busy_timeout` covers the remaining
    // writer-vs-writer case WAL does not remove (SQLite still allows only
    // one writer at a time) by making a losing writer retry briefly
    // instead of failing immediately. `foreign_keys(true)`: no migration
    // in this crate was written assuming FK enforcement is off (checked:
    // none of the `migrations/*.sql` files rely on an FK being silently
    // unenforced), so turning it on only makes an already-intended
    // constraint real.
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(5))
        .foreign_keys(true);

    // Fixed operational tuning constant, not a per-environment address —
    // matches AGENTS.md rule #2's actual concern (no hardcoded
    // host/port/URL), which this is not. 8 comfortably covers this
    // gateway's real concurrency (one process, a handful of proxied
    // routes each doing at most a couple of sequential queries) without
    // starving SQLite, which serializes writers regardless of pool size.
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    #[tokio::test]
    async fn connect_creates_workspace_creations_indexes() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");

        let pool = connect(&db_path).await.expect("connect succeeds");

        let names: Vec<String> = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_creations'",
        )
        .fetch_all(&pool)
        .await
        .expect("query sqlite_master succeeds")
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect();

        assert!(names.contains(&"idx_workspace_creations_workspace_id".to_string()));
        assert!(names.contains(&"idx_workspace_creations_created_at".to_string()));
    }

    #[tokio::test]
    async fn connect_enables_wal_journal_mode() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");

        let pool = connect(&db_path).await.expect("connect succeeds");

        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .expect("query PRAGMA journal_mode");

        assert_eq!(mode.to_lowercase(), "wal");
    }
}
