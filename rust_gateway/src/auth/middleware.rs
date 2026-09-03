//! The gateway-wide session check. Wraps the ENTIRE merged app in
//! `bin/rust_gateway.rs` (not `app::build_router` itself — same reasoning
//! as the second `CorsLayer` added there: touching a function with ten
//! pinned tests is worse than composing one more layer around its
//! output), with a small, explicit path-based exemption list for the
//! handful of routes that must stay reachable without a session:
//! `/auth/*` (or nobody could ever log in), `/oauth/callback` (a
//! provider's redirect, never carries this gateway's own cookie), and
//! `/workspaces/:id/mcp` (a workspace container's own bearer-protected
//! tenancy proxy — see `integrations::mcp_proxy` — a container has no
//! session cookie of its own and must not need one).

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

use super::route::{read_session_cookie, AuthState};
use crate::crypto::sha256_hex;
use crate::response::error;

/// Exact-prefix exemptions — checked before any session lookup, so an
/// unauthenticated caller hitting one of these never even causes a
/// database read. `/workspaces/` alone is NOT exempt (only the specific
/// `/mcp` suffix is) — every other `/workspaces/:id/...` route (create,
/// list, integrations connect/disconnect/agents) requires a session.
fn is_exempt(path: &str) -> bool {
    path.starts_with("/auth/")
        || path == "/oauth/callback"
        || (path.starts_with("/workspaces/") && path.ends_with("/mcp"))
}

pub async fn require_session(
    State(state): State<Arc<AuthState>>,
    request: Request,
    next: Next,
) -> Response {
    if is_exempt(request.uri().path()) {
        return next.run(request).await;
    }

    let Some(raw_token) = read_session_cookie(request.headers()) else {
        return error(
            StatusCode::UNAUTHORIZED,
            "not_authenticated",
            "Log in first.",
        );
    };

    match state.sessions.is_valid(&sha256_hex(&raw_token)).await {
        Ok(true) => next.run(request).await,
        Ok(false) => error(StatusCode::UNAUTHORIZED, "not_authenticated", "Log in first."),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_lookup_failed",
            err.to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_routes_are_exempt() {
        assert!(is_exempt("/auth/login"));
        assert!(is_exempt("/auth/logout"));
        assert!(is_exempt("/auth/me"));
    }

    #[test]
    fn oauth_callback_is_exempt() {
        assert!(is_exempt("/oauth/callback"));
    }

    #[test]
    fn a_workspace_mcp_route_is_exempt() {
        assert!(is_exempt("/workspaces/abc-123/mcp"));
    }

    #[test]
    fn other_workspace_routes_are_not_exempt() {
        assert!(!is_exempt("/workspaces"));
        assert!(!is_exempt("/workspaces/abc-123"));
        assert!(!is_exempt("/workspaces/abc-123/integrations"));
        assert!(!is_exempt(
            "/workspaces/abc-123/integrations/github/connect"
        ));
        assert!(!is_exempt("/workspaces/abc-123/integrations/agents/writer"));
    }

    #[test]
    fn the_integrations_providers_catalog_is_not_exempt() {
        assert!(!is_exempt("/integrations/providers"));
    }

    #[test]
    fn a_path_that_merely_contains_mcp_is_not_exempt() {
        // Guards against a naive `.contains("mcp")` check — must be an
        // exact suffix match on the real tenancy-proxy path shape only.
        assert!(!is_exempt("/workspaces/abc-123/mcpfoo"));
        assert!(!is_exempt("/mcp-something-else"));
    }
}
