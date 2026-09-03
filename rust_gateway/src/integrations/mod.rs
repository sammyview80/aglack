//! Third-party service integrations (Google, Slack, GitHub, ...).
//!
//! See `../../docs/integrations-plan.md` for the full architecture and
//! `../../docs/integrations-poc-findings.md` for the OpenConnector
//! tenancy spike this module's design is directly built from — in
//! particular the MCP proxy's strict allowlist (`mcp_proxy.rs`) exists
//! BECAUSE the spike proved OpenConnector accepts JSON-RPC batches and
//! several different ways to name a connection, none of which this
//! gateway may let a workspace container control.
//!
//! Scope of this slice (see `integration_connections.rs` `mod.rs` doc
//! comment in `../migrations/0005_integrations.sql` for what is
//! deliberately NOT here yet): `api_key`-auth connections only (matching
//! what the POC exercised), no outbox/rotation-atomicity, no OAuth
//! authorization-code flow. Real production hardening for those is
//! tracked separately, not silently skipped — see the plan doc's phase
//! list.

mod mcp_proxy;
pub mod openconnector;
mod providers;
pub mod route;
mod store;
pub mod token_delivery;

pub use openconnector::OpenConnectorClient;
pub use providers::{load_providers, Provider, ProvidersError};
pub use route::{
    connect_integration_route, disconnect_integration_route, integration_mcp_route,
    list_integrations_route, list_providers_route, IntegrationsState,
};
pub use store::IntegrationStore;
