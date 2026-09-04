//! Google OAuth login with opaque random session cookies, SHA-256-hashed
//! at rest.
//!
//! Closes a real, previously-acknowledged gap: before this module,
//! ANYONE who could reach this gateway could create/delete workspaces
//! and read/write every integration connection — see this repo's own
//! README warning. `middleware::require_session` now gates every route
//! except the handful that must stay reachable without a session (see
//! that module's own doc comment).

mod middleware;
mod route;
mod store;

pub use middleware::require_session;
pub use route::{
    google_callback_route, google_start_route, logout_route, me_route, router, AuthState,
};
pub use store::SessionStore;

#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub google_sub: String,
    pub email: String,
}
