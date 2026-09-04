//! `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` — the ONLY
//! three routes `middleware.rs`'s session check exempts by name (see that
//! module). See `docs/integrations-plan.md`'s Phase 0a for the full
//! design this implements: one deployment-wide admin credential, opaque
//! random session tokens, SHA-256-hashed at rest.

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use cookie::Cookie;
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

use super::password;
use super::store::SessionStore;
use crate::crypto::sha256_hex;
use crate::response::{error, success};

pub const SESSION_COOKIE_NAME: &str = "gw_session";
/// 12 hours — matches `docs/integrations-plan.md`'s Phase 0a design
/// exactly ("12 h expiry, sliding renewal" — sliding renewal itself is
/// follow-up work, not built in this slice: a session simply expires
/// outright at this fixed window today rather than extending on use).
const SESSION_LIFETIME_SECS: u64 = 12 * 60 * 60;

/// Brute-force mitigation on `POST /auth/login`, applied GLOBALLY (this
/// gateway has exactly one admin credential — Phase 0b's per-user
/// accounts is where a per-user/per-IP version of this would matter more;
/// see `docs/integrations-plan.md`). Two layers: a fixed delay on every
/// wrong-password attempt (on top of Argon2id's own real cost), and a
/// sliding-window lockout after too many wrong attempts in a row.
const LOGIN_FAILURE_DELAY: Duration = Duration::from_millis(400);
const MAX_FAILURES_PER_WINDOW: u32 = 10;
const LOCKOUT_WINDOW: Duration = Duration::from_secs(5 * 60);

struct LoginAttempts {
    failures: u32,
    window_start: Instant,
}

impl Default for LoginAttempts {
    fn default() -> Self {
        Self {
            failures: 0,
            window_start: Instant::now(),
        }
    }
}

pub struct AuthState {
    pub sessions: SessionStore,
    pub admin_password_hash: String,
    /// Whether the `Secure` cookie attribute is set — must be `false` for
    /// plain-http local dev (browsers silently drop `Secure` cookies over
    /// http) and `true` for any real deployment behind TLS. Required,
    /// like every other deployment-shape decision in this crate
    /// (AGENTS.md rule #2) — no guessing from `FRONTEND_ORIGIN`'s scheme,
    /// since a reverse proxy terminating TLS in front of a plain-http
    /// gateway is a real, common shape this can't infer.
    pub cookie_secure: bool,
    /// `std::sync::Mutex`, not `tokio::sync::Mutex` — deliberately: every
    /// critical section touching this lock is synchronous (a few integer
    /// comparisons, no `.await` while held), so a blocking mutex is both
    /// correct and cheaper than an async one here. See
    /// `login_rate_limit_check`.
    login_attempts: Mutex<LoginAttempts>,
}

impl AuthState {
    pub fn new(sessions: SessionStore, admin_password_hash: String, cookie_secure: bool) -> Self {
        Self {
            sessions,
            admin_password_hash,
            cookie_secure,
            login_attempts: Mutex::new(LoginAttempts::default()),
        }
    }
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

/// `true` if a login attempt should proceed; `false` if this process has
/// seen too many failures too recently and the caller should be rejected
/// without even checking the password (Argon2id's own cost is real but
/// non-zero — skipping it entirely once locked out avoids doing that work
/// for an attacker who has already shown intent to brute-force).
fn login_rate_limit_check(state: &AuthState) -> bool {
    let mut attempts = state
        .login_attempts
        .lock()
        .expect("login_attempts mutex poisoned");
    if attempts.window_start.elapsed() > LOCKOUT_WINDOW {
        *attempts = LoginAttempts::default();
    }
    attempts.failures < MAX_FAILURES_PER_WINDOW
}

fn record_login_failure(state: &AuthState) {
    let mut attempts = state
        .login_attempts
        .lock()
        .expect("login_attempts mutex poisoned");
    attempts.failures += 1;
}

fn record_login_success(state: &AuthState) {
    let mut attempts = state
        .login_attempts
        .lock()
        .expect("login_attempts mutex poisoned");
    *attempts = LoginAttempts::default();
}

/// `POST /auth/login`. See `login_rate_limit_check`/`record_login_failure`
/// for the brute-force mitigation: a fixed delay on every wrong password
/// (on top of Argon2id's own real cost) plus a sliding-window lockout —
/// both apply globally, matching this phase's one-shared-credential
/// design (see `AuthState`'s own doc comment on `login_attempts`).
pub async fn login_route(
    State(state): State<Arc<AuthState>>,
    Json(request): Json<LoginRequest>,
) -> Response {
    if !login_rate_limit_check(&state) {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
            "Too many failed login attempts. Try again in a few minutes.",
        );
    }

    if !password::verify(&request.password, &state.admin_password_hash) {
        record_login_failure(&state);
        tokio::time::sleep(LOGIN_FAILURE_DELAY).await;
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_password",
            "Incorrect password.",
        );
    }
    record_login_success(&state);

    let _ = state.sessions.prune_expired().await;

    let raw_token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
    let token_hash = sha256_hex(&raw_token);
    let expires_at = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + SESSION_LIFETIME_SECS)
        .to_string();

    if let Err(err) = state.sessions.create(&token_hash, &expires_at).await {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_store_failed",
            err.to_string(),
        );
    }

    let mut response = success(StatusCode::OK, serde_json::json!({ "ok": true }));
    let cookie_header =
        build_session_cookie(&raw_token, state.cookie_secure, SESSION_LIFETIME_SECS);
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie_header.parse().expect("valid cookie header"),
    );
    response
}

/// `POST /auth/logout` — deletes the session server-side (not just
/// clearing the cookie client-side, which would leave the token valid if
/// somehow replayed) and clears the cookie.
pub async fn logout_route(State(state): State<Arc<AuthState>>, headers: HeaderMap) -> Response {
    if let Some(raw_token) = read_session_cookie(&headers) {
        let _ = state.sessions.delete(&sha256_hex(&raw_token)).await;
    }

    let mut response = success(StatusCode::OK, serde_json::json!({ "ok": true }));
    let cookie_header = build_expired_session_cookie(state.cookie_secure);
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie_header.parse().expect("valid cookie header"),
    );
    response
}

/// `GET /auth/me` — lets the frontend check "am I logged in" once on
/// load without guessing from a 401 on some other route.
pub async fn me_route(State(state): State<Arc<AuthState>>, headers: HeaderMap) -> Response {
    let Some(raw_token) = read_session_cookie(&headers) else {
        return error(StatusCode::UNAUTHORIZED, "not_authenticated", "No session.");
    };
    match state.sessions.is_valid(&sha256_hex(&raw_token)).await {
        Ok(true) => success(StatusCode::OK, serde_json::json!({ "authenticated": true })),
        _ => error(StatusCode::UNAUTHORIZED, "not_authenticated", "No session."),
    }
}

pub fn read_session_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    Cookie::split_parse(raw)
        .filter_map(Result::ok)
        .find(|c| c.name() == SESSION_COOKIE_NAME)
        .map(|c| c.value().to_string())
}

fn build_session_cookie(raw_token: &str, secure: bool, max_age_secs: u64) -> String {
    let mut cookie = Cookie::build((SESSION_COOKIE_NAME, raw_token))
        .http_only(true)
        .same_site(cookie::SameSite::Strict)
        .path("/")
        .max_age(cookie::time::Duration::seconds(max_age_secs as i64));
    if secure {
        cookie = cookie.secure(true);
    }
    cookie.build().to_string()
}

/// Standalone router for the three exempt auth routes, merged onto the
/// main router in `bin/rust_gateway.rs` — same "separate router, merged
/// in the binary" pattern `integrations::route::router` already uses,
/// for the same reason (nothing here needs to touch `app::build_router`).
pub fn router(state: Arc<AuthState>) -> Router {
    Router::new()
        .route("/auth/login", post(login_route))
        .route("/auth/logout", post(logout_route))
        .route("/auth/me", get(me_route))
        .with_state(state)
}

fn build_expired_session_cookie(secure: bool) -> String {
    let mut cookie = Cookie::build((SESSION_COOKIE_NAME, ""))
        .http_only(true)
        .same_site(cookie::SameSite::Strict)
        .path("/")
        .max_age(cookie::time::Duration::seconds(0));
    if secure {
        cookie = cookie.secure(true);
    }
    cookie.build().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> AuthState {
        AuthState::new(
            SessionStore::new(sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap()),
            "unused".to_string(),
            false,
        )
    }

    #[tokio::test]
    async fn allows_attempts_under_the_limit() {
        let state = test_state();
        for _ in 0..MAX_FAILURES_PER_WINDOW {
            assert!(login_rate_limit_check(&state));
            record_login_failure(&state);
        }
    }

    #[tokio::test]
    async fn blocks_once_the_limit_is_reached() {
        let state = test_state();
        for _ in 0..MAX_FAILURES_PER_WINDOW {
            record_login_failure(&state);
        }
        assert!(!login_rate_limit_check(&state));
    }

    #[tokio::test]
    async fn a_success_resets_the_failure_count() {
        let state = test_state();
        for _ in 0..MAX_FAILURES_PER_WINDOW {
            record_login_failure(&state);
        }
        record_login_success(&state);
        assert!(login_rate_limit_check(&state));
    }
}
