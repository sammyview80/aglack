//! Gateway admin authentication — Phase 0a of
//! `docs/integrations-plan.md`. One deployment-wide admin credential
//! (Phase 0b, per-user accounts, is separate later work); an opaque
//! random session cookie, SHA-256-hashed at rest, no signing secret.
//!
//! Closes a real, previously-acknowledged gap: before this module,
//! ANYONE who could reach this gateway could create/delete workspaces
//! and read/write every integration connection — see this repo's own
//! README warning. `middleware::require_session` now gates every route
//! except the handful that must stay reachable without a session (see
//! that module's own doc comment).

mod middleware;
pub mod password;
mod route;
mod store;

pub use middleware::require_session;
pub use route::{login_route, logout_route, me_route, router, AuthState};
pub use store::SessionStore;
