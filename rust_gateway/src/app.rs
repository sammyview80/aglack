//! Builds the axum `Router` — route registration only. Keeping this
//! separate from `bin/rust_gateway.rs` (process bootstrapping: config
//! loading, binding a listener, starting the server) means a future
//! integration test can build and exercise a `Router` directly, in-process,
//! without spawning a real subprocess bound to a real port.

use axum::{routing::any, routing::post, Router};
use std::sync::Arc;

use crate::proxy::{forward, ProxyState};
use crate::workspaces::{create_workspace_route, WorkspacesState};

/// Build the full router for this gateway.
///
/// Route order matters here: `/workspaces` is registered before the
/// catch-all proxy route, so it is never accidentally forwarded to the
/// backend instead of being handled by `create_workspace_route`.
pub fn build_router(proxy_state: Arc<ProxyState>, workspaces_state: Arc<WorkspacesState>) -> Router {
    let workspaces_router = Router::new()
        .route("/workspaces", post(create_workspace_route))
        .with_state(workspaces_state);

    let proxy_router = Router::new()
        .route("/", any(forward))
        .route("/*path", any(forward))
        .with_state(proxy_state);

    workspaces_router.merge(proxy_router)
}
