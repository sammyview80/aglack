//! The MCP tenancy proxy — the single most security-critical piece of
//! this module. A workspace container reaches only
//! `POST /workspaces/:id/mcp` (this handler), authenticated by its own
//! bearer, never OpenConnector directly.
//!
//! Every rule here traces to a specific finding in
//! `docs/integrations-poc-findings.md`:
//!
//! - JSON-RPC **batches are accepted by OpenConnector itself** — reject
//!   them here, OpenConnector will not.
//! - A caller can name a connection FIVE different ways (`connectionName`
//!   body field, `alias` body field, `x-oo-connector-alias` header, and
//!   both as query params) — every one of them must be stripped and
//!   overwritten with this workspace's own connection name, not just the
//!   one field the original plan draft named.
//! - Only two tools may ever be reachable through this proxy:
//!   `execute_action` and `list_connections` (`get_action_guide` and
//!   `search_actions`/`list_apps` leak no secrets but are also not needed
//!   yet — smallest allowlist that unblocks the real use case, not the
//!   full OpenConnector surface).
//! - MCP errors come back as HTTP 200 with `ok:false` INSIDE the JSON
//!   body, not an HTTP error status — callers of this proxy (and its
//!   tests) must check the body, not just the status code.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

use super::route::audit;
use super::IntegrationsState;
use crate::response::error;

/// JSON-RPC methods this proxy will ever forward. Anything else — a
/// spec-valid method OpenConnector might add later, or an attempt to call
/// something like `resources/list` this deployment doesn't intend to
/// expose — is rejected rather than allowed through the default of an
/// unfamiliar method quietly finding some other capability.
const ALLOWED_METHODS: &[&str] = &[
    "initialize",
    "tools/list",
    "tools/call",
    "ping",
    "notifications/initialized",
];

/// Tools reachable via `tools/call` through this proxy. Originally just
/// `execute_action`/`list_connections` ("the two not needed yet" were
/// dropped) — but an agent calling `execute_action` blind has no way to
/// learn valid `actionId`s or their input shape without also being able to
/// browse the catalog, so `search_actions`, `get_action_guide`, and
/// `list_apps` (all read-only, no side effects, no connection-naming
/// fields to sanitize) are allowed too. `execute_action` remains the only
/// tool that can mutate anything or needs the allowlist/connectionName
/// enforcement below.
///
/// `find_action` was added after live agent transcripts this session
/// showed the real failure `search_actions`/`get_action_guide` alone don't
/// prevent: agents skip both and call `execute_action` with a GUESSED
/// action id (`search_repositories` instead of the real
/// `github.search_repositories`, or `github.list_repositories`, which
/// doesn't exist at all) — burning turns on `unknown_action`, sometimes
/// giving up and using an unrelated method instead of the connected
/// provider. `find_action` (in `mcp_server.py`) merges `search_actions` and
/// `get_action_guide` into one call so there's no separate "guess an id,
/// get an error" step to skip. It is read-only (no connection-naming
/// fields, nothing to sanitize) exactly like the other catalog-browsing
/// tools above, so it belongs in this same allowlist group.
const ALLOWED_TOOLS: &[&str] = &[
    "execute_action",
    "list_connections",
    "search_actions",
    "get_action_guide",
    "list_apps",
    "find_action",
];

/// Re-exported from `crate::crypto` so every EXISTING call site inside
/// this module tree (`super::mcp_proxy::sha256_hex`, used throughout
/// `integrations::route`) keeps working unchanged — the actual
/// implementation now lives in one shared place (`crate::crypto`) rather
/// than being duplicated per module that needs it (see that module's own
/// doc comment for why `auth::route` needed the same primitive).
pub use crate::crypto::sha256_hex;

/// `/workspaces/:id/mcp` is session-exempt (`auth/middleware.rs`) — a
/// workspace container's own bearer is the only gate, and anything that
/// can reach this gateway's port can send unlimited guesses at it. This
/// mirrors `auth::route`'s own login lockout (`LoginAttempts` /
/// `MAX_FAILURES_PER_WINDOW` / `LOCKOUT_WINDOW`) — same threshold (10
/// failures) and window (5 minutes) for consistency — but keyed per
/// workspace id via `DashMap` rather than one global `Mutex`, since a
/// bad guess against one workspace must not lock out every other one.
const MAX_BEARER_FAILURES_PER_WINDOW: u32 = 10;
const BEARER_LOCKOUT_WINDOW: Duration = Duration::from_secs(5 * 60);

/// How often a repeated `mcp_proxy_invalid_bearer` audit row is written
/// for the SAME workspace while it keeps failing — without this, the
/// exact flood this lockout throttles at the HTTP layer would still
/// unboundedly grow `integration_audit` one row per rejected guess.
const INVALID_BEARER_AUDIT_INTERVAL: Duration = Duration::from_secs(60);

struct WorkspaceBearerFailures {
    count: u32,
    window_start: Instant,
    last_audited: Option<Instant>,
}

impl Default for WorkspaceBearerFailures {
    fn default() -> Self {
        Self {
            count: 0,
            window_start: Instant::now(),
            last_audited: None,
        }
    }
}

/// Per-workspace failure tracker for the MCP bearer check — see the
/// module-level doc comment above for why this exists and what it
/// mirrors. Lives on `IntegrationsState` (constructed once at process
/// start, `Default` for tests) so every request task shares the same map.
#[derive(Default)]
pub struct McpBearerLockout {
    workspaces: DashMap<String, WorkspaceBearerFailures>,
}

/// Outcome of a lockout check: whether to short-circuit with 429, and
/// (only when NOT locked out) whether this particular call should also
/// write an audit row once it goes on to fail — computed up front so the
/// lock is only held for one quick, synchronous critical section, never
/// across an `.await`.
enum LockoutDecision {
    Locked,
    Allowed { should_audit_on_failure: bool },
}

impl McpBearerLockout {
    /// Checked BEFORE `find_runtime_token`/`sha256_hex` — a workspace
    /// already in lockout must cost this process nothing beyond a map
    /// lookup, never a DB read or a hash.
    fn check(&self, workspace_id: &str) -> LockoutDecision {
        let mut entry = self.workspaces.entry(workspace_id.to_string()).or_default();
        if entry.window_start.elapsed() > BEARER_LOCKOUT_WINDOW {
            *entry = WorkspaceBearerFailures::default();
        }
        if entry.count >= MAX_BEARER_FAILURES_PER_WINDOW {
            return LockoutDecision::Locked;
        }
        // Audit at most once per `INVALID_BEARER_AUDIT_INTERVAL` for this
        // workspace, decided now (not after the failure) so the decision
        // and the state update happen in the same critical section.
        let should_audit_on_failure = match entry.last_audited {
            None => true,
            Some(last) => last.elapsed() >= INVALID_BEARER_AUDIT_INTERVAL,
        };
        LockoutDecision::Allowed { should_audit_on_failure }
    }

    /// Record one failed bearer check. Bumps the failure count, and marks
    /// "just audited" when `did_audit` (the caller actually wrote the
    /// audit row `check`'s `should_audit_on_failure` told it to).
    fn record_failure(&self, workspace_id: &str, did_audit: bool) {
        let mut entry = self.workspaces.entry(workspace_id.to_string()).or_default();
        entry.count += 1;
        if did_audit {
            entry.last_audited = Some(Instant::now());
        }
    }

    /// A legitimate request after some failures must not stay throttled —
    /// mirrors `auth::route::record_login_success` resetting
    /// `LoginAttempts` back to `Default`.
    fn record_success(&self, workspace_id: &str) {
        self.workspaces
            .insert(workspace_id.to_string(), WorkspaceBearerFailures::default());
    }
}

/// Cheap shape check, rejected BEFORE `sha256_hex`/any DB read — see
/// `IntegrationsState::mcp_bearer_lockout`'s own doc comment for why this
/// runs first. OpenConnector's own runtime-token bearer format is not
/// documented anywhere in this crate (`RuntimeToken.bearer` is just an
/// opaque `String` OpenConnector hands back — see `openconnector.rs`), so
/// this is a conservative sanity bound, not the real format: reject
/// anything too short to plausibly be a real high-entropy bearer (under
/// 20 chars) or implausibly long for one (over 512 chars — generous
/// headroom past any realistic token/JWT length), rather than inventing a
/// precise number the real format doesn't document.
const MIN_BEARER_LEN: usize = 20;
const MAX_BEARER_LEN: usize = 512;

fn bearer_is_plausibly_shaped(bearer: &str) -> bool {
    (MIN_BEARER_LEN..=MAX_BEARER_LEN).contains(&bearer.len())
}

/// Constant-time comparison of two sha256 hex digests — decodes both to
/// raw bytes first (comparing the hex STRINGS directly would still leak
/// timing tied to the first differing hex character, finer-grained than
/// but still related to the underlying byte differences) then uses
/// `subtle::ConstantTimeEq` on the byte slices. A hex-decode failure on
/// either side (should not happen — `stored_hash` is always this
/// gateway's own `sha256_hex` output, and `computed_hash` always is too)
/// fails the check rather than panicking.
fn hashes_match_constant_time(computed_hash: &str, stored_hash: &str) -> bool {
    let (Some(computed), Some(stored)) =
        (decode_sha256_hex(computed_hash), decode_sha256_hex(stored_hash))
    else {
        return false;
    };
    computed.ct_eq(&stored).into()
}

/// Decodes a lowercase sha256 hex digest (`crypto::sha256_hex`'s exact
/// output shape: 64 hex chars) into its 32 raw bytes. `None` on anything
/// malformed rather than panicking — a hex-decode failure must fail the
/// auth check, not crash the process.
fn decode_sha256_hex(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.as_bytes();
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        let hi = (hex[i * 2] as char).to_digit(16)?;
        let lo = (hex[i * 2 + 1] as char).to_digit(16)?;
        *byte = ((hi << 4) | lo) as u8;
    }
    Some(out)
}

/// `POST /workspaces/:id/mcp`
pub async fn integration_mcp_route(
    State(state): State<Arc<IntegrationsState>>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let bearer = match extract_bearer(&headers) {
        Some(bearer) => bearer,
        None => {
            return error(
                StatusCode::UNAUTHORIZED,
                "missing_bearer",
                "Authorization: Bearer <token> is required.",
            )
        }
    };

    // Cheapest possible rejection first: an implausibly-shaped bearer
    // never even reaches the DB read or a hash — see
    // `bearer_is_plausibly_shaped`'s own doc comment.
    if !bearer_is_plausibly_shaped(&bearer) {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_bearer",
            "Bearer token does not match this workspace's current token.",
        );
    }

    // Per-workspace lockout, checked BEFORE the DB read/hash — a
    // workspace already flooding this route with wrong guesses must cost
    // this process nothing beyond a map lookup. See `McpBearerLockout`'s
    // own doc comment for the threshold/window (mirrors `auth::route`'s
    // login lockout).
    let should_audit_on_failure = match state.mcp_bearer_lockout.check(&workspace_id) {
        LockoutDecision::Locked => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_attempts",
                "Too many failed bearer attempts for this workspace. Try again later.",
            )
        }
        LockoutDecision::Allowed { should_audit_on_failure } => should_audit_on_failure,
    };

    let token_record = match state.store.find_runtime_token(&workspace_id).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            state
                .mcp_bearer_lockout
                .record_failure(&workspace_id, false);
            return error(
                StatusCode::UNAUTHORIZED,
                "unknown_workspace_token",
                "This workspace has no active integrations token.",
            )
        }
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "token_lookup_failed",
                err.to_string(),
            )
        }
    };

    if !hashes_match_constant_time(&sha256_hex(&bearer), &token_record.token_hash) {
        // The security-relevant audit event in this whole route: a bearer
        // that doesn't match ITS OWN workspace's stored hash is exactly
        // what a cross-tenant attempt (or a stale bearer post-rotation)
        // looks like. Never logs the bearer itself, only that this
        // workspace saw a rejected attempt. Rate-limited to roughly once
        // per minute per workspace (`should_audit_on_failure`, decided by
        // the lockout above) so a flood of guesses cannot also flood
        // `integration_audit` — the exact attack this lockout mitigates.
        if should_audit_on_failure {
            audit(&state, Some(&workspace_id), None, "mcp_proxy_invalid_bearer", false, None)
                .await;
        }
        state
            .mcp_bearer_lockout
            .record_failure(&workspace_id, should_audit_on_failure);
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_bearer",
            "Bearer token does not match this workspace's current token.",
        );
    }
    state.mcp_bearer_lockout.record_success(&workspace_id);

    let request: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "Body must be valid JSON.",
            )
        }
    };

    // Reject batches outright — see module doc. A JSON-RPC batch is a top-
    // level array; a single request is a top-level object.
    if request.is_array() {
        return error(
            StatusCode::BAD_REQUEST,
            "batch_not_allowed",
            "JSON-RPC batch requests are not allowed through this proxy.",
        );
    }

    let sanitized = match sanitize_request(&workspace_id, &state.providers, request) {
        Ok(value) => value,
        Err(response) => return response,
    };

    // The bearer forwarded to OpenConnector is ALWAYS the workspace's own
    // stored OpenConnector runtime token (`token_record.openconnector_bearer`,
    // AES-256-GCM-encrypted at rest — see `crypto::TokenCipher`) — never
    // the caller-supplied bearer, which only authenticates the container
    // to THIS gateway, not to OpenConnector. Looked up fresh (not cached)
    // so a mid-flight rotation takes effect immediately.
    let decrypted_bearer = match state.token_cipher.decrypt(&token_record.openconnector_bearer) {
        Ok(bearer) => bearer,
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "token_decryption_failed",
                err.to_string(),
            )
        }
    };

    match state.openconnector.forward_mcp(&decrypted_bearer, &sanitized).await {
        Ok(value) => (StatusCode::OK, axum::Json(value)).into_response(),
        Err(err) => {
            // Issue 2: `err.message` may embed OpenConnector's raw
            // response body verbatim (see `response_to_error`) — this
            // proxy is reached directly by a WORKSPACE CONTAINER, so
            // returning it unfiltered here is the single worst leak
            // point in this module (worse than the browser-facing routes
            // in `route.rs`: a compromised/misbehaving container is
            // exactly this proxy's own threat model — see the module doc
            // comment). Log the real detail server-side; return only the
            // fixed, non-leaking message.
            tracing::warn!(workspace_id = %workspace_id, error = %err, "openconnector forward_mcp failed");
            error(StatusCode::BAD_GATEWAY, err.safe_code(), err.safe_message())
        }
    }
}

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    raw.strip_prefix("Bearer ")
        .map(|token| token.trim().to_string())
}

/// Strip every caller-controlled way of naming a connection and force
/// this workspace's own connection name, allowlist the method and (for
/// `tools/call`) the tool name. Returns the sanitized JSON-RPC request
/// ready to forward, or an error `Response` to return directly.
fn sanitize_request(
    workspace_id: &str,
    providers: &[super::Provider],
    mut request: Value,
) -> Result<Value, Response> {
    let Some(object) = request.as_object_mut() else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "JSON-RPC request must be a single object.",
        ));
    };

    let method = object
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(method) = method else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "missing_method",
            "JSON-RPC request must have a \"method\".",
        ));
    };

    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "method_not_allowed",
            format!("Method {method:?} is not permitted through this proxy."),
        ));
    }

    if method == "tools/call" {
        let params = object
            .get_mut("params")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                error(
                    StatusCode::BAD_REQUEST,
                    "missing_params",
                    "tools/call requires \"params\".",
                )
            })?;

        let tool_name = params
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                error(
                    StatusCode::BAD_REQUEST,
                    "missing_tool_name",
                    "tools/call requires \"params.name\".",
                )
            })?;

        if !ALLOWED_TOOLS.contains(&tool_name.as_str()) {
            return Err(error(
                StatusCode::FORBIDDEN,
                "tool_not_allowed",
                format!("Tool {tool_name:?} is not permitted through this proxy."),
            ));
        }

        let arguments = params.entry("arguments").or_insert_with(|| json!({}));
        let Some(arguments) = arguments.as_object_mut() else {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "invalid_arguments",
                "tools/call \"params.arguments\" must be an object.",
            ));
        };

        // Per-provider action allowlist (see `Provider::allowed_actions`'s
        // own doc comment) — only meaningful for `execute_action`, the
        // one tool that actually names a provider action. `actionId`'s
        // prefix (before the first `.`) is the OpenConnector service key,
        // e.g. `github` in `github.get_current_user` — matched against
        // each provider's `openconnector_service`, not its own gateway
        // `id` (those two are usually equal but not guaranteed to be,
        // see providers.yaml's Google split-service rows).
        if tool_name == "execute_action" {
            if let Some(action_id) = arguments.get("actionId").and_then(Value::as_str) {
                let service = action_id.split('.').next().unwrap_or(action_id);
                let provider = providers.iter().find(|p| p.openconnector_service == service);
                if let Some(provider) = provider {
                    if !provider.allows_action(action_id) {
                        return Err(error(
                            StatusCode::FORBIDDEN,
                            "action_not_allowed",
                            format!(
                                "{action_id:?} is not in {}'s allowed action list.",
                                provider.name
                            ),
                        ));
                    }
                }
                // No matching provider in the registry: NOT rejected
                // here — OpenConnector itself will reject an unknown or
                // unconnected service via `connection_not_allowed`/
                // `action_not_found` when the call actually reaches it.
                // This proxy only enforces allowlists for providers it
                // actually knows about; it is not the source of truth for
                // "does this service exist at all."
            }
        }

        // The actual isolation enforcement: remove every caller-supplied
        // way of naming a connection, then set the one true value. This
        // MUST happen after the tool-name allowlist check above, and
        // MUST cover every alias the POC found OpenConnector accepts.
        arguments.remove("connectionName");
        arguments.remove("alias");
        arguments.insert(
            "connectionName".to_string(),
            Value::String(workspace_connection_name(workspace_id)),
        );
    }

    Ok(request)
}

/// The one true connection-name convention: gateway-generated, never
/// user-supplied. Matches `docs/integrations-plan.md`'s
/// `ws-<workspaceId>-<provider>` naming — but this proxy forces a SINGLE
/// name per workspace across all providers OpenConnector might route to,
/// since OpenConnector's `execute_action` picks the connection by name
/// for whatever provider `actionId` implies. Real per-provider connection
/// naming (one name per provider, chosen by `actionId`'s prefix) is
/// necessary before a workspace can hold more than one provider at once —
/// tracked as follow-up, not built in this slice.
fn workspace_connection_name(workspace_id: &str) -> String {
    format!("ws-{workspace_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::openconnector::fake::FakeOpenConnector;
    use crate::integrations::store::IntegrationStore;
    use crate::workspaces::WorkspaceStore;
    use axum::http::header::AUTHORIZATION;
    use std::sync::Arc as StdArc;

    // ---- constant-time compare -----------------------------------------

    #[test]
    fn hashes_match_constant_time_accepts_the_correct_hash() {
        let hash = sha256_hex("correct-bearer");
        assert!(hashes_match_constant_time(&sha256_hex("correct-bearer"), &hash));
    }

    #[test]
    fn hashes_match_constant_time_rejects_a_wrong_hash() {
        let stored = sha256_hex("correct-bearer");
        assert!(!hashes_match_constant_time(&sha256_hex("wrong-bearer"), &stored));
    }

    #[test]
    fn hashes_match_constant_time_fails_closed_on_a_malformed_stored_hash() {
        // Must not panic on a hex-decode failure — fails the check instead.
        let computed = sha256_hex("anything");
        assert!(!hashes_match_constant_time(&computed, "not-valid-hex-and-wrong-length"));
    }

    #[test]
    fn bearer_shape_prefilter_rejects_too_short_and_too_long() {
        assert!(!bearer_is_plausibly_shaped("short"));
        assert!(!bearer_is_plausibly_shaped(&"a".repeat(600)));
        assert!(bearer_is_plausibly_shaped(&"a".repeat(64)));
    }

    // ---- lockout + audit throttling, end to end via integration_mcp_route --

    async fn temp_pool() -> sqlx::SqlitePool {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        std::mem::forget(dir);
        crate::db::connect(&db_path).await.expect("connect to fresh sqlite db")
    }

    /// `IntegrationsState` wired to a fresh store/`FakeOpenConnector`, with
    /// a `Ready` workspace holding a known runtime token — enough to drive
    /// `integration_mcp_route` end to end without a real OpenConnector or
    /// Docker container, mirroring `route::tests::integrations_state`/
    /// `ready_workspace`'s own setup (kept local to this file since those
    /// two are private to `route`'s test module).
    async fn state_with_runtime_token(
        workspace_id: &str,
        correct_bearer: &str,
    ) -> (Arc<IntegrationsState>, sqlx::SqlitePool) {
        let pool = temp_pool().await;
        let workspace_store = WorkspaceStore::new(pool.clone());
        let idempotency_key = format!("key-{workspace_id}");
        workspace_store
            .begin_creation(&idempotency_key, workspace_id)
            .await
            .expect("begin_creation");
        workspace_store
            .mark_ready(&idempotency_key, "not-a-real-container", 1, 2)
            .await
            .expect("mark_ready");

        let store = IntegrationStore::new(pool.clone());
        let token_cipher = crate::crypto::TokenCipher::new(&[9u8; 32]);
        let encrypted_bearer = token_cipher.encrypt("openconnector-bearer").expect("encrypt");
        store
            .upsert_runtime_token(workspace_id, "token-id-1", &sha256_hex(correct_bearer), &encrypted_bearer)
            .await
            .expect("seed runtime token");

        let state = Arc::new(IntegrationsState {
            store,
            openconnector: StdArc::new(FakeOpenConnector::default()),
            providers: Vec::new(),
            workspace_store,
            http_client: reqwest::Client::new(),
            token_cipher,
            mcp_bearer_lockout: McpBearerLockout::default(),
            catalog_cache: Default::default(),
        });
        (state, pool)
    }

    fn mcp_request_with_bearer(bearer: &str) -> (HeaderMap, Bytes) {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, format!("Bearer {bearer}").parse().unwrap());
        let body = Bytes::from(serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})).unwrap());
        (headers, body)
    }

    async fn audit_row_count(pool: &sqlx::SqlitePool, workspace_id: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM integration_audit WHERE workspace_id = ? AND event = ?",
        )
        .bind(workspace_id)
        .bind("mcp_proxy_invalid_bearer")
        .fetch_one(pool)
        .await
        .expect("count audit rows")
    }

    #[tokio::test]
    async fn the_21st_wrong_bearer_in_a_row_is_locked_out_with_429() {
        let workspace_id = "ws-lockout";
        // Long enough to pass `bearer_is_plausibly_shaped` but never the
        // right value, so every attempt fails the hash check, not the
        // shape prefilter.
        let wrong_bearer = "x".repeat(40);
        let (state, pool_handle) =
            state_with_runtime_token(workspace_id, "the-real-bearer-is-different-1234").await;

        let mut last_status = StatusCode::OK;
        for _ in 0..21 {
            let (headers, body) = mcp_request_with_bearer(&wrong_bearer);
            let response = integration_mcp_route(
                State(state.clone()),
                Path(workspace_id.to_string()),
                headers,
                body,
            )
            .await;
            last_status = response.status();
        }

        assert_eq!(
            last_status,
            StatusCode::TOO_MANY_REQUESTS,
            "the 21st wrong-bearer attempt for one workspace must be locked out"
        );

        let audited = audit_row_count(&pool_handle, workspace_id).await;
        assert!(
            audited < 21,
            "audit rows for repeated failures must stay bounded, not one per attempt: got {audited}"
        );
    }

    #[tokio::test]
    async fn a_successful_bearer_after_failures_resets_the_lockout() {
        let workspace_id = "ws-reset";
        let correct_bearer = "the-actual-correct-bearer-value-here";
        let wrong_bearer = "y".repeat(40);
        let (state, _pool) = state_with_runtime_token(workspace_id, correct_bearer).await;

        for _ in 0..5 {
            let (headers, body) = mcp_request_with_bearer(&wrong_bearer);
            let _ = integration_mcp_route(
                State(state.clone()),
                Path(workspace_id.to_string()),
                headers,
                body,
            )
            .await;
        }

        let (headers, body) = mcp_request_with_bearer(correct_bearer);
        let response = integration_mcp_route(
            State(state.clone()),
            Path(workspace_id.to_string()),
            headers,
            body,
        )
        .await;
        // `FakeOpenConnector::forward_mcp` succeeds by default, so a
        // correct bearer must reach and pass `forward_mcp`, not be
        // rejected at the auth layer — 401/429 here would mean the
        // lockout state was wrong, not this test's own setup.
        assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
        assert_ne!(response.status(), StatusCode::TOO_MANY_REQUESTS);

        // Failure counter must be back at 0: another burst of wrong
        // guesses right after must NOT immediately re-lock.
        for _ in 0..5 {
            let (headers, body) = mcp_request_with_bearer(&wrong_bearer);
            let response = integration_mcp_route(
                State(state.clone()),
                Path(workspace_id.to_string()),
                headers,
                body,
            )
            .await;
            assert_ne!(
                response.status(),
                StatusCode::TOO_MANY_REQUESTS,
                "a reset lockout must allow a fresh run of attempts under the threshold"
            );
        }
    }

    #[test]
    fn rejects_unknown_method() {
        let request = json!({"jsonrpc":"2.0","id":1,"method":"resources/list"});
        let result = sanitize_request("ws-1", &[], request);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_unknown_tool() {
        // `search_actions` used to be the example here, but it (along with
        // `get_action_guide`/`list_apps`/`find_action`) is now a
        // legitimately allowlisted read-only catalog tool — a genuinely
        // unrecognized name is needed to exercise the rejection path.
        let request = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"delete_everything","arguments":{}}
        });
        let result = sanitize_request("ws-1", &[], request);
        assert!(result.is_err());
    }

    #[test]
    fn strips_client_supplied_connection_name_and_alias() {
        let request = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"execute_action","arguments":{
                "actionId":"github.get_current_user",
                "connectionName":"ws-OTHER-TENANT",
                "alias":"ws-ANOTHER-TENANT"
            }}
        });
        let sanitized = sanitize_request("ws-1", &[], request).expect("must sanitize, not reject");
        let arguments = &sanitized["params"]["arguments"];
        assert_eq!(arguments["connectionName"], "ws-ws-1");
        assert!(arguments.get("alias").is_none());
    }

    #[test]
    fn allows_find_action() {
        // `find_action` is the merged search_actions+get_action_guide
        // convenience tool (see `mcp_server.py`) — read-only, like the
        // other catalog-browsing tools, so it must pass the allowlist the
        // same way `search_actions`/`get_action_guide`/`list_apps` do.
        let request = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"find_action","arguments":{"service":"github","query":"search repos"}}
        });
        assert!(sanitize_request("ws-1", &[], request).is_ok());
    }

    #[test]
    fn allows_execute_action_and_list_connections() {
        for tool in ["execute_action", "list_connections"] {
            let request = json!({
                "jsonrpc":"2.0","id":1,"method":"tools/call",
                "params":{"name":tool,"arguments":{}}
            });
            assert!(
                sanitize_request("ws-1", &[], request).is_ok(),
                "{tool} must be allowed"
            );
        }
    }

    fn test_provider(id: &str, allowed_actions: Vec<&str>) -> super::super::Provider {
        super::super::Provider {
            id: id.to_string(),
            name: id.to_string(),
            icon: None,
            openconnector_service: id.to_string(),
            description: None,
            oauth_client_env: None,
            allowed_actions: allowed_actions.into_iter().map(str::to_string).collect(),
        }
    }

    fn execute_action_request(action_id: &str) -> Value {
        json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"execute_action","arguments":{"actionId":action_id,"input":{}}}
        })
    }

    #[test]
    fn a_provider_with_no_allowed_actions_configured_permits_everything() {
        let providers = [test_provider("github", vec![])];
        let request = execute_action_request("github.get_current_user");
        assert!(sanitize_request("ws-1", &providers, request).is_ok());
    }

    #[test]
    fn a_provider_with_an_allowlist_permits_a_listed_action() {
        let providers = [test_provider("github", vec!["github.get_current_user"])];
        let request = execute_action_request("github.get_current_user");
        assert!(sanitize_request("ws-1", &providers, request).is_ok());
    }

    #[test]
    fn a_provider_with_an_allowlist_rejects_an_unlisted_action() {
        let providers = [test_provider("github", vec!["github.get_current_user"])];
        let request = execute_action_request("github.delete_repo");
        let result = sanitize_request("ws-1", &providers, request);
        assert!(result.is_err(), "an action outside the allowlist must be rejected");
    }

    #[test]
    fn an_unknown_provider_is_not_rejected_by_this_proxy() {
        // No provider in the registry named "unknownservice" — this proxy
        // is not the source of truth for "does this service exist",
        // OpenConnector itself rejects it downstream.
        let providers = [test_provider("github", vec!["github.get_current_user"])];
        let request = execute_action_request("unknownservice.some_action");
        assert!(sanitize_request("ws-1", &providers, request).is_ok());
    }

    #[test]
    fn allows_tools_list_and_initialize_without_params() {
        for method in ["tools/list", "initialize", "ping"] {
            let request = json!({"jsonrpc":"2.0","id":1,"method":method});
            assert!(
                sanitize_request("ws-1", &[], request).is_ok(),
                "{method} must be allowed"
            );
        }
    }
}
