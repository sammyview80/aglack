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

    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new().connect_with(options).await?;

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
}
