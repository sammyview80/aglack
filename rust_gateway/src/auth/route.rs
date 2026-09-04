//! Google OAuth login, logout, and session inspection routes.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Router,
};
use cookie::Cookie;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;
use sqlx::SqlitePool;

use super::store::SessionStore;
use crate::config::GatewayAuthConfig;
use crate::crypto::sha256_hex;
use crate::response::{error, success};

pub const SESSION_COOKIE_NAME: &str = "gw_session";
/// 12 hours — matches `docs/integrations-plan.md`'s Phase 0a design
/// exactly ("12 h expiry, sliding renewal" — sliding renewal itself is
/// follow-up work, not built in this slice: a session simply expires
/// outright at this fixed window today rather than extending on use).
const SESSION_LIFETIME_SECS: u64 = 12 * 60 * 60;

const OAUTH_STATE_LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_OAUTH_STATES: usize = 1024;

pub struct AuthState {
    pub sessions: SessionStore,
    pub workspace_pool: SqlitePool,
    pub cookie_secure: bool,
    google_client_id: String,
    google_client_secret: String,
    google_redirect_uri: String,
    google_authorize_url: String,
    google_token_url: String,
    google_userinfo_url: String,
    frontend_origin: String,
    http_client: reqwest::Client,
    // ponytail: process-local state fits one gateway; use shared storage if replicas are added.
    pending_oauth_states: Mutex<HashMap<String, Instant>>,
}

impl AuthState {
    pub fn new(
        sessions: SessionStore,
        workspace_pool: SqlitePool,
        config: GatewayAuthConfig,
        frontend_origin: String,
        http_client: reqwest::Client,
    ) -> Self {
        Self {
            sessions,
            workspace_pool,
            cookie_secure: config.cookie_secure,
            google_client_id: config.google_client_id,
            google_client_secret: config.google_client_secret,
            google_redirect_uri: config.google_redirect_uri,
            google_authorize_url: config.google_authorize_url,
            google_token_url: config.google_token_url,
            google_userinfo_url: config.google_userinfo_url,
            frontend_origin,
            http_client,
            pending_oauth_states: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Deserialize)]
pub struct GoogleCallback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct GoogleUser {
    sub: String,
    email: String,
    email_verified: bool,
}

pub async fn google_start_route(State(state): State<Arc<AuthState>>) -> Response {
    let oauth_state = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
    let mut pending = state
        .pending_oauth_states
        .lock()
        .expect("pending_oauth_states mutex poisoned");
    pending.retain(|_, created| created.elapsed() <= OAUTH_STATE_LIFETIME);
    if pending.len() >= MAX_PENDING_OAUTH_STATES {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "oauth_start_rate_limited",
            "Too many login attempts. Try again shortly.",
        );
    }
    pending.insert(oauth_state.clone(), Instant::now());
    drop(pending);

    let Ok(mut url) = reqwest::Url::parse(&state.google_authorize_url) else {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "oauth_config_invalid",
            "Invalid Google authorize URL.",
        );
    };
    url.query_pairs_mut()
        .append_pair("client_id", &state.google_client_id)
        .append_pair("redirect_uri", &state.google_redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("state", &oauth_state);
    Redirect::temporary(url.as_str()).into_response()
}

pub async fn google_callback_route(
    State(state): State<Arc<AuthState>>,
    Query(callback): Query<GoogleCallback>,
) -> Response {
    if callback.error.is_some() {
        return error(
            StatusCode::UNAUTHORIZED,
            "oauth_denied",
            "Google login was cancelled.",
        );
    }
    let (Some(code), Some(oauth_state)) = (callback.code, callback.state) else {
        return error(
            StatusCode::BAD_REQUEST,
            "oauth_callback_invalid",
            "Missing OAuth callback parameters.",
        );
    };
    let created = state
        .pending_oauth_states
        .lock()
        .expect("pending_oauth_states mutex poisoned")
        .remove(&oauth_state);
    if !created.is_some_and(|created| created.elapsed() <= OAUTH_STATE_LIFETIME) {
        return error(
            StatusCode::UNAUTHORIZED,
            "oauth_state_invalid",
            "OAuth state is invalid or expired.",
        );
    }

    let token_response = match state
        .http_client
        .post(&state.google_token_url)
        .form(&[
            ("code", code.as_str()),
            ("client_id", state.google_client_id.as_str()),
            ("client_secret", state.google_client_secret.as_str()),
            ("redirect_uri", state.google_redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<GoogleTokenResponse>().await {
                Ok(token) => token,
                Err(err) => {
                    tracing::warn!("invalid Google token response: {err}");
                    return error(
                        StatusCode::BAD_GATEWAY,
                        "oauth_exchange_failed",
                        "Google token exchange failed.",
                    );
                }
            }
        }
        Ok(response) => {
            tracing::warn!(status = %response.status(), "Google token exchange failed");
            return error(
                StatusCode::BAD_GATEWAY,
                "oauth_exchange_failed",
                "Google token exchange failed.",
            );
        }
        Err(err) => {
            tracing::warn!("Google token exchange failed: {err}");
            return error(
                StatusCode::BAD_GATEWAY,
                "oauth_exchange_failed",
                "Google token exchange failed.",
            );
        }
    };

    let user = match state
        .http_client
        .get(&state.google_userinfo_url)
        .bearer_auth(&token_response.access_token)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => match response.json::<GoogleUser>().await
        {
            Ok(user) => user,
            Err(err) => {
                tracing::warn!("invalid Google userinfo response: {err}");
                return error(
                    StatusCode::BAD_GATEWAY,
                    "oauth_userinfo_failed",
                    "Google user lookup failed.",
                );
            }
        },
        Ok(response) => {
            tracing::warn!(status = %response.status(), "Google user lookup failed");
            return error(
                StatusCode::BAD_GATEWAY,
                "oauth_userinfo_failed",
                "Google user lookup failed.",
            );
        }
        Err(err) => {
            tracing::warn!("Google user lookup failed: {err}");
            return error(
                StatusCode::BAD_GATEWAY,
                "oauth_userinfo_failed",
                "Google user lookup failed.",
            );
        }
    };
    // ponytail: any verified Google account is allowed for this prototype;
    // add an allowlist or per-user authorization before public exposure.
    if !user.email_verified || user.sub.is_empty() || user.email.is_empty() {
        return error(
            StatusCode::UNAUTHORIZED,
            "google_email_unverified",
            "A verified Google email is required.",
        );
    }
    let _ = state.sessions.prune_expired().await;

    let raw_token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
    let token_hash = sha256_hex(&raw_token);
    let expires_at = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + SESSION_LIFETIME_SECS)
        .to_string();

    if let Err(err) = state
        .sessions
        .create(&token_hash, &expires_at, &user.sub, &user.email)
        .await
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_store_failed",
            err.to_string(),
        );
    }

    let mut response = Redirect::to(&state.frontend_origin).into_response();
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

/// Standalone router for exempt auth routes, merged onto the
/// main router in `bin/rust_gateway.rs` — same "separate router, merged
/// in the binary" pattern `integrations::route::router` already uses,
/// for the same reason (nothing here needs to touch `app::build_router`).
pub fn router(state: Arc<AuthState>) -> Router {
    Router::new()
        .route("/auth/google", get(google_start_route))
        .route("/auth/google/callback", get(google_callback_route))
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
    use crate::config::GatewayAuthConfig;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_state() -> AuthState {
        AuthState::new(
            SessionStore::new(sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap()),
            sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
            GatewayAuthConfig {
                cookie_secure: false,
                google_client_id: "client-id".to_string(),
                google_client_secret: "client-secret".to_string(),
                google_redirect_uri: "https://app.example/auth/google/callback".to_string(),
                google_authorize_url: "https://accounts.example/authorize".to_string(),
                google_token_url: "https://accounts.example/token".to_string(),
                google_userinfo_url: "https://accounts.example/userinfo".to_string(),
            },
            "https://app.example".to_string(),
            reqwest::Client::new(),
        )
    }

    #[tokio::test]
    async fn google_start_redirects_with_required_oauth_parameters() {
        let response = router(Arc::new(test_state()))
            .oneshot(
                Request::builder()
                    .uri("/auth/google")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        let location = response.headers()[header::LOCATION].to_str().unwrap();
        let url = reqwest::Url::parse(location).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["client_id"], "client-id");
        assert_eq!(
            query["redirect_uri"],
            "https://app.example/auth/google/callback"
        );
        assert_eq!(query["response_type"], "code");
        assert_eq!(query["scope"], "openid email profile");
        assert!(!query["state"].is_empty());
    }

    #[tokio::test]
    async fn google_callback_creates_a_working_session() {
        let google = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "google-access-token"
            })))
            .mount(&google)
            .await;
        Mock::given(method("GET"))
            .and(path("/userinfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sub": "google-subject",
                "email": "person@example.com",
                "email_verified": true
            })))
            .mount(&google)
            .await;

        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let state = Arc::new(AuthState::new(
            SessionStore::new(pool.clone()),
            pool,
            GatewayAuthConfig {
                cookie_secure: false,
                google_client_id: "client-id".to_string(),
                google_client_secret: "client-secret".to_string(),
                google_redirect_uri: "https://app.example/auth/google/callback".to_string(),
                google_authorize_url: "https://accounts.example/authorize".to_string(),
                google_token_url: format!("{}/token", google.uri()),
                google_userinfo_url: format!("{}/userinfo", google.uri()),
            },
            "https://app.example".to_string(),
            reqwest::Client::new(),
        ));
        let app = router(state);

        let start = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/google")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let authorize_url =
            reqwest::Url::parse(start.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        let oauth_state = authorize_url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
            .unwrap();

        let callback = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/auth/google/callback?code=code&state={oauth_state}"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::SEE_OTHER);
        assert_eq!(callback.headers()[header::LOCATION], "https://app.example");
        let set_cookie = callback.headers()[header::SET_COOKIE].to_str().unwrap();
        let session_cookie = Cookie::parse(set_cookie).unwrap();

        let me = app
            .oneshot(
                Request::builder()
                    .uri("/auth/me")
                    .header(
                        header::COOKIE,
                        format!("{}={}", session_cookie.name(), session_cookie.value()),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(me.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn google_callback_rejects_an_unknown_state() {
        let response = router(Arc::new(test_state()))
            .oneshot(
                Request::builder()
                    .uri("/auth/google/callback?code=code&state=unknown")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
