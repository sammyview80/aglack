//! Everything related to forwarding a request to a backend lives under
//! this module, isolated from route registration (`app.rs`) and process
//! bootstrapping (`bin/rust_gateway.rs`). See `forward.rs` for the actual
//! forwarding logic and its known current limitation (one fixed backend,
//! no per-tenant lookup yet).

mod forward;

pub use forward::forward;

/// State the proxy layer needs on every request: an HTTP client (reused
/// across requests — cheap to clone, expensive to recreate per-request)
/// and the backend address to forward to.
///
/// This becomes a tenant/container lookup (a registry, likely backed by
/// the SQLite/Postgres datastore described in
/// ../../../backend/wrapper/docs/rust-gateway-architecture.md) instead of
/// one fixed `backend_addr` once that exists. Do not add fields here for
/// features that are not yet built.
pub struct ProxyState {
    pub http_client: reqwest::Client,
    pub backend_addr: String,
}
