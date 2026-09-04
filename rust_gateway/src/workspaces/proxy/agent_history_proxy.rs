//! `ANY /workspaces/:id/agent-history/*path` (and its no-trailing-path
//! sibling, `/workspaces/:id/agent-history/`) — thin handler pair
//! delegating to `wrapper_prefix_proxy::forward_to_wrapper_namespace` with
//! namespace `"agent-history"` (see
//! `backend/wrapper/src/hermes_webui_wrapper/api/v1/agent_history.py` for
//! the wrapper-side routes this forwards to).
//!
//! Structurally identical to `onboarding_proxy.rs` — see that module's own
//! doc comment for the full explanation of the root-vs-wildcard route
//! split this mirrors.

use axum::{
    extract::{Path, Request, State},
    response::Response,
};
use std::sync::Arc;

use super::wrapper_prefix_proxy::forward_to_wrapper_namespace;
use crate::workspaces::route::WorkspacesState;

/// Handles `/workspaces/:id/agent-history/*path` — axum captures both
/// segments, so `path` is always present here (possibly empty only if a
/// client somehow sends a literal empty wildcard segment).
pub async fn agent_history_proxy_route_with_path(
    State(state): State<Arc<WorkspacesState>>,
    Path((workspace_id, path)): Path<(String, String)>,
    req: Request,
) -> Response {
    forward_to_wrapper_namespace(state, workspace_id, "agent-history", &path, req).await
}

/// Handles `/workspaces/:id/agent-history/` (the exact prefix, no further
/// segments) — axum captures only `id` here; there is no `*path` match
/// arm for a zero-segment tail, so this is a separate route+handler
/// rather than trying to make one extractor cover both shapes.
pub async fn agent_history_proxy_route_root(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
    req: Request,
) -> Response {
    forward_to_wrapper_namespace(state, workspace_id, "agent-history", "", req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::container::FakeLauncher;
    use crate::workspaces::test_support::{
        assert_failed_workspace_returns_409_not_ready, assert_not_ready_workspace_returns_409,
        assert_unknown_workspace_id_returns_404, spawn_echo_wrapper, temp_store,
    };
    use axum::{
        body::{to_bytes, Body},
        http::{Request as HttpRequest, StatusCode},
    };

    fn state_with_store(store: crate::workspaces::WorkspaceStore) -> Arc<WorkspacesState> {
        crate::workspaces::test_support::state_with_store(store, Arc::new(FakeLauncher::default()))
    }

    #[tokio::test]
    async fn unknown_workspace_id_returns_404() {
        assert_unknown_workspace_id_returns_404("agent-history", agent_history_proxy_route_root)
            .await;
    }

    #[tokio::test]
    async fn not_ready_workspace_returns_409() {
        assert_not_ready_workspace_returns_409("agent-history", agent_history_proxy_route_root)
            .await;
    }

    #[tokio::test]
    async fn failed_workspace_returns_409_not_ready() {
        assert_failed_workspace_returns_409_not_ready(
            "agent-history",
            agent_history_proxy_route_root,
        )
        .await;
    }

    /// The real end-to-end case: a `ready` workspace's request is
    /// forwarded to its ACTUAL recorded wrapper port, with the
    /// `/workspaces/:id/agent-history` prefix stripped and replaced by
    /// `/api/wrapper/v1/agent-history` — proven by a real echo server on a
    /// real OS-assigned port, not a mock.
    #[tokio::test]
    async fn ready_workspace_forwards_to_its_recorded_wrapper_port_with_rewritten_path() {
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
        let state = state_with_store(store);

        let response = agent_history_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "agents/pm/sessions".to_string())),
            HttpRequest::builder()
                .method("GET")
                .uri("/workspaces/ws-1/agent-history/agents/pm/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed_path = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(
            echoed_path,
            "/api/wrapper/v1/agent-history/agents/pm/sessions"
        );
    }

    /// Same as above, but the ROOT route (`_route_root`, the exact
    /// `/workspaces/:id/agent-history/` prefix with no further segments).
    #[tokio::test]
    async fn ready_workspace_forwards_root_path_to_its_recorded_wrapper_port() {
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
        let state = state_with_store(store);

        let response = agent_history_proxy_route_root(
            State(state),
            Path("ws-1".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/agent-history/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed_path = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(
            echoed_path, "/api/wrapper/v1/agent-history",
            "root path (no further segments) must rewrite to the bare agent-history \
             namespace root, not a trailing slash or an empty string"
        );
    }

    /// A query string on the original request must survive the path
    /// rewrite — this feature's pagination (`?limit=&offset=`) depends on
    /// it (mirrors onboarding_proxy.rs's equivalent coverage for
    /// GET /oauth/poll?flow_id=...).
    #[tokio::test]
    async fn query_string_is_preserved_through_the_rewrite() {
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
        let state = state_with_store(store);

        let response = agent_history_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "agents/pm/sessions".to_string())),
            HttpRequest::builder()
                .method("GET")
                .uri("/workspaces/ws-1/agent-history/agents/pm/sessions?limit=50&offset=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed_path = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(
            echoed_path,
            "/api/wrapper/v1/agent-history/agents/pm/sessions?limit=50&offset=0"
        );
    }
}
