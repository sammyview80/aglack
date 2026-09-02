//! `ANY /workspaces/:id/onboarding/*path` (and its no-trailing-path
//! sibling, `/workspaces/:id/onboarding/`) — thin handler pair delegating
//! to `wrapper_prefix_proxy::forward_to_wrapper_namespace` with namespace
//! `"onboarding"` (see
//! `backend/wrapper/src/hermes_webui_wrapper/api/v1/onboarding.py` for the
//! wrapper-side routes this forwards to).
//!
//! See `hermes_webui_proxy.rs` for the broader sibling route that forwards
//! EVERYTHING to the same wrapper (this route only narrows the target
//! path prefix; the id-validation logic is shared via `resolve.rs`).

use axum::{
    extract::{Path, Request, State},
    response::Response,
};
use std::sync::Arc;

use crate::workspaces::route::WorkspacesState;
use super::wrapper_prefix_proxy::forward_to_wrapper_namespace;

/// Handles `/workspaces/:id/onboarding/*path` — axum captures both
/// segments, so `path` is always present here (possibly empty only if a
/// client somehow sends a literal empty wildcard segment).
pub async fn onboarding_proxy_route_with_path(
    State(state): State<Arc<WorkspacesState>>,
    Path((workspace_id, path)): Path<(String, String)>,
    req: Request,
) -> Response {
    forward_to_wrapper_namespace(state, workspace_id, "onboarding", &path, req).await
}

/// Handles `/workspaces/:id/onboarding/` (the exact prefix, no further
/// segments) — axum captures only `id` here; there is no `*path` match
/// arm for a zero-segment tail, so this is a separate route+handler
/// rather than trying to make one extractor cover both shapes.
pub async fn onboarding_proxy_route_root(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
    req: Request,
) -> Response {
    forward_to_wrapper_namespace(state, workspace_id, "onboarding", "", req).await
}

#[cfg(test)]
mod tests {
    use crate::workspaces::test_support::{
        assert_failed_workspace_returns_409_not_ready, assert_not_ready_workspace_returns_409,
        assert_unknown_workspace_id_returns_404, spawn_echo_wrapper, temp_store,
    };
    use super::*;
    use crate::workspaces::container::FakeLauncher;
    use axum::{
        body::{to_bytes, Body},
        http::{Request as HttpRequest, StatusCode},
    };

    fn state_with_store(store: crate::workspaces::WorkspaceStore) -> Arc<WorkspacesState> {
        crate::workspaces::test_support::state_with_store(store, Arc::new(FakeLauncher::default()))
    }

    #[tokio::test]
    async fn unknown_workspace_id_returns_404() {
        assert_unknown_workspace_id_returns_404("onboarding", onboarding_proxy_route_root).await;
    }

    /// A workspace that exists but never finished creating (still
    /// `creating`, no ports yet) must be rejected — this is the exact
    /// "only the successfully created workspace can be reached" rule.
    #[tokio::test]
    async fn not_ready_workspace_returns_409() {
        assert_not_ready_workspace_returns_409("onboarding", onboarding_proxy_route_root).await;
    }

    /// A `failed` workspace (a previous launch attempt that errored out)
    /// must also be rejected — `Ready` is the only acceptable status, not
    /// merely "not creating".
    #[tokio::test]
    async fn failed_workspace_returns_409_not_ready() {
        assert_failed_workspace_returns_409_not_ready("onboarding", onboarding_proxy_route_root)
            .await;
    }

    /// The real end-to-end case: a `ready` workspace's request is
    /// forwarded to its ACTUAL recorded wrapper port, with the
    /// `/workspaces/:id/onboarding` prefix stripped and replaced by
    /// `/api/wrapper/v1/onboarding` — proven by a real echo server on a
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
            .mark_ready("my-workspace", "hermes-ws-ws-1", echo_port, 12345)
            .await
            .expect("mark_ready");
        let state = state_with_store(store);

        let response = onboarding_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "status".to_string())),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/onboarding/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed_path = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed_path, "/api/wrapper/v1/onboarding/status");
    }

    /// Same as above, but the ROOT route (`_route_root`, the exact
    /// `/workspaces/:id/onboarding/` prefix with no further segments) —
    /// only the `_with_path` variant had a `ready` case covered before
    /// this test; `hermes_webui_proxy.rs`'s equivalent
    /// (`root_path_forwards_to_wrapper_bare_root`) already had this
    /// coverage, this file didn't.
    #[tokio::test]
    async fn ready_workspace_forwards_root_path_to_its_recorded_wrapper_port() {
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

        let response = onboarding_proxy_route_root(
            State(state),
            Path("ws-1".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/onboarding/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed_path = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(
            echoed_path, "/api/wrapper/v1/onboarding",
            "root path (no further segments) must rewrite to the bare onboarding \
             namespace root, not a trailing slash or an empty string"
        );
    }

    /// A query string on the original request (e.g. GET
    /// /oauth/poll?flow_id=...) must survive the path rewrite.
    #[tokio::test]
    async fn query_string_is_preserved_through_the_rewrite() {
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

        let response = onboarding_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "oauth/poll".to_string())),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/onboarding/oauth/poll?flow_id=abc123")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed_path = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(
            echoed_path,
            "/api/wrapper/v1/onboarding/oauth/poll?flow_id=abc123"
        );
    }
}
