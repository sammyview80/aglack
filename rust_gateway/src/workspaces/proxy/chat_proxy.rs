//! `ANY /workspaces/:id/chat/*path` (and its no-trailing-path sibling,
//! `/workspaces/:id/chat/`) — validates `id` via `resolve.rs` (must exist
//! AND be `ready`), then forwards the request to that specific workspace's
//! wrapper at `http://127.0.0.1:<wrapper_port>/<path>`, stripping only this
//! route's own `/workspaces/:id/chat` prefix.
//!
//! This does NOT go through `wrapper_prefix_proxy::forward_to_wrapper_namespace`
//! (unlike onboarding/agent-seeder/agent-history) because that helper
//! rewrites onto `/api/wrapper/v1/<namespace>/...` — a wrapper-native
//! namespace. Chat is different: it's upstream Hermes' OWN API, reached
//! through the wrapper's catch-all, the same surface `hermes_webui_proxy.rs`
//! already proxies whole. So `/workspaces/:id/chat/api/chat/start` must
//! become `/api/chat/start` on the wrapper port — a bare prefix strip, not
//! a namespace rewrite. Rather than contort the wrapper-namespace helper to
//! express that, this module has its own small forwarding function (mirrors
//! `hermes_webui_proxy.rs`'s local `hermes_webui_proxy` fn).
//!
//! The one thing this namespace adds beyond `hermes_webui_proxy.rs`: an
//! `?agent=<name>` query param is turned into a `Cookie: hermes_profile=<name>`
//! header on the outgoing request. See `docs/hermes-chat-wire-contract.md`
//! §6 for why — Hermes' per-agent chat visibility check is keyed on that
//! cookie, and neither a browser-global cookie nor `EventSource` (no custom
//! headers at all) can supply a different one per agent from a single
//! origin, so this proxy injects it server-side per request instead. See
//! `docs/chat-proxy-plan.md` for the full write-up. The injection itself
//! lives in `agent_cookie.rs` so `commands_proxy.rs` shares the exact same
//! validation and merge rules.

use axum::{
    extract::{Path, Request, State},
    response::Response,
};
use std::sync::Arc;

use super::agent_cookie::inject_agent_cookie;
use crate::proxy::forward_to;
use crate::workspaces::resolve::resolve_ready_workspace;
use crate::workspaces::route::WorkspacesState;

/// Handles `/workspaces/:id/chat/*path`.
pub async fn chat_proxy_route_with_path(
    State(state): State<Arc<WorkspacesState>>,
    Path((workspace_id, path)): Path<(String, String)>,
    req: Request,
) -> Response {
    chat_proxy(state, workspace_id, &path, req).await
}

/// Handles `/workspaces/:id/chat/` (exact prefix, no further segments) —
/// see `onboarding_proxy.rs`'s equivalent for why this needs its own
/// route+handler rather than one extractor covering both shapes.
pub async fn chat_proxy_route_root(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
    req: Request,
) -> Response {
    chat_proxy(state, workspace_id, "", req).await
}

async fn chat_proxy(
    state: Arc<WorkspacesState>,
    workspace_id: String,
    path: &str,
    mut req: Request,
) -> Response {
    let ports = match resolve_ready_workspace(&state.store, &workspace_id).await {
        Ok(ports) => ports,
        Err(response) => return response,
    };

    // `agent` is read from the query string but deliberately left IN the
    // forwarded query string below (not stripped) — Hermes ignores unknown
    // params, and leaving it keeps the forwarded URL an honest reflection
    // of the original request. See `agent_cookie.rs`.
    if let Err(response) = inject_agent_cookie(&mut req) {
        return response;
    }

    let target_addr = format!("127.0.0.1:{}", ports.wrapper_port);
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let rewritten_path = format!("/{path}{query}");

    forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::container::FakeLauncher;
    use crate::workspaces::test_support::{
        assert_not_ready_workspace_returns_409, assert_unknown_workspace_id_returns_404, temp_store,
    };
    use axum::{
        body::{to_bytes, Body},
        http::{Request as HttpRequest, StatusCode},
        routing::{any as any_method, Router},
    };

    fn state_with_store(store: crate::workspaces::WorkspaceStore) -> Arc<WorkspacesState> {
        crate::workspaces::test_support::state_with_store(store, Arc::new(FakeLauncher::default()))
    }

    /// Echoes back the path it received AND the `Cookie` header it received
    /// (as `path|cookie`, empty string if absent) — enough to assert both
    /// the rewrite and the cookie-injection contract against a real network
    /// hop, not a mock.
    async fn spawn_echo_wrapper() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind echo wrapper");
        let port = listener.local_addr().unwrap().port();
        let echo_handler = |req: HttpRequest<Body>| async move {
            let path = req
                .uri()
                .path_and_query()
                .map(|pq| pq.as_str().to_string())
                .unwrap_or_default();
            let cookie = req
                .headers()
                .get(axum::http::header::COOKIE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            format!("{path}|{cookie}")
        };
        let app: Router = Router::new()
            .route("/", any_method(echo_handler))
            .route("/*path", any_method(echo_handler));
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        port
    }

    async fn ready_state_with_echo() -> (Arc<WorkspacesState>, u16) {
        let echo_port = spawn_echo_wrapper().await;
        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "ws-1")
            .await
            .expect("begin_creation");
        store
            .mark_ready("my-workspace", "hermes-ws-ws-1", echo_port, 12345, 12346)
            .await
            .expect("mark_ready");
        (state_with_store(store), echo_port)
    }

    #[tokio::test]
    async fn unknown_workspace_id_returns_404() {
        assert_unknown_workspace_id_returns_404("chat", chat_proxy_route_root).await;
    }

    #[tokio::test]
    async fn not_ready_workspace_returns_409() {
        assert_not_ready_workspace_returns_409("chat", chat_proxy_route_root).await;
    }

    #[tokio::test]
    async fn ready_workspace_rewrites_path_to_hermes_native_api() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed, "/api/chat/start|");
    }

    #[tokio::test]
    async fn agent_query_param_injects_hermes_profile_cookie() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start?agent=pm")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed, "/api/chat/start?agent=pm|hermes_profile=pm");
    }

    #[tokio::test]
    async fn no_agent_param_injects_no_cookie() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed, "/api/chat/start|");
    }

    #[tokio::test]
    async fn header_injection_attempt_via_crlf_is_rejected_with_400() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start?agent=pm%0d%0aX-Evil:%201")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn agent_name_with_semicolon_is_rejected_with_400() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start?agent=pm;evil")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn existing_unrelated_cookie_survives_alongside_injected_one() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start?agent=pm")
                .header("Cookie", "session_id=abc123")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(
            echoed,
            "/api/chat/start?agent=pm|session_id=abc123; hermes_profile=pm"
        );
    }

    #[tokio::test]
    async fn query_string_is_preserved_through_the_rewrite() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/stream".to_string())),
            HttpRequest::builder()
                .method("GET")
                .uri("/workspaces/ws-1/chat/api/chat/stream?stream_id=abc&replay=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed, "/api/chat/stream?stream_id=abc&replay=1|");
    }
}
