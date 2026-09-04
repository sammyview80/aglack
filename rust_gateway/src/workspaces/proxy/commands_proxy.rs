//! `ANY /workspaces/:id/commands/*path` (and its no-trailing-path sibling,
//! `/workspaces/:id/commands/`) — validates `id` via `resolve.rs` (must
//! exist AND be `ready`), then forwards the request to that specific
//! workspace's wrapper at
//! `http://127.0.0.1:<wrapper_port>/api/wrapper/v1/commands[/<path>]`,
//! preserving the original request's query string (see
//! `backend/wrapper/src/hermes_webui_wrapper/api/v1/commands.py` for the
//! wrapper-side routes this forwards to).
//!
//! This composes two existing patterns that neither helper covers alone:
//!
//! * the `/api/wrapper/v1/<namespace>` path rewrite of
//!   `wrapper_prefix_proxy::forward_to_wrapper_namespace` (commands is a
//!   wrapper-NATIVE namespace, unlike chat which is upstream Hermes' own
//!   API surface), and
//! * the `?agent=<name>` -> `Cookie: hermes_profile=<name>` injection of
//!   `chat_proxy.rs` (shared via `agent_cookie.rs`), because the wrapper's
//!   command endpoints resolve the target Hermes profile from that cookie
//!   exactly like Hermes' chat endpoints do.
//!
//! The cookie must be set BEFORE the request is handed to the namespace
//! forwarder, so this module injects first and then delegates the rewrite
//! and forward to `forward_to_wrapper_namespace` unchanged.

use axum::{
    extract::{Path, Request, State},
    response::Response,
};
use std::sync::Arc;

use super::agent_cookie::inject_agent_cookie;
use super::wrapper_prefix_proxy::forward_to_wrapper_namespace;
use crate::workspaces::route::WorkspacesState;

const NAMESPACE: &str = "commands";

/// Handles `/workspaces/:id/commands/*path`.
pub async fn commands_proxy_route_with_path(
    State(state): State<Arc<WorkspacesState>>,
    Path((workspace_id, path)): Path<(String, String)>,
    req: Request,
) -> Response {
    commands_proxy(state, workspace_id, &path, req).await
}

/// Handles `/workspaces/:id/commands/` (exact prefix, no further segments)
/// — see `onboarding_proxy.rs`'s equivalent for why this needs its own
/// route+handler rather than one extractor covering both shapes.
pub async fn commands_proxy_route_root(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
    req: Request,
) -> Response {
    commands_proxy(state, workspace_id, "", req).await
}

async fn commands_proxy(
    state: Arc<WorkspacesState>,
    workspace_id: String,
    path: &str,
    mut req: Request,
) -> Response {
    // `agent` stays in the forwarded query string (not stripped) — same
    // reasoning as `chat_proxy.rs`; see `agent_cookie.rs`. Validation
    // happens before the workspace lookup purely because it needs no I/O
    // (avoids a DB round-trip for a request that's malformed regardless
    // of which workspace it names); the 404/409 workspace checks still
    // run for every well-formed request inside `forward_to_wrapper_namespace`.
    //
    // This is a DELIBERATE ordering divergence from `chat_proxy.rs`, which
    // resolves the workspace (404/409) BEFORE validating `agent` — so a
    // malformed `agent=` against a nonexistent workspace returns 400 here
    // but would return 404 from the equivalent chat request. Not a
    // security issue (400 leaks strictly less workspace-existence
    // information than 404 would, if anything), just a real behavioral
    // difference between two proxies that otherwise share this same
    // cookie-injection logic — noted here so it isn't mistaken for a bug.
    if let Err(response) = inject_agent_cookie(&mut req) {
        return response;
    }
    forward_to_wrapper_namespace(state, workspace_id, NAMESPACE, path, req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::container::FakeLauncher;
    use crate::workspaces::test_support::{
        assert_failed_workspace_returns_409_not_ready, assert_not_ready_workspace_returns_409,
        assert_unknown_workspace_id_returns_404, temp_store,
    };
    use axum::{
        body::{to_bytes, Body},
        http::{Request as HttpRequest, StatusCode},
        routing::{any as any_method, Router},
    };

    fn state_with_store(store: crate::workspaces::WorkspaceStore) -> Arc<WorkspacesState> {
        crate::workspaces::test_support::state_with_store(store, Arc::new(FakeLauncher::default()))
    }

    /// Local variant of `test_support::spawn_echo_wrapper` (which echoes
    /// only the path): echoes `path|cookie` so the cookie-injection
    /// contract can be asserted across a real network hop, exactly as
    /// `chat_proxy.rs`'s own local echo does.
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

    async fn echoed(response: Response) -> String {
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn unknown_workspace_id_returns_404() {
        assert_unknown_workspace_id_returns_404("commands", commands_proxy_route_root).await;
    }

    #[tokio::test]
    async fn not_ready_workspace_returns_409() {
        assert_not_ready_workspace_returns_409("commands", commands_proxy_route_root).await;
    }

    #[tokio::test]
    async fn failed_workspace_returns_409_not_ready() {
        assert_failed_workspace_returns_409_not_ready("commands", commands_proxy_route_root).await;
    }

    /// `/workspaces/:id/commands/<path>` must land on the wrapper-native
    /// `/api/wrapper/v1/commands/<path>` — NOT a bare `/<path>` strip like
    /// `chat_proxy.rs`.
    #[tokio::test]
    async fn ready_workspace_forwards_to_its_recorded_wrapper_port_with_rewritten_path() {
        let (state, _port) = ready_state_with_echo().await;

        let response = commands_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "run".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/commands/run")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(echoed(response).await, "/api/wrapper/v1/commands/run|");
    }

    #[tokio::test]
    async fn ready_workspace_forwards_root_path() {
        let (state, _port) = ready_state_with_echo().await;

        let response = commands_proxy_route_root(
            State(state),
            Path("ws-1".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/commands/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(
            echoed(response).await,
            "/api/wrapper/v1/commands|",
            "root path (no further segments) must rewrite to the bare commands \
             namespace root, not a trailing slash or an empty string"
        );
    }

    #[tokio::test]
    async fn agent_query_param_injects_hermes_profile_cookie() {
        let (state, _port) = ready_state_with_echo().await;

        let response = commands_proxy_route_root(
            State(state),
            Path("ws-1".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/commands/?agent=pm")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(
            echoed(response).await,
            "/api/wrapper/v1/commands?agent=pm|hermes_profile=pm"
        );
    }

    #[tokio::test]
    async fn no_agent_param_injects_no_cookie() {
        let (state, _port) = ready_state_with_echo().await;

        let response = commands_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "run".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/commands/run")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(echoed(response).await, "/api/wrapper/v1/commands/run|");
    }

    #[tokio::test]
    async fn header_injection_attempt_via_crlf_is_rejected_with_400() {
        let (state, _port) = ready_state_with_echo().await;

        let response = commands_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "run".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/commands/run?agent=pm%0d%0aX-Evil:%201")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn agent_name_with_semicolon_is_rejected_with_400() {
        let (state, _port) = ready_state_with_echo().await;

        let response = commands_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "run".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/commands/run?agent=pm;evil")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn existing_unrelated_cookie_survives_alongside_injected_one() {
        let (state, _port) = ready_state_with_echo().await;

        let response = commands_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "run".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/commands/run?agent=pm")
                .header("Cookie", "session_id=abc123")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(
            echoed(response).await,
            "/api/wrapper/v1/commands/run?agent=pm|session_id=abc123; hermes_profile=pm"
        );
    }

    /// The full query string — including `agent`, which is deliberately
    /// NOT stripped — must survive the namespace rewrite.
    #[tokio::test]
    async fn query_string_is_preserved_through_the_rewrite() {
        let (state, _port) = ready_state_with_echo().await;

        let response = commands_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "run".to_string())),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/commands/run?profile=pm&agent=pm&limit=5")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(
            echoed(response).await,
            "/api/wrapper/v1/commands/run?profile=pm&agent=pm&limit=5|hermes_profile=pm"
        );
    }
}
