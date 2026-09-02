//! Builds the axum `Router` — route registration only. Keeping this
//! separate from `bin/rust_gateway.rs` (process bootstrapping: config
//! loading, binding a listener, starting the server) means a future
//! integration test can build and exercise a `Router` directly, in-process,
//! without spawning a real subprocess bound to a real port.

use axum::{
    http::{HeaderValue, Method},
    routing::{any, delete, post},
    Router,
};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

use crate::proxy::{forward, ProxyState};
use crate::workspaces::{
    agent_history_proxy_route_root, agent_history_proxy_route_with_path,
    agent_seeder_proxy_route_root, agent_seeder_proxy_route_with_path, chat_proxy_route_root,
    chat_proxy_route_with_path, create_workspace_route,
    delete_workspace_route, desktop_proxy_route_root, desktop_proxy_route_with_path,
    diagnose_workspace_route, hermes_webui_proxy_route_root, hermes_webui_proxy_route_with_path,
    list_workspaces_route, onboarding_proxy_route_root, onboarding_proxy_route_with_path,
    WorkspacesState,
};

/// Register one per-workspace proxy feature's pair of routes: the exact
/// prefix (`/workspaces/:id/<feature>/`, no further segments) and its
/// `*path` wildcard sibling. Every proxy feature under `workspaces/`
/// (onboarding, hermes-webui, desktop) needs exactly this same pair —
/// axum's `*path` wildcard does not match a bare trailing-slash request,
/// so the root case needs its own route+handler (see e.g.
/// `onboarding_proxy.rs`'s module doc for the full explanation of why).
/// Collapsing the two `.route(...)` calls into one here means a route
/// registered inconsistently (e.g. one feature's root and wildcard
/// pointing at prefixes that don't match) is a compile-time-obvious single
/// call, not something to eyeball-diff across 6 separate `.route(...)`
/// lines.
fn register_workspace_proxy_pair<H1, H2, T1, T2>(
    router: Router<Arc<WorkspacesState>>,
    prefix: &str,
    root_handler: H1,
    path_handler: H2,
) -> Router<Arc<WorkspacesState>>
where
    H1: axum::handler::Handler<T1, Arc<WorkspacesState>>,
    H2: axum::handler::Handler<T2, Arc<WorkspacesState>>,
    T1: 'static,
    T2: 'static,
{
    router
        .route(&format!("{prefix}/"), any(root_handler))
        .route(&format!("{prefix}/*path"), any(path_handler))
}

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
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    let mut workspaces_router = Router::new()
        .route(
            "/workspaces",
            post(create_workspace_route).get(list_workspaces_route),
        )
        .route("/workspaces/:id", delete(delete_workspace_route))
        .route("/workspaces/:id/diagnose", post(diagnose_workspace_route));
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/onboarding",
        onboarding_proxy_route_root,
        onboarding_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/agent-seeder",
        agent_seeder_proxy_route_root,
        agent_seeder_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/hermes-webui",
        hermes_webui_proxy_route_root,
        hermes_webui_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/desktop",
        desktop_proxy_route_root,
        desktop_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/agent-history",
        agent_history_proxy_route_root,
        agent_history_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/chat",
        chat_proxy_route_root,
        chat_proxy_route_with_path,
    );
    let workspaces_router = workspaces_router.with_state(workspaces_state);

    let proxy_router = Router::new()
        .route("/", any(forward))
        .route("/*path", any(forward))
        .with_state(proxy_state);

    workspaces_router.merge(proxy_router).layer(cors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::test_support::{state_with_store, temp_store};
    use crate::workspaces::DockerCliLauncher;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    async fn temp_workspaces_state() -> Arc<WorkspacesState> {
        state_with_store(
            temp_store().await,
            Arc::new(DockerCliLauncher::new(
                "unused:tag".to_string(),
                "http://localhost:5173".to_string(),
                "/workspace/default".to_string(),
                "http://localhost:5173".to_string(),
            )),
        )
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

    /// Proves `register_workspace_proxy_pair` actually wired all FOUR
    /// proxy features' root+wildcard routes into the real router — every
    /// existing proxy-route test elsewhere (`onboarding_proxy.rs` etc.)
    /// calls the handler function directly, never through `build_router`
    /// itself, so a route-registration mistake (wrong prefix, swapped
    /// root/wildcard handler, a feature silently dropped) would NOT have
    /// been caught before this test existed. An unknown workspace id is
    /// used so every prefix below reaches its real handler and returns a
    /// real (404) response — proving actual dispatch, not just "some
    /// route exists that returns 200".
    #[tokio::test]
    async fn every_proxy_feature_prefix_is_reachable_through_the_real_router() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            "http://127.0.0.1:5173",
        );

        for uri in [
            "/workspaces/does-not-exist/onboarding/",
            "/workspaces/does-not-exist/onboarding/status",
            "/workspaces/does-not-exist/agent-seeder/",
            "/workspaces/does-not-exist/agent-seeder/apply",
            "/workspaces/does-not-exist/hermes-webui/",
            "/workspaces/does-not-exist/hermes-webui/api/sessions",
            "/workspaces/does-not-exist/desktop/",
            "/workspaces/does-not-exist/desktop/index.html",
            "/workspaces/does-not-exist/agent-history/",
            "/workspaces/does-not-exist/agent-history/agents",
            "/workspaces/does-not-exist/chat/",
            "/workspaces/does-not-exist/chat/api/chat/start",
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();

            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "expected {uri} to reach its proxy handler and report the unknown \
                 workspace id (workspace_not_found), not axum's own \"no route matched\""
            );
        }
    }

    /// `GET /workspaces` must dispatch to `list_workspaces_route`, not
    /// `create_workspace_route` (both share the `/workspaces` path,
    /// distinguished only by HTTP method) — proven through the real
    /// router, not just by calling the handler function directly.
    #[tokio::test]
    async fn get_workspaces_is_reachable_through_the_real_router() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            "http://127.0.0.1:5173",
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/workspaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    /// `DELETE /workspaces/:id` must dispatch to `delete_workspace_route`
    /// through the real router — an unknown id is used so the handler
    /// itself runs and returns `workspace_not_found`, proving dispatch
    /// rather than axum's own "no route matched".
    #[tokio::test]
    async fn delete_workspace_is_reachable_through_the_real_router() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            "http://127.0.0.1:5173",
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::DELETE)
                    .uri("/workspaces/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// A browser preflight for DELETE must be allowed — without DELETE in
    /// `allow_methods`, the dashboard delete button's CORS preflight is
    /// blocked before this server ever runs `delete_workspace_route`.
    #[tokio::test]
    async fn preflight_delete_from_configured_frontend_origin_is_allowed() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            "http://127.0.0.1:5173",
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/workspaces/does-not-exist")
                    .header("Origin", "http://127.0.0.1:5173")
                    .header("Access-Control-Request-Method", "DELETE")
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

    /// `POST /workspaces/:id/diagnose` must dispatch to
    /// `diagnose_workspace_route` through the real router — an unknown id
    /// is used so the handler itself runs and returns
    /// `workspace_not_found`, proving dispatch rather than axum's own
    /// "no route matched". Also proves this new static `/diagnose`
    /// segment does not collide with the `/workspaces/:id/*path`
    /// wildcard proxy routes registered right after it.
    #[tokio::test]
    async fn diagnose_workspace_is_reachable_through_the_real_router() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            "http://127.0.0.1:5173",
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/workspaces/does-not-exist/diagnose")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
