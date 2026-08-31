//! Builds the axum `Router` — route registration only. Keeping this
//! separate from `bin/rust_gateway.rs` (process bootstrapping: config
//! loading, binding a listener, starting the server) means a future
//! integration test can build and exercise a `Router` directly, in-process,
//! without spawning a real subprocess bound to a real port.

use axum::{
    http::{HeaderValue, Method},
    routing::any,
    routing::post,
    Router,
};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

use crate::proxy::{forward, ProxyState};
use crate::workspaces::{create_workspace_route, WorkspacesState};

/// Build the full router for this gateway.
///
/// Route order matters here: `/workspaces` is registered before the
/// catch-all proxy route, so it is never accidentally forwarded to the
/// backend instead of being handled by `create_workspace_route`.
///
/// `frontend_origin` (e.g. `http://127.0.0.1:5173`, see
/// `config::GatewayConfig::frontend_origin`) is the only origin allowed to
/// make browser (CORS) requests here — required, not hardcoded, matching
/// AGENTS.md rule #2. Without this, a browser's own fetch/XHR to
/// `/workspaces` from the frontend's origin is blocked before this
/// process ever sees the request (curl/server-to-server calls are
/// unaffected either way — CORS is enforced by the browser, not this
/// server, so this layer only matters for browser callers).
pub fn build_router(
    proxy_state: Arc<ProxyState>,
    workspaces_state: Arc<WorkspacesState>,
    frontend_origin: &str,
) -> Router {
    let origin = HeaderValue::from_str(frontend_origin)
        .unwrap_or_else(|err| panic!("invalid FRONTEND_ORIGIN {frontend_origin:?}: {err}"));
    let cors = CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    let workspaces_router = Router::new()
        .route("/workspaces", post(create_workspace_route))
        .with_state(workspaces_state);

    let proxy_router = Router::new()
        .route("/", any(forward))
        .route("/*path", any(forward))
        .with_state(proxy_state);

    workspaces_router.merge(proxy_router).layer(cors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::{DockerCliLauncher, WorkspaceStore};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    async fn temp_workspaces_state() -> Arc<WorkspacesState> {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        std::mem::forget(dir);
        let pool = crate::db::connect(&db_path)
            .await
            .expect("connect to fresh sqlite db");
        Arc::new(WorkspacesState {
            store: WorkspaceStore::new(pool),
            launcher: Arc::new(DockerCliLauncher::new("unused:tag".to_string())),
        })
    }

    fn unused_proxy_state() -> Arc<ProxyState> {
        Arc::new(ProxyState {
            http_client: reqwest::Client::new(),
            backend_addr: "127.0.0.1:1".to_string(),
        })
    }

    /// A browser preflight (OPTIONS) request from the configured frontend
    /// origin must get back an Access-Control-Allow-Origin header naming
    /// that exact origin — without it, the browser blocks the real POST
    /// before this server ever runs `create_workspace_route`.
    #[tokio::test]
    async fn preflight_from_configured_frontend_origin_is_allowed() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            "http://127.0.0.1:5173",
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/workspaces")
                    .header("Origin", "http://127.0.0.1:5173")
                    .header("Access-Control-Request-Method", "POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let allow_origin = response
            .headers()
            .get("access-control-allow-origin")
            .expect("preflight response must include Access-Control-Allow-Origin")
            .to_str()
            .unwrap();
        assert_eq!(allow_origin, "http://127.0.0.1:5173");
    }

    /// A real POST response (not just the preflight) must also carry the
    /// header — some fetch/XHR implementations check it on the actual
    /// response, not only the preflight.
    #[tokio::test]
    async fn post_response_from_configured_frontend_origin_carries_cors_header() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            "http://127.0.0.1:5173",
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/workspaces")
                    .header("Origin", "http://127.0.0.1:5173")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"name":"cors-test-ws"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        let allow_origin = response
            .headers()
            .get("access-control-allow-origin")
            .expect("POST response must include Access-Control-Allow-Origin")
            .to_str()
            .unwrap();
        assert_eq!(allow_origin, "http://127.0.0.1:5173");
    }
}
