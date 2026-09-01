//! Everything related to forwarding a request to a backend lives under
//! this module, isolated from route registration (`app.rs`) and process
//! bootstrapping (`bin/rust_gateway.rs`). See `forward.rs` for the actual
//! forwarding logic. Per-tenant resolution now exists for exactly one
//! route (`workspaces::onboarding_proxy`, resolved by `workspace_id` via
//! the workspaces store) — `ProxyState`/`forward` below remain the
//! fixed-one-backend path used by every OTHER request; do not add
//! per-tenant fields here, extend the workspaces store lookup instead.

mod forward;

pub use forward::{forward, forward_to};

/// State the proxy layer needs on every request: an HTTP client (reused
/// across requests — cheap to clone, expensive to recreate per-request)
/// and the backend address to forward to.
pub struct ProxyState {
    pub http_client: reqwest::Client,
    pub backend_addr: String,
}
