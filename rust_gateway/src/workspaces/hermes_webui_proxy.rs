//! `ANY /workspaces/:id/hermes-webui/*path` (and its no-trailing-path
//! sibling, `/workspaces/:id/hermes-webui/`) — validates `id` via
//! `resolve.rs` (must exist AND be `ready`), then forwards the request,
//! UNRESTRICTED, to that specific workspace's wrapper at
//! `http://127.0.0.1:<wrapper_port>/<path>`.
//!
//! Unlike `onboarding_proxy.rs` (which only targets that wrapper's
//! `/api/wrapper/v1/onboarding/*` namespace), this route is the workspace's
//! WHOLE web app: the wrapper's own native `/api/wrapper/v1/*` routes AND
//! everything else the wrapper's catch-all proxies into the pinned
//! upstream Hermes WebUI (its own UI/API, chat, sessions, ...) — see
//! `backend/wrapper/src/hermes_webui_wrapper/app.py`'s `create_app` for
//! what the wrapper itself answers on its one port. This route is simply
//! "reach this one workspace's version of that entire app", the same way
//! `proxy::forward` reaches ITS one fixed backend today, just resolved
//! per-workspace instead of fixed.

use axum::{
    extract::{Path, Request, State},
    response::Response,
};
use std::sync::Arc;

use super::resolve::resolve_ready_workspace;
use super::route::WorkspacesState;
use crate::proxy::forward_to;

/// Handles `/workspaces/:id/hermes-webui/*path`.
pub async fn hermes_webui_proxy_route_with_path(
    State(state): State<Arc<WorkspacesState>>,
    Path((workspace_id, path)): Path<(String, String)>,
    req: Request,
) -> Response {
    hermes_webui_proxy(state, workspace_id, &path, req).await
}

/// Handles `/workspaces/:id/hermes-webui/` (exact prefix, no further
/// segments) — see `onboarding_proxy.rs`'s equivalent for why this needs
/// its own route+handler rather than one extractor covering both shapes.
pub async fn hermes_webui_proxy_route_root(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
    req: Request,
) -> Response {
    hermes_webui_proxy(state, workspace_id, "", req).await
}

async fn hermes_webui_proxy(
    state: Arc<WorkspacesState>,
    workspace_id: String,
    path: &str,
    req: Request,
) -> Response {
    let ports = match resolve_ready_workspace(&state.store, &workspace_id).await {
        Ok(ports) => ports,
        Err(response) => return response,
    };

    let target_addr = format!("127.0.0.1:{}", ports.wrapper_port);
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    // No namespace restriction here (unlike onboarding_proxy.rs) — `path`
    // is forwarded to the wrapper's ROOT, since this route stands in for
    // the whole app, not one feature of it.
    let rewritten_path = format!("/{path}{query}");

    forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_support::{body_json, temp_store};
    use crate::workspaces::container::FakeLauncher;
    use axum::{
        body::{to_bytes, Body},
        http::{Request as HttpRequest, StatusCode},
        routing::{any as any_method, Router},
    };

    fn state_with_store(store: crate::workspaces::WorkspaceStore) -> Arc<WorkspacesState> {
        super::super::test_support::state_with_store(store, Arc::new(FakeLauncher::default()))
    }

    async fn spawn_echo_wrapper() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind echo wrapper");
        let port = listener.local_addr().unwrap().port();
        // axum's `/*path` wildcard does NOT match a bare `/` request (it
        // requires at least one segment) — a real HTTP server would
        // usually have its own explicit `/` handler distinct from a
        // catch-all, so this test double needs the same two-route shape
        // to faithfully stand in for one (this is a limitation of this
        // ECHO fixture only, not of hermes_webui_proxy's real forwarding
        // logic — see the `root_path_forwards_to_wrapper_bare_root` test
        // below, which exists specifically to catch this).
        let echo_handler = |req: HttpRequest<Body>| async move {
            req.uri()
                .path_and_query()
                .map(|pq| pq.as_str().to_string())
                .unwrap_or_default()
        };
        let app: Router = Router::new()
            .route("/", any_method(echo_handler))
            .route("/*path", any_method(echo_handler));
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        port
    }

    #[tokio::test]
    async fn unknown_workspace_id_returns_404() {
        let state = state_with_store(temp_store().await);

        let response = hermes_webui_proxy_route_root(
            State(state),
            Path("does-not-exist".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/does-not-exist/hermes-webui/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_found");
    }

    #[tokio::test]
    async fn not_ready_workspace_returns_409() {
        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "ws-1")
            .await
            .expect("begin_creation");
        let state = state_with_store(store);

        let response = hermes_webui_proxy_route_root(
            State(state),
            Path("ws-1".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/hermes-webui/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_ready");
    }

    /// Unlike onboarding_proxy.rs, ANY path (not just a fixed namespace)
    /// must reach the wrapper's root unmodified — proving the whole-app
    /// forwarding contract, e.g. a chat/session/upstream-catch-all path.
    #[tokio::test]
    async fn ready_workspace_forwards_arbitrary_path_to_wrapper_root() {
        let echo_port = spawn_echo_wrapper().await;

        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "ws-1")
            .await
            .expect("begin_creation");
        store
            .mark_ready("my-workspace", "hermes-ws-ws-1", echo_port, 12345)
            .await
            .expect("mark_ready");
        let state = state_with_store(store);

        let response = hermes_webui_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/sessions".to_string())),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/hermes-webui/api/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(String::from_utf8(bytes.to_vec()).unwrap(), "/api/sessions");
    }

    #[tokio::test]
    async fn root_path_forwards_to_wrapper_bare_root() {
        let echo_port = spawn_echo_wrapper().await;

        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "ws-1")
            .await
            .expect("begin_creation");
        store
            .mark_ready("my-workspace", "hermes-ws-ws-1", echo_port, 12345)
            .await
            .expect("mark_ready");
        let state = state_with_store(store);

        let response = hermes_webui_proxy_route_root(
            State(state),
            Path("ws-1".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/hermes-webui/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(String::from_utf8(bytes.to_vec()).unwrap(), "/");
    }
}
