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

mod create;
mod delete;
mod diagnose;
mod list;

pub use create::create_workspace_route;
pub use delete::delete_workspace_route;
pub use diagnose::diagnose_workspace_route;
pub use list::list_workspaces_route;

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
}
