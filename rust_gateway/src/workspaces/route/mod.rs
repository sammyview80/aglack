//! HTTP handlers for `/workspaces` and its per-id sub-routes. Each
//! submodule is one handler: translates the HTTP request/response shape
//! into a call to the workspace-lifecycle functions in the parent
//! `workspaces` module — no idempotency, container, or diagnosis logic
//! lives here, only translation. See `../../../docs/create-workspace-plan.md`,
//! `../../../docs/list-workspaces-plan.md`, `../../../docs/diagnose-workspace-plan.md`.
//!
//! Every response from these routes uses the shared envelope in
//! `crate::response` — `{ ok: true, data }` or
//! `{ ok: false, error: { code, message } }` — so the frontend has one
//! generic parser for both outcomes instead of a bespoke shape per route.

use std::sync::Arc;

use super::{ContainerLauncher, WorkspaceStore};
use crate::integrations::IntegrationsState;

pub fn workspace_target_host() -> String {
    configured_workspace_target_host(
        std::env::var("WORKSPACE_TARGET_HOST").ok(),
        std::env::var("WORKSPACE_GATEWAY_URL").ok(),
    )
}

fn configured_workspace_target_host(
    target_host: Option<String>,
    gateway_url: Option<String>,
) -> String {
    target_host
        .filter(|host| !host.trim().is_empty())
        .map(|host| host.trim().to_string())
        .or_else(|| {
            gateway_url
                .and_then(|raw| reqwest::Url::parse(&raw).ok())
                .and_then(|url| url.host_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

pub fn workspace_target_addr(port: u16) -> String {
    format!("{}:{port}", workspace_target_host())
}

mod create;
mod delete;
mod diagnose;
mod list;

pub use create::{create_workspace_route, create_workspace_route_authenticated};
pub use delete::delete_workspace_route;
pub use diagnose::diagnose_workspace_route;
pub use list::list_workspaces_route;
pub use list::list_workspaces_route_authenticated;

pub struct WorkspacesState {
    pub store: WorkspaceStore,
    pub launcher: Arc<dyn ContainerLauncher>,
    /// Reused HTTP client for forwarding onboarding calls to a specific
    /// workspace's wrapper — see `onboarding_proxy.rs` — and for
    /// `list.rs`'s live health checks. Lives here (not a separate state
    /// struct) because every route/proxy feature's only real dependency
    /// besides an HTTP client is this same `store`, for the workspace_id
    /// lookup.
    pub http_client: reqwest::Client,
    /// Needed ONLY by `create.rs`'s `create_workspace_route`, to mint and
    /// deliver a workspace's `/run/hermes/integrations.token` at creation
    /// time (sentinel-scoped, no real connection access — see that
    /// file's own doc comment) so the `open_browser`/`close_browser`/
    /// `browser_task` MCP tools (`backend/seeder/tools/`) have a token
    /// file to read even before this workspace's first real OpenConnector
    /// connect. The WHOLE `Arc<IntegrationsState>` (not just the
    /// `openconnector`/`token_cipher`/`IntegrationStore` pieces
    /// `issue_and_deliver_runtime_token` actually touches), because that
    /// struct already has real internal cohesion (see its own doc
    /// comment) and axum's `Router<S>` fixes ONE state type per route —
    /// `create_workspace_route` sits on the same `Arc<WorkspacesState>`
    /// router every other `/workspaces` route does (see `app::build_router`),
    /// so this is the only way to reach `IntegrationsState` from it
    /// without a second, parallel router for one route (the
    /// `browser_proxy_route` precedent `app::build_router` already uses
    /// doesn't fit here — see that function's own doc comment on why:
    /// this route's OTHER logic, name-collision + idempotency, is
    /// legitimately `WorkspacesState`-scoped and must not move to a
    /// second router).
    pub integrations: Arc<IntegrationsState>,
}

#[cfg(test)]
mod tests {
    use super::configured_workspace_target_host;

    #[test]
    fn explicit_target_host_is_independent_from_container_gateway_url() {
        assert_eq!(
            configured_workspace_target_host(
                Some("host.docker.internal".to_string()),
                Some("http://gateway:8080".to_string()),
            ),
            "host.docker.internal"
        );
    }

    #[test]
    fn legacy_config_falls_back_to_gateway_url_host() {
        assert_eq!(
            configured_workspace_target_host(
                None,
                Some("http://host.docker.internal:8080".to_string()),
            ),
            "host.docker.internal"
        );
    }
}
