//! SQLite-backed session store for the gateway's own admin login (see
//! `docs/integrations-plan.md`'s Phase 0a). Pattern mirrors
//! `integrations::store::IntegrationStore` — opaque random tokens,
//! SHA-256-hashed at rest, no signing secret.

use sqlx::{Row, SqlitePool};

pub struct SessionStore {
    pool: SqlitePool,
}

impl SessionStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Insert a new session row. `token_hash` is the caller's
    /// SHA-256 hex digest of the raw session token — the raw token itself
    /// is never stored, only ever held in memory long enough to set the
    /// cookie (see `route.rs`'s `login_route`).
    pub async fn create(&self, token_hash: &str, expires_at: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO gateway_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
        )
        .bind(token_hash)
        .bind(now())
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// `true` if `token_hash` names a session that exists AND has not
    /// expired. Deliberately does not distinguish "no such session" from
    /// "expired session" in its return type — both mean "not
    /// authenticated" to every caller (see `middleware.rs`), and
    /// conflating them avoids a timing/behavior difference an attacker
    /// could use to enumerate which hashes ever existed.
    pub async fn is_valid(&self, token_hash: &str) -> Result<bool, sqlx::Error> {
        let row = sqlx::query("SELECT expires_at FROM gateway_sessions WHERE token_hash = ?")
            .bind(token_hash)
            .fetch_optional(&self.pool)
            .await?;
        Ok(match row {
            Some(row) => row.get::<String, _>("expires_at").as_str() > now().as_str(),
            None => false,
        })
    }

    pub async fn delete(&self, token_hash: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM gateway_sessions WHERE token_hash = ?")
            .bind(token_hash)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Best-effort cleanup of expired rows — called opportunistically on
    /// login (see `route.rs`) rather than on a background timer, matching
    /// this crate's existing preference for simple, request-triggered
    /// maintenance over a second long-lived task (see `daemon_watch.rs`
    /// for the one exception, which has a real external trigger to watch
    /// for; a session table has no equivalent).
    pub async fn prune_expired(&self) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM gateway_sessions WHERE expires_at <= ?")
            .bind(now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

/// Epoch-seconds string — directly comparable as a string ONLY because
/// it is always the same fixed-width zero-padded... actually epoch
/// seconds are NOT fixed-width forever, but are for the lifetime of any
/// real deployment of this system (10-digit until year 2286) and this
/// matches the exact convention already used by
/// `integrations::store::now_rfc3339` and `workspaces::store::chrono_now`
/// — one shared "epoch seconds as a string, string-comparable" convention
/// across every timestamp column in this crate, not a special case here.
fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn temp_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    #[tokio::test]
    async fn a_freshly_created_session_is_valid() {
        let store = SessionStore::new(temp_pool().await);
        let future = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600)
            .to_string();
        store.create("hash-a", &future).await.expect("create");
        assert!(store.is_valid("hash-a").await.expect("is_valid"));
    }

    #[tokio::test]
    async fn an_unknown_token_hash_is_not_valid() {
        let store = SessionStore::new(temp_pool().await);
        assert!(!store.is_valid("never-created").await.expect("is_valid"));
    }

    #[tokio::test]
    async fn an_expired_session_is_not_valid() {
        let store = SessionStore::new(temp_pool().await);
        store.create("hash-expired", "0").await.expect("create");
        assert!(!store.is_valid("hash-expired").await.expect("is_valid"));
    }

    #[tokio::test]
    async fn delete_removes_the_session() {
        let store = SessionStore::new(temp_pool().await);
        let future = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600)
            .to_string();
        store.create("hash-b", &future).await.expect("create");
        store.delete("hash-b").await.expect("delete");
        assert!(!store.is_valid("hash-b").await.expect("is_valid"));
    }

    #[tokio::test]
    async fn prune_expired_removes_only_expired_rows() {
        let store = SessionStore::new(temp_pool().await);
        let future = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600)
            .to_string();
        store.create("hash-live", &future).await.expect("create");
        store.create("hash-dead", "0").await.expect("create");
        store.prune_expired().await.expect("prune");
        assert!(store.is_valid("hash-live").await.expect("is_valid"));
        assert!(!store.is_valid("hash-dead").await.expect("is_valid"));
    }
}
