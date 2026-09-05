//! The gateway-wide session check. Wraps the ENTIRE merged app in
//! `bin/rust_gateway.rs` (not `app::build_router` itself — same reasoning
//! as the second `CorsLayer` added there: touching a function with ten
//! pinned tests is worse than composing one more layer around its
//! output), with a small, explicit path-based exemption list for the
//! handful of routes that must stay reachable without a session:
//! `/auth/*` (or nobody could ever log in), `/oauth/callback` (a
//! provider's redirect, never carries this gateway's own cookie),
//! `/workspaces/:id/mcp` (a workspace container's own bearer-protected
//! tenancy proxy — see `integrations::mcp_proxy` — a container has no
//! session cookie of its own and must not need one), and
//! `/workspaces/:id/browser/...` (same reasoning as `/mcp`: called FROM
//! INSIDE the workspace's own container by an MCP tool, gated by the
//! SAME per-workspace bearer via `integrations::mcp_proxy::require_workspace_bearer`
//! — see `browser_proxy.rs`). The browser path does NOT end in `/mcp`, so
//! it needs its own condition, OR'd onto the existing mcp check rather
//! than folded into (and potentially loosening) it.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

use super::route::{read_session_cookie, AuthState};
use super::AuthenticatedUser;
use crate::crypto::sha256_hex;
use crate::response::error;

/// Exact-prefix exemptions — checked before any session lookup, so an
/// unauthenticated caller hitting one of these never even causes a
/// database read. `/workspaces/` alone is NOT exempt (only the specific
/// `/mcp` suffix and the `/browser/` prefix shape below are) — every
/// other `/workspaces/:id/...` route (create, list, integrations
/// connect/disconnect/agents) requires a session.
///
/// The browser condition matches `/workspaces/<id>/browser/` as a
/// PREFIX (not a suffix like `/mcp`, since the real path has more
/// segments after it: `/agent_id/action`) — deliberately a separate OR'd
/// condition, not a change to the existing mcp check, so the mcp path
/// shape's own exact-suffix match stays exactly as strict as it already
/// was.
fn is_exempt(path: &str) -> bool {
    path.starts_with("/auth/")
        || path == "/oauth/callback"
        || (path.starts_with("/workspaces/") && path.ends_with("/mcp"))
        || is_workspace_browser_path(path)
}

/// True for `/workspaces/<id>/browser/...` — matched as a prefix ending
/// in a literal `/browser/` segment boundary, not a naive `.contains("browser")`
/// or a bare `.ends_with("browser")` (which a wrong-but-similar path like
/// `/workspaces/abc-123/browserish` would also match if the boundary
/// slash were dropped).
fn is_workspace_browser_path(path: &str) -> bool {
    path.starts_with("/workspaces/")
        && path
            .strip_prefix("/workspaces/")
            .is_some_and(|rest| rest.split_once("/browser/").is_some())
}

/// Workspace routes exist in both the historical `/workspaces/...` namespace
/// and the JSON-only `/api/workspaces/...` namespace. Both must pass through
/// the same ownership check; otherwise an `/api` alias could expose another
/// user's workspace when its UUID is known.
fn workspace_id_from_path(path: &str) -> Option<&str> {
    ["/workspaces/", "/api/workspaces/"]
        .into_iter()
        .find_map(|prefix| path.strip_prefix(prefix))
        .and_then(|rest| rest.split('/').next())
        .filter(|id| !id.is_empty())
}

pub async fn require_session(
    State(state): State<Arc<AuthState>>,
    mut request: Request,
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

    let user = match state.sessions.user_for_token(&sha256_hex(&raw_token)).await {
        Ok(Some(user)) => user,
        Ok(None) => return error(
            StatusCode::UNAUTHORIZED,
            "not_authenticated",
            "Log in first.",
        ),
        Err(err) => return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_lookup_failed",
            err.to_string(),
        ),
    };
    if let Some(workspace_id) = workspace_id_from_path(request.uri().path()) {
        let owned = sqlx::query_scalar::<_, i64>("SELECT 1 FROM workspace_creations WHERE workspace_id = ? AND owner_google_sub = ?")
            .bind(workspace_id).bind(&user.google_sub).fetch_optional(&state.workspace_pool).await;
        match owned {
            Ok(Some(_)) => {}
            Ok(None) => return error(StatusCode::NOT_FOUND, "workspace_not_found", "Workspace not found."),
            Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, "workspace_lookup_failed", err.to_string()),
        }
    }
    request.extensions_mut().insert::<AuthenticatedUser>(user);
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_routes_are_exempt() {
        assert!(is_exempt("/auth/google"));
        assert!(is_exempt("/auth/google/callback"));
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
    fn a_workspace_browser_route_is_exempt() {
        assert!(is_exempt("/workspaces/abc-123/browser/agent-1/start"));
        assert!(is_exempt("/workspaces/abc-123/browser/agent-1/stop"));
        assert!(is_exempt("/workspaces/abc-123/browser/agent-1/status"));
    }

    #[test]
    fn a_path_that_merely_starts_like_browser_is_not_exempt() {
        // Guards against a naive `.contains("browser")`/`.ends_with("browser")`
        // check — must require the exact `/browser/` segment boundary, the
        // same way `a_path_that_merely_contains_mcp_is_not_exempt` guards
        // the mcp suffix check below.
        assert!(!is_exempt("/workspaces/abc-123/browserish"));
        assert!(!is_exempt("/workspaces/abc-123/browserish/agent-1/start"));
        assert!(!is_exempt("/workspaces/abc-123/browser"));
        assert!(!is_exempt("/browser-something-else"));
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
        assert!(!is_exempt("/api/workspaces/abc-123/integrations"));
    }

    #[test]
    fn ownership_scope_extracts_workspace_id_from_both_route_namespaces() {
        assert_eq!(
            workspace_id_from_path("/workspaces/abc-123/integrations"),
            Some("abc-123")
        );
        assert_eq!(
            workspace_id_from_path("/api/workspaces/abc-123/integrations"),
            Some("abc-123")
        );
        assert_eq!(workspace_id_from_path("/integrations/providers"), None);
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
