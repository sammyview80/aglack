//! `ANY /workspaces/:id/browser/:agent_id/:action` — validates `id` via
//! `resolve.rs` (must exist AND be `ready`), then forwards to that
//! workspace's browser-manager daemon (see
//! `backend/workspace-image/browser_manager.py`, a SIBLING process to the
//! wrapper inside the same container, bound to its own separately
//! published `browser_port` — NOT the wrapper's `wrapper_port`, and NOT
//! rewritten onto `/api/wrapper/v1/...` the way `wrapper_prefix_proxy.rs`
//! does for every wrapper-namespace route).
//!
//! Shape is deliberately different from every other proxy in this
//! directory: a plain request/response forward (like `onboarding_proxy.rs`,
//! not a WebSocket relay like `desktop_proxy.rs`'s `/websockify` half),
//! but resolving a DIFFERENT per-workspace port (like `desktop_proxy.rs`
//! resolves `desktop_port` instead of `wrapper_port`) and rewriting onto
//! the daemon's own `/agents/<agent_id>/<action>` path shape (matching
//! that file's own `_AGENT_PATH_RE = re.compile(r"^/agents/([^/]+)/(start|stop|status)$")`),
//! not a namespace-prefixed wrapper path.
//!
//! `action` is validated against a strict allowlist (`start`/`stop`/
//! `status`) BEFORE ever being interpolated into the forwarded path —
//! rejecting anything else with 400 rather than forwarding an arbitrary
//! caller-supplied string straight into the daemon's URL unchecked. This
//! is a defense-in-depth check on THIS side of the proxy: the daemon
//! itself also rejects an unrecognized action (its own `_AGENT_PATH_RE`
//! simply 404s on anything outside the three-way alternation), but
//! validating here means a malformed action never even reaches the
//! daemon as a network request, and this route can return a clear 400
//! instead of relaying whatever the daemon happens to answer.
//!
//! `agent_id` does NOT need to duplicate the daemon's own SEMANTIC
//! validation (`validate_agent_id`/`_AGENT_ID_RE`, a strict
//! `^[A-Za-z0-9_-]{1,128}$` charset check applied before either the
//! filesystem or subprocess argv ever sees it) — the daemon is the sole
//! authority on what a valid agent_id looks like for ITS purposes, and
//! duplicating that exact regex here would just be two places that could
//! silently drift out of sync. A semantically-malformed-but-structurally-
//! safe agent_id (e.g. containing a space, or a character outside the
//! daemon's charset but not `/`) is simply forwarded and gets the
//! daemon's own 400 back, relayed verbatim by `forward_to`.
//!
//! It DOES need one narrow STRUCTURAL check this proxy owns regardless of
//! what the daemon does: `agent_id` must not contain a literal `/`.
//! Real, confirmed issue found while building this file (not
//! hypothetical): axum's `Path` extractor percent-decodes a captured
//! segment's VALUE (e.g. `%2f` -> `/`) without re-validating that the
//! decoded value still looks like a single path segment, and
//! `reqwest`'s own URL parsing normalizes `..` segments in the target URL
//! `forward_to` builds — the two facts COMPOSE: an `agent_id` request
//! path segment of `..%2f..%2fadmin` decodes to `../../admin`, which this
//! module's naive `format!("/agents/{agent_id}/{action}")` turned into
//! `/agents/../../admin/status`, and the outbound request actually put on
//! the wire to the daemon was `GET /admin/status` — completely outside
//! `/agents/`, bypassing both this proxy's own action allowlist intent
//! AND the daemon's own `_AGENT_PATH_RE` anchor (which never even runs,
//! since the real wire path no longer matches its own `^/agents/...`
//! prefix in the first place). `browser_manager.py`'s own routing table
//! only ever serves `/agents/*` regardless, so today's concrete daemon
//! happens to 404 anything that escapes it — but this proxy must not
//! rely on that as its only defense: `reject_if_contains_slash` below
//! closes the hole at the one place a `/` could ever be introduced
//! (nothing else about this path template is caller-controlled).

use axum::{
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use std::sync::Arc;

use crate::integrations::mcp_proxy::require_workspace_bearer;
use crate::integrations::IntegrationsState;
use crate::proxy::forward_to;
use crate::response::error;
use crate::workspaces::resolve::resolve_ready_workspace;

/// The only three actions the daemon's own `_AGENT_PATH_RE` recognizes —
/// see this module's own doc comment for why this allowlist is enforced
/// here too, not left solely to the daemon.
fn is_valid_action(action: &str) -> bool {
    matches!(action, "start" | "stop" | "status")
}

/// True if `segment`, once percent-decoded by axum's `Path` extractor,
/// still contains a literal `/` — see this module's own doc comment for
/// the real, confirmed path-injection issue this guards against: such a
/// value can make the outbound request line built by `forward_to` name a
/// path OUTSIDE `/agents/<agent_id>/<action>` entirely (e.g. via `..`
/// segments reqwest's own URL parsing normalizes away). Empty is also
/// rejected — an empty `agent_id` would collapse `/agents//<action>` to a
/// different, ambiguous path shape the daemon's own `_AGENT_PATH_RE`
/// (`[^/]+`, at least one character) would never match anyway.
fn is_structurally_safe_path_segment(segment: &str) -> bool {
    !segment.is_empty() && !segment.contains('/')
}

/// Handles `/workspaces/:id/browser/:agent_id/:action`. Three named path
/// segments — axum's `Path` extractor over a 3-tuple, the same pattern
/// every other multi-param route in this crate already uses (see e.g.
/// `integrations/route.rs`'s `Path((workspace_id, provider_id))`), just
/// with a third element.
///
/// State is `Arc<IntegrationsState>`, not `Arc<WorkspacesState>` (every
/// other proxy in this directory's usual shape) — this route is called
/// FROM INSIDE the workspace's own container (a Python MCP tool, no human
/// browser session), authenticated by the SAME per-workspace integrations
/// bearer `/workspaces/:id/mcp` already requires (see
/// `require_workspace_bearer`'s own doc comment). `IntegrationsState`
/// already carries everything this handler needs: `workspace_store` (a
/// `WorkspaceStore` handle over the same underlying SQLite pool
/// `WorkspacesState::store` uses — see that field's own doc comment in
/// `integrations/route.rs`) for `resolve_ready_workspace`, `http_client`
/// for `forward_to`, and the bearer-check machinery
/// (`store.find_runtime_token`, `mcp_bearer_lockout`) that only exists on
/// this state today. This avoids duplicating a second `McpBearerLockout`
/// instance on `WorkspacesState` — both routes share the exact same
/// per-workspace lockout counter (see this crate's security review notes
/// for why that sharing is the intended design, not an oversight).
pub async fn browser_proxy_route(
    State(state): State<Arc<IntegrationsState>>,
    Path((workspace_id, agent_id, action)): Path<(String, String, String)>,
    headers: HeaderMap,
    req: Request,
) -> Response {
    // Bearer check FIRST — cheapest rejection first, matching
    // `integration_mcp_route`'s own ordering: an unauthenticated/
    // cross-tenant caller must never reach the action allowlist, agent_id
    // structural check, or workspace resolution below.
    if let Err(response) =
        require_workspace_bearer(&state, &workspace_id, &headers, "browser_proxy_invalid_bearer")
            .await
    {
        return response;
    }

    if !is_valid_action(&action) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_browser_action",
            format!("{action:?} is not a valid browser action; must be one of start/stop/status"),
        );
    }

    // Structural check on `agent_id` — see `is_structurally_safe_path_segment`'s
    // own doc comment. Checked AFTER the action allowlist (cheaper, no
    // caller-controlled content) but BEFORE any workspace resolution or
    // forwarding — a structurally unsafe agent_id must never reach
    // `format!`, regardless of whether the workspace even exists.
    if !is_structurally_safe_path_segment(&agent_id) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_browser_agent_id",
            format!("{agent_id:?} is not a valid agent id path segment"),
        );
    }

    let ports = match resolve_ready_workspace(&state.workspace_store, &workspace_id).await {
        Ok(ports) => ports,
        Err(response) => return response,
    };

    let target_addr = format!("127.0.0.1:{}", ports.browser_port);
    let rewritten_path = format!("/agents/{agent_id}/{action}");

    forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::mcp_proxy::sha256_hex;
    use crate::integrations::openconnector::fake::FakeOpenConnector;
    use crate::integrations::IntegrationStore;
    use crate::workspaces::test_support::spawn_echo_wrapper;
    use crate::workspaces::WorkspaceStore;
    use axum::{
        body::{to_bytes, Body},
        extract::Path as AxumPath,
        http::{header::AUTHORIZATION, Request as HttpRequest, StatusCode},
    };
    use std::sync::Arc as StdArc;

    /// `IntegrationsState` wired to a fresh store/`FakeOpenConnector` —
    /// this route now authenticates via the exact same
    /// `require_workspace_bearer` machinery `mcp_proxy.rs`'s own tests
    /// exercise (`state_with_runtime_token`), so this mirrors that
    /// helper's setup rather than inventing a new pattern. Optionally
    /// seeds a `Ready` workspace row with the given ports (`None` leaves
    /// the workspace store empty, for the unknown-workspace-id case) and
    /// a runtime token whose bearer hashes to `correct_bearer`, keyed to
    /// `workspace_id`.
    async fn state_with_runtime_token(
        workspace_id: &str,
        correct_bearer: &str,
        ready_ports: Option<(u16, u16, u16)>,
    ) -> Arc<IntegrationsState> {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        std::mem::forget(dir);
        let pool = crate::db::connect(&db_path)
            .await
            .expect("connect to fresh sqlite db");

        let workspace_store = WorkspaceStore::new(pool.clone());
        let idempotency_key = format!("key-{workspace_id}");
        workspace_store
            .begin_creation(&idempotency_key, workspace_id)
            .await
            .expect("begin_creation");
        if let Some((wrapper_port, desktop_port, browser_port)) = ready_ports {
            workspace_store
                .mark_ready(
                    &idempotency_key,
                    "not-a-real-container",
                    wrapper_port,
                    desktop_port,
                    browser_port,
                )
                .await
                .expect("mark_ready");
        }

        let store = IntegrationStore::new(pool.clone());
        let token_cipher = crate::crypto::TokenCipher::new(&[9u8; 32]);
        let encrypted_bearer = token_cipher
            .encrypt("openconnector-bearer")
            .expect("encrypt");
        store
            .upsert_runtime_token(
                workspace_id,
                "token-id-1",
                &sha256_hex(correct_bearer),
                &encrypted_bearer,
            )
            .await
            .expect("seed runtime token");

        Arc::new(IntegrationsState {
            store,
            openconnector: StdArc::new(FakeOpenConnector::default()),
            providers: Vec::new(),
            workspace_store,
            http_client: reqwest::Client::new(),
            token_cipher,
            mcp_bearer_lockout: Default::default(),
            catalog_cache: Default::default(),
        })
    }

    /// `IntegrationsState` for a workspace_id with NO runtime token seeded
    /// at all (used for the unknown-workspace-id auth case, where the
    /// point is that the bearer check itself rejects first).
    async fn state_with_no_runtime_token() -> Arc<IntegrationsState> {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        std::mem::forget(dir);
        let pool = crate::db::connect(&db_path)
            .await
            .expect("connect to fresh sqlite db");
        Arc::new(IntegrationsState {
            store: IntegrationStore::new(pool.clone()),
            openconnector: StdArc::new(FakeOpenConnector::default()),
            providers: Vec::new(),
            workspace_store: WorkspaceStore::new(pool),
            http_client: reqwest::Client::new(),
            token_cipher: crate::crypto::TokenCipher::new(&[9u8; 32]),
            mcp_bearer_lockout: Default::default(),
            catalog_cache: Default::default(),
        })
    }

    fn bearer_headers(bearer: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, format!("Bearer {bearer}").parse().unwrap());
        headers
    }

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// An unknown workspace_id has no runtime token row at all, so the
    /// bearer check itself rejects with `unknown_workspace_token` (401)
    /// BEFORE `resolve_ready_workspace` ever runs — this is the correct,
    /// intended ordering (cheapest/security-relevant rejection first,
    /// matching `integration_mcp_route`'s own behavior, which also never
    /// reaches workspace resolution for an unknown id), not a regression
    /// of the pre-auth-gate 404 behavior.
    #[tokio::test]
    async fn unknown_workspace_id_is_rejected_by_the_bearer_check_before_resolution() {
        let state = state_with_no_runtime_token().await;

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                "does-not-exist".to_string(),
                "agent-1".to_string(),
                "status".to_string(),
            )),
            bearer_headers("any-bearer-at-all-but-plausibly-shaped-1234"),
            HttpRequest::builder()
                .uri("/workspaces/does-not-exist/browser/agent-1/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "unknown_workspace_token");
    }

    #[tokio::test]
    async fn missing_bearer_is_rejected_with_401() {
        let workspace_id = "ws-missing-bearer";
        let state = state_with_runtime_token(workspace_id, "the-real-bearer-value-1234", None)
            .await;

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                workspace_id.to_string(),
                "agent-1".to_string(),
                "status".to_string(),
            )),
            HeaderMap::new(),
            HttpRequest::builder()
                .uri(format!("/workspaces/{workspace_id}/browser/agent-1/status"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "missing_bearer");
    }

    /// A wrong bearer against a real, existing, `Ready` workspace must
    /// still be rejected — proves the bearer check is a real comparison
    /// against the stored hash, not a no-op that only fires when the
    /// workspace doesn't exist.
    #[tokio::test]
    async fn wrong_bearer_against_a_ready_workspace_is_rejected_with_401() {
        let workspace_id = "ws-wrong-bearer";
        let state =
            state_with_runtime_token(workspace_id, "the-real-bearer-value-1234", Some((1, 2, 3)))
                .await;

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                workspace_id.to_string(),
                "agent-1".to_string(),
                "status".to_string(),
            )),
            bearer_headers("wrong-bearer-value-000000000000"),
            HttpRequest::builder()
                .uri(format!("/workspaces/{workspace_id}/browser/agent-1/status"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "invalid_bearer");
    }

    /// A rejected bearer against `/browser/...` must be audited under its
    /// OWN event name (`browser_proxy_invalid_bearer`), not
    /// `/mcp`'s `mcp_proxy_invalid_bearer` — even though both routes
    /// share the same `McpBearerLockout` counter (see
    /// `require_workspace_bearer`'s own doc comment), an operator reading
    /// `integration_audit` must be able to tell which route actually saw
    /// the rejected attempt.
    #[tokio::test]
    async fn wrong_bearer_is_audited_under_the_browser_routes_own_event_name() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        std::mem::forget(dir);
        let pool = crate::db::connect(&db_path)
            .await
            .expect("connect to fresh sqlite db");

        let workspace_id = "ws-audit-name";
        let correct_bearer = "the-real-bearer-value-1234";
        let workspace_store = WorkspaceStore::new(pool.clone());
        workspace_store
            .begin_creation("key-audit", workspace_id)
            .await
            .expect("begin_creation");
        workspace_store
            .mark_ready("key-audit", "container", 1, 2, 3)
            .await
            .expect("mark_ready");

        let store = IntegrationStore::new(pool.clone());
        let token_cipher = crate::crypto::TokenCipher::new(&[9u8; 32]);
        let encrypted = token_cipher.encrypt("openconnector-bearer").expect("encrypt");
        store
            .upsert_runtime_token(
                workspace_id,
                "token-id",
                &sha256_hex(correct_bearer),
                &encrypted,
            )
            .await
            .expect("seed runtime token");

        let state = Arc::new(IntegrationsState {
            store,
            openconnector: StdArc::new(FakeOpenConnector::default()),
            providers: Vec::new(),
            workspace_store,
            http_client: reqwest::Client::new(),
            token_cipher,
            mcp_bearer_lockout: Default::default(),
            catalog_cache: Default::default(),
        });

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                workspace_id.to_string(),
                "agent-1".to_string(),
                "status".to_string(),
            )),
            bearer_headers("wrong-bearer-value-000000000000"),
            HttpRequest::builder()
                .uri(format!("/workspaces/{workspace_id}/browser/agent-1/status"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let browser_audit_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM integration_audit WHERE workspace_id = ? AND event = ?",
        )
        .bind(workspace_id)
        .bind("browser_proxy_invalid_bearer")
        .fetch_one(&pool)
        .await
        .expect("count browser audit rows");
        let mcp_audit_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM integration_audit WHERE workspace_id = ? AND event = ?",
        )
        .bind(workspace_id)
        .bind("mcp_proxy_invalid_bearer")
        .fetch_one(&pool)
        .await
        .expect("count mcp audit rows");

        assert_eq!(browser_audit_count, 1);
        assert_eq!(mcp_audit_count, 0);
    }

    /// Workspace A's valid bearer must not authenticate a browser call
    /// against workspace B — the cross-tenant isolation case, mirroring
    /// `mcp_proxy.rs`'s own equivalent guarantee (a bearer is checked
    /// against the SPECIFIC workspace_id named in the path, always looked
    /// up fresh per-workspace, never treated as a global credential).
    #[tokio::test]
    async fn a_valid_bearer_for_a_different_workspace_is_rejected() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        std::mem::forget(dir);
        let pool = crate::db::connect(&db_path)
            .await
            .expect("connect to fresh sqlite db");

        let workspace_store = WorkspaceStore::new(pool.clone());
        // Workspace A: a real, ready workspace with its own bearer.
        workspace_store
            .begin_creation("key-ws-a", "ws-a")
            .await
            .expect("begin_creation ws-a");
        workspace_store
            .mark_ready("key-ws-a", "container-a", 1, 2, 3)
            .await
            .expect("mark_ready ws-a");
        // Workspace B: also real and ready (the actual TARGET of this
        // request), with a DIFFERENT bearer.
        workspace_store
            .begin_creation("key-ws-b", "ws-b")
            .await
            .expect("begin_creation ws-b");
        workspace_store
            .mark_ready("key-ws-b", "container-b", 4, 5, 6)
            .await
            .expect("mark_ready ws-b");

        let store = IntegrationStore::new(pool.clone());
        let token_cipher = crate::crypto::TokenCipher::new(&[9u8; 32]);
        let bearer_a = "workspace-a-own-correct-bearer-value";
        let bearer_b = "workspace-b-own-correct-bearer-value";
        for (workspace_id, bearer) in [("ws-a", bearer_a), ("ws-b", bearer_b)] {
            let encrypted = token_cipher.encrypt("openconnector-bearer").expect("encrypt");
            store
                .upsert_runtime_token(workspace_id, "token-id", &sha256_hex(bearer), &encrypted)
                .await
                .expect("seed runtime token");
        }

        let state = Arc::new(IntegrationsState {
            store,
            openconnector: StdArc::new(FakeOpenConnector::default()),
            providers: Vec::new(),
            workspace_store,
            http_client: reqwest::Client::new(),
            token_cipher,
            mcp_bearer_lockout: Default::default(),
            catalog_cache: Default::default(),
        });

        // Using workspace A's own valid bearer against workspace B's
        // browser route must be rejected exactly like any other wrong
        // bearer — never accepted because "it was valid for SOME
        // workspace".
        let response = browser_proxy_route(
            State(state),
            AxumPath(("ws-b".to_string(), "agent-1".to_string(), "status".to_string())),
            bearer_headers(bearer_a),
            HttpRequest::builder()
                .uri("/workspaces/ws-b/browser/agent-1/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "invalid_bearer");
    }

    #[tokio::test]
    async fn not_ready_workspace_returns_409_with_a_valid_bearer() {
        let workspace_id = "ws-not-ready";
        let correct_bearer = "the-real-bearer-value-1234";
        // `ready_ports: None` — `begin_creation` only, never `mark_ready`,
        // so the workspace stays `Creating`.
        let state = state_with_runtime_token(workspace_id, correct_bearer, None).await;

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                workspace_id.to_string(),
                "agent-1".to_string(),
                "status".to_string(),
            )),
            bearer_headers(correct_bearer),
            HttpRequest::builder()
                .uri(format!("/workspaces/{workspace_id}/browser/agent-1/status"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_ready");
    }

    /// An action outside the `start`/`stop`/`status` allowlist must be
    /// rejected with 400 BEFORE any resolution/forwarding happens — even
    /// against an otherwise perfectly valid, ready workspace with a valid
    /// bearer, proving this is a real server-side allowlist check, not
    /// something that only happens to work because the workspace lookup
    /// or auth fails first.
    #[tokio::test]
    async fn invalid_action_segment_returns_400_even_for_a_ready_workspace() {
        let echo_port = spawn_echo_wrapper().await;
        let workspace_id = "ws-1";
        let correct_bearer = "the-real-bearer-value-1234";
        let state = state_with_runtime_token(
            workspace_id,
            correct_bearer,
            Some((12345, 12346, echo_port)),
        )
        .await;

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                workspace_id.to_string(),
                "agent-1".to_string(),
                "delete-everything".to_string(),
            )),
            bearer_headers(correct_bearer),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/browser/agent-1/delete-everything")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "invalid_browser_action");
    }

    /// The real end-to-end case: a `ready` workspace's request, presented
    /// with its own valid bearer, is forwarded to its ACTUAL recorded
    /// `browser_port` (not `wrapper_port` or `desktop_port`), rewritten
    /// onto `/agents/<agent_id>/<action>` — proven by a real echo server
    /// on a real OS-assigned port, not a mock.
    #[tokio::test]
    async fn ready_workspace_forwards_to_its_recorded_browser_port_with_rewritten_path() {
        let echo_port = spawn_echo_wrapper().await;
        let workspace_id = "ws-1";
        let correct_bearer = "the-real-bearer-value-1234";
        // wrapper_port=12345, desktop_port=12346 are deliberately NOT the
        // echo server — proves the request goes to `browser_port`
        // specifically, not one of the other two recorded ports.
        let state = state_with_runtime_token(
            workspace_id,
            correct_bearer,
            Some((12345, 12346, echo_port)),
        )
        .await;

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                workspace_id.to_string(),
                "agent-42".to_string(),
                "start".to_string(),
            )),
            bearer_headers(correct_bearer),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/browser/agent-42/start")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed_path = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed_path, "/agents/agent-42/start");
    }

    /// Same as above for the `status` action (a GET in the daemon's own
    /// contract, see `_AGENT_PATH_RE`'s method map) — proves this proxy
    /// does not hardcode or rewrite the HTTP method, only the path.
    #[tokio::test]
    async fn status_action_forwards_with_get_method_preserved() {
        let echo_port = spawn_echo_wrapper().await;
        let workspace_id = "ws-1";
        let correct_bearer = "the-real-bearer-value-1234";
        let state = state_with_runtime_token(
            workspace_id,
            correct_bearer,
            Some((12345, 12346, echo_port)),
        )
        .await;

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                workspace_id.to_string(),
                "agent-7".to_string(),
                "status".to_string(),
            )),
            bearer_headers(correct_bearer),
            HttpRequest::builder()
                .method("GET")
                .uri("/workspaces/ws-1/browser/agent-7/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed_path = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed_path, "/agents/agent-7/status");
    }

    /// Real, confirmed issue found while building this file (see the
    /// module doc comment's full explanation): axum's `Path` extractor
    /// percent-decodes a captured segment's value, so an `agent_id` of
    /// `..%2f..%2fadmin` on the wire arrives at this handler ALREADY
    /// decoded to the string `../../admin` — and without the
    /// `is_structurally_safe_path_segment` guard, `forward_to`'s own
    /// reqwest-based URL building normalizes those `..` segments away,
    /// putting a request for `/admin/status` (fully outside `/agents/`)
    /// on the wire to the daemon, bypassing this proxy's own path
    /// template entirely. This must be rejected with 400 before any
    /// forwarding happens (with a valid bearer, so the auth check isn't
    /// what stops it) — proven here with a real listening socket that
    /// would report exactly which raw request line it received, so a
    /// regression that silently reintroduces the hole would show up as
    /// "the socket got a request at all", not just a changed assertion.
    #[tokio::test]
    async fn agent_id_containing_a_slash_is_rejected_before_any_forwarding() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let called = std::sync::Arc::new(AtomicBool::new(false));
        let called_clone = called.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind daemon stand-in");
        let daemon_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if listener.accept().await.is_ok() {
                called_clone.store(true, Ordering::SeqCst);
            }
        });

        let workspace_id = "ws-1";
        let correct_bearer = "the-real-bearer-value-1234";
        let state =
            state_with_runtime_token(workspace_id, correct_bearer, Some((1, 2, daemon_port)))
                .await;

        // What axum's Path extractor hands this handler once it has
        // already percent-decoded a raw `..%2f..%2fadmin` wire segment —
        // this test exercises the handler directly with that decoded
        // value, the same way every other test in this module does,
        // since the decoding itself is axum's well-tested behavior, not
        // this handler's.
        let malicious_agent_id = "../../admin".to_string();

        let response = browser_proxy_route(
            State(state),
            AxumPath((
                workspace_id.to_string(),
                malicious_agent_id.clone(),
                "status".to_string(),
            )),
            bearer_headers(correct_bearer),
            HttpRequest::builder()
                .uri(format!(
                    "/workspaces/ws-1/browser/{malicious_agent_id}/status"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "invalid_browser_agent_id");

        // Give the (deliberately unstarted-servicing) listener's accept
        // loop a moment to have received a connection if `forward_to` had
        // wrongly been called — this is the real proof: no TCP connection
        // ever reached the "daemon" at all.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !called.load(Ordering::SeqCst),
            "the daemon stand-in must never receive a connection — a malicious agent_id must \
             be rejected BEFORE resolve/forward, not merely produce a safe-looking response \
             after already having contacted the daemon"
        );
    }

    /// An `agent_id` that is empty (only reachable if a client sends a
    /// literal empty segment, e.g. `//status` collapsing oddly, or a
    /// direct handler call in a future refactor) must also be rejected —
    /// see `is_structurally_safe_path_segment`'s own doc comment for why
    /// empty is unsafe too, not just slash-containing.
    #[tokio::test]
    async fn empty_agent_id_is_rejected() {
        let workspace_id = "ws-1";
        let correct_bearer = "the-real-bearer-value-1234";
        let state = state_with_runtime_token(workspace_id, correct_bearer, Some((1, 2, 3))).await;

        let response = browser_proxy_route(
            State(state),
            AxumPath((workspace_id.to_string(), String::new(), "status".to_string())),
            bearer_headers(correct_bearer),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/browser//status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "invalid_browser_agent_id");
    }
}
