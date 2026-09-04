//! Shared forwarding logic for every `ANY /workspaces/:id/<namespace>/*path`
//! proxy route (onboarding, agent-seeder, and any future wrapper-namespace
//! proxy): validates `id` via `resolve.rs` (must exist AND be `ready`),
//! then forwards the request to that specific workspace's wrapper at
//! `http://127.0.0.1:<wrapper_port>/api/wrapper/v1/<namespace>[/<path>]`,
//! preserving the original request's query string.
//!
//! Each namespace (`onboarding_proxy.rs`, `agent_seeder_proxy.rs`, ...)
//! keeps its own pair of thin axum handlers — axum needs distinct handler
//! functions per route — that just call `forward_to_wrapper_namespace`
//! with their namespace prefix.

use axum::{extract::Request, response::Response};
use std::sync::Arc;

use crate::proxy::forward_to;
use crate::workspaces::resolve::resolve_ready_workspace;
use crate::workspaces::route::{workspace_target_addr, WorkspacesState};

pub(super) async fn forward_to_wrapper_namespace(
    state: Arc<WorkspacesState>,
    workspace_id: String,
    namespace: &str,
    path: &str,
    req: Request,
) -> Response {
    let ports = match resolve_ready_workspace(&state.store, &workspace_id).await {
        Ok(ports) => ports,
        Err(response) => return response,
    };

    let target_addr = workspace_target_addr(ports.wrapper_port);
    // Preserve the original request's query string (e.g. GET
    // /oauth/poll?flow_id=... — see backend/wrapper's onboarding routes) —
    // only the PATH is being rewritten to strip this route's own
    // `/workspaces/:id/<namespace>` prefix.
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let rewritten_path = if path.is_empty() {
        format!("/api/wrapper/v1/{namespace}{query}")
    } else {
        format!("/api/wrapper/v1/{namespace}/{path}{query}")
    };

    forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
}
