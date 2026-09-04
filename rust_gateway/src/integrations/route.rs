//! HTTP routes for the integrations feature. Envelope responses
//! (`crate::response`), matching every other gateway-authored route.
//! `integration_mcp_route` lives in `mcp_proxy.rs` (imported/re-exported
//! here) since it is a distinct, security-critical concern worth its own
//! file — see that module's doc comment.

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use super::mcp_proxy::sha256_hex;
use super::openconnector;
use super::store::ConnectionStatus;
use super::token_delivery;
use super::{IntegrationStore, OpenConnectorApi, Provider};
use crate::response::{error, success};
use crate::workspaces::resolve::{resolve_existing_workspace, resolve_ready_workspace};
use crate::workspaces::route::workspace_target_addr;
use crate::workspaces::WorkspaceStore;

pub use super::mcp_proxy::integration_mcp_route;

/// Shared state for every integrations route. Constructed once at process
/// start (see `bin/rust_gateway.rs`) and cloned as an `Arc`, matching
/// `WorkspacesState`'s existing convention in this crate.
pub struct IntegrationsState {
    pub store: IntegrationStore,
    /// `Arc<dyn OpenConnectorApi>`, not the concrete `OpenConnectorClient`
    /// — mirrors `WorkspacesState::launcher`'s own `Arc<dyn
    /// ContainerLauncher>` (see that struct's doc comment): lets tests
    /// substitute `openconnector::fake::FakeOpenConnector` without a real
    /// OpenConnector container.
    pub openconnector: Arc<dyn OpenConnectorApi>,
    pub providers: Vec<Provider>,
    /// Separate `WorkspaceStore` handle over the SAME underlying SQLite
    /// pool `workspaces::WorkspacesState` uses (see `bin/rust_gateway.rs`
    /// — `SqlitePool` is cheaply `Arc`-cloneable). Needed to resolve a
    /// workspace's `container_name` (for `token_delivery`) and
    /// `wrapper_port` (for forwarding the per-agent enable/disable call
    /// to that workspace's real wrapper) — this module never mutates
    /// workspace rows, only reads them.
    pub workspace_store: WorkspaceStore,
    /// Reused HTTP client for `put_integration_agent_route`'s forward to a
    /// workspace's real wrapper — same reasoning as
    /// `workspaces::route::WorkspacesState::http_client`'s own doc
    /// comment: one client, not a fresh one per request.
    pub http_client: reqwest::Client,
    /// AES-256-GCM cipher for `workspace_runtime_tokens.openconnector_bearer`
    /// — see `crypto::TokenCipher`'s own doc comment. That column stored
    /// the raw OpenConnector bearer in plaintext from the moment it was
    /// introduced; this closes that gap. `finish_connection` encrypts
    /// before writing, `integration_mcp_route` decrypts before forwarding
    /// — `IntegrationStore` itself stores whatever string it's given and
    /// has no opinion on whether it's encrypted.
    pub token_cipher: crate::crypto::TokenCipher,
    /// Per-workspace bearer-guess lockout for `/workspaces/:id/mcp` — see
    /// `mcp_proxy::McpBearerLockout`'s own doc comment. `/mcp` is
    /// session-exempt (`auth/middleware.rs`), so this is the only brute-
    /// force mitigation that route has.
    pub mcp_bearer_lockout: super::mcp_proxy::McpBearerLockout,
    /// In-memory cache for `GET /integrations/catalog` — see
    /// `catalog::CatalogCache`'s own doc comment. Lives on this shared
    /// state (constructed once at process start, same as every other
    /// field here) so the cache is genuinely shared across requests, not
    /// rebuilt per-call.
    pub catalog_cache: super::catalog::CatalogCache,
}

impl IntegrationsState {
    /// `pub(super)` (not private): `catalog.rs`'s
    /// `catalog_connect_route` reuses this exact lookup to reject a
    /// catalog-connect for a `:service` that collides with an existing
    /// curated `providers.yaml` entry — see that call site's own comment.
    pub(super) fn find_provider(&self, provider_id: &str) -> Option<&Provider> {
        self.providers
            .iter()
            .find(|provider| provider.id == provider_id)
    }
}

/// Best-effort audit write — same semantics `IntegrationStore::record_audit`
/// already documents (never fails the caller's own request if the
/// underlying SQLite write itself fails), but now OBSERVABLE: every call
/// site in this module (and `mcp_proxy.rs`) used to do
/// `let _ = state.store.record_audit(...).await;`, which silently
/// dropped a real write failure (disk full, locked DB) with zero signal
/// anywhere that the security audit trail was just lost. One choke point
/// here means every call site gets this for free rather than needing the
/// same `if let Err(...) = ... { tracing::error!(...) }` repeated at each
/// of the seven places that write an audit event.
pub(super) async fn audit(
    state: &IntegrationsState,
    workspace_id: Option<&str>,
    provider_id: Option<&str>,
    event: &str,
    success: bool,
    detail: Option<&str>,
) {
    if let Err(err) = state
        .store
        .record_audit(workspace_id, provider_id, event, success, detail)
        .await
    {
        tracing::error!(event = %event, error = %err, "audit write failed");
    }
}

#[derive(Serialize)]
struct ProviderSummary<'a> {
    id: &'a str,
    name: &'a str,
    icon: Option<&'a str>,
    description: Option<&'a str>,
    /// Marketing homepage the frontend turns into a brand favicon (see
    /// `Provider::homepage_url`); `null` when the catalog entry has none.
    homepage_url: Option<&'a str>,
    /// True only when this provider declares `oauth_client_env` AND both
    /// halves of that credential are actually present in this process's
    /// environment (see `Provider::oauth_credentials`) — the frontend
    /// uses this to decide whether to show the one-click OAuth popup
    /// button or fall back to the `api_key` box. Never a hardcoded
    /// per-provider guess on the frontend side (frontend/AGENTS.md rule #2).
    oauth_available: bool,
}

/// `GET /integrations/providers` — not workspace-scoped, the catalog is
/// the same for everyone. Frontend must call this rather than hardcoding
/// providers (frontend/AGENTS.md rule #2).
pub async fn list_providers_route(State(state): State<Arc<IntegrationsState>>) -> Response {
    let summaries: Vec<ProviderSummary> = state
        .providers
        .iter()
        .map(|provider| ProviderSummary {
            id: &provider.id,
            name: &provider.name,
            icon: provider.icon.as_deref(),
            description: provider.description.as_deref(),
            homepage_url: provider.homepage_url.as_deref(),
            oauth_available: provider.oauth_credentials().is_some(),
        })
        .collect();
    success(StatusCode::OK, summaries)
}

#[derive(Serialize)]
struct ConnectionSummaryOut {
    provider_id: String,
    status: String,
    account_label: Option<String>,
    last_error: Option<String>,
}

fn status_str(status: &ConnectionStatus) -> &'static str {
    match status {
        ConnectionStatus::Pending => "pending",
        ConnectionStatus::Connected => "connected",
        ConnectionStatus::NeedsReauth => "needs_reauth",
        ConnectionStatus::Disconnected => "disconnected",
        ConnectionStatus::Error => "error",
    }
}

/// How long a `pending` OAuth connection is given to complete before the
/// reconciliation pass below gives up on it and marks it `error` — a
/// closed popup, a denied consent screen, or a user who just never came
/// back must not leave the row `pending` forever.
const OAUTH_PENDING_TIMEOUT_SECS: u64 = 600;

/// `GET /workspaces/:id/integrations`
///
/// Also the ONLY place an OAuth popup's success is ever detected —
/// nothing calls this gateway back directly when a popup finishes; the
/// browser instead lands on OpenConnector's own callback response, which
/// this gateway only reverse-proxies (see `oauth_callback_route`) without
/// itself learning which workspace/provider that was for. So instead:
/// every `pending` row is checked against OpenConnector's live connection
/// list on each call to this route, and finished (via `finish_connection`,
/// the same logic `api_key` connect uses) the moment one shows up
/// `configured`. The frontend's `ConnectDialog` polls this route every
/// couple of seconds while a popup is open specifically to drive this.
///
/// Also self-healing for providers with NO local row: every registered
/// provider is checked against OpenConnector's full connection list (one
/// fetch per request), and a `configured` `ws-<workspace_id>` connection
/// found there is finished via the same `finish_connection` — otherwise a
/// connection created out-of-band (OpenConnector's own admin dashboard)
/// would be reported as absent and a second "Connect" would create a
/// redundant one. A provider absent on both sides is omitted (available).
pub async fn list_integrations_route(
    State(state): State<Arc<IntegrationsState>>,
    Path(workspace_id): Path<String>,
) -> Response {
    // Bug 2 (revised): validate the workspace exists BEFORE anything else
    // — reporting a clean 404 immediately (rather than an empty
    // connection list for a workspace that never existed) keeps this
    // route consistent with the others below. Only existence, not
    // `Ready`/ports: viewing the integration list is bookkeeping against
    // `integration_connections`, not container access, so a workspace
    // stuck `Creating`/`Failed` must still be viewable.
    if let Err(response) = resolve_existing_workspace(&state.workspace_store, &workspace_id).await {
        return response;
    }

    let connections = match state.store.list_connections(&workspace_id).await {
        Ok(connections) => connections,
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "integrations_list_failed",
                err.to_string(),
            )
        }
    };

    // Self-healing half of this route: ONE OpenConnector-wide fetch per
    // request (not one per provider), used below to find providers that
    // are already connected on OpenConnector's side but have NO local row
    // at all (created out-of-band, e.g. via OpenConnector's own admin
    // dashboard). Best-effort: a failure here degrades to the local-row
    // behavior above, never a 500 — the list itself is still correct for
    // everything this gateway already knows about.
    let remote_connections = match state.openconnector.list_connections().await {
        Ok(remote) => remote,
        Err(err) => {
            tracing::warn!(workspace_id = %workspace_id, error = %err, "openconnector list_connections failed; skipping discovery of connections with no local row");
            Vec::new()
        }
    };

    let known_provider_ids: Vec<String> =
        connections.iter().map(|c| c.provider_id.clone()).collect();

    let mut out = Vec::with_capacity(connections.len());
    for connection in connections {
        if connection.status != ConnectionStatus::Pending {
            out.push(ConnectionSummaryOut {
                provider_id: connection.provider_id,
                status: status_str(&connection.status).to_string(),
                account_label: connection.account_label,
                last_error: connection.last_error,
            });
            continue;
        }

        out.push(reconcile_pending_connection(&state, &workspace_id, connection).await);
    }

    let connection_name = workspace_connection_name(&workspace_id);
    for provider in &state.providers {
        if known_provider_ids.contains(&provider.id) {
            continue;
        }
        let Some(summary) = remote_connections.iter().find(|c| {
            c.service == provider.openconnector_service
                && c.connection_name == connection_name
                && c.configured
        }) else {
            // Not present on OpenConnector either = available; omitted, per
            // this route's existing "not present = available" contract.
            continue;
        };
        out.push(finish_and_summarize(&state, &workspace_id, &provider.id, summary).await);
    }

    success(StatusCode::OK, out)
}

/// Run `finish_connection` for a connection OpenConnector reports as
/// `configured` and turn its outcome into this route's row summary —
/// shared by `reconcile_pending_connection` (a `pending` OAuth row just
/// completed) and the no-local-row discovery pass above, so both report
/// success and failure identically. `finish_connection` itself persists
/// the `error` status on failure (see its own doc comment) — this only
/// reports it, never writes it a second time.
async fn finish_and_summarize(
    state: &IntegrationsState,
    workspace_id: &str,
    provider_id: &str,
    summary: &openconnector::ConnectionSummary,
) -> ConnectionSummaryOut {
    match finish_connection(state, workspace_id, provider_id, summary).await {
        Ok(()) => ConnectionSummaryOut {
            provider_id: provider_id.to_string(),
            status: status_str(&ConnectionStatus::Connected).to_string(),
            account_label: Some(summary.connection_name.clone()),
            last_error: None,
        },
        Err(_) => ConnectionSummaryOut {
            provider_id: provider_id.to_string(),
            status: status_str(&ConnectionStatus::Error).to_string(),
            account_label: None,
            last_error: Some(
                "Connected on the provider side but finishing setup failed. Try again.".to_string(),
            ),
        },
    }
}

/// Check one `pending` row against OpenConnector and either finish it
/// (found, configured), expire it (too old), or leave it pending
/// (still within the window, not there yet) — returns the row's current
/// (possibly just-updated) summary either way.
async fn reconcile_pending_connection(
    state: &IntegrationsState,
    workspace_id: &str,
    connection: super::store::IntegrationConnection,
) -> ConnectionSummaryOut {
    let Some(provider) = state.find_provider(&connection.provider_id) else {
        // Provider removed from the registry since this row was created —
        // nothing to reconcile against; report as-is.
        return ConnectionSummaryOut {
            provider_id: connection.provider_id,
            status: status_str(&connection.status).to_string(),
            account_label: connection.account_label,
            last_error: connection.last_error,
        };
    };

    let found = state
        .openconnector
        .find_connection(&provider.openconnector_service, &connection.connection_name)
        .await
        .ok()
        .flatten();

    if let Some(summary) = found {
        if summary.configured {
            return finish_and_summarize(state, workspace_id, &connection.provider_id, &summary)
                .await;
        }
    }

    if pending_row_is_expired(&connection.updated_at) {
        let _ = state
            .store
            .mark_error(
                workspace_id,
                &connection.provider_id,
                "The connect attempt timed out. Try again.",
            )
            .await;
        return ConnectionSummaryOut {
            provider_id: connection.provider_id,
            status: status_str(&ConnectionStatus::Error).to_string(),
            account_label: None,
            last_error: Some("The connect attempt timed out. Try again.".to_string()),
        };
    }

    ConnectionSummaryOut {
        provider_id: connection.provider_id,
        status: status_str(&ConnectionStatus::Pending).to_string(),
        account_label: None,
        last_error: None,
    }
}

/// `updated_at` is epoch-seconds (see `store::now_rfc3339`'s doc comment)
/// — parsed defensively: an unparseable value (should not happen) is
/// treated as expired rather than pending forever, fail-safe in the
/// direction of letting a user retry rather than getting stuck.
fn pending_row_is_expired(updated_at: &str) -> bool {
    let Ok(updated_at) = updated_at.parse::<u64>() else {
        return true;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);
    now.saturating_sub(updated_at) > OAUTH_PENDING_TIMEOUT_SECS
}

#[derive(Deserialize)]
pub struct ConnectRequest {
    /// `api_key`-auth credential — matches the POC's confirmed connect
    /// shape. Real OAuth authorization-code connect (returning an
    /// `authorizationUrl` for a popup) is a separate, not-yet-built path
    /// — see `docs/integrations-poc-findings.md`'s "still open" section.
    pub api_key: String,
}

#[derive(Serialize)]
struct ConnectResponseData {
    provider_id: String,
    status: &'static str,
    account_label: Option<String>,
}

#[derive(Serialize)]
struct OAuthStartResponseData {
    authorization_url: String,
}

/// `POST /workspaces/:id/integrations/:provider/oauth/start` — the real
/// one-click OAuth connect. Returns a `authorizationUrl` the frontend
/// opens in a popup; the browser then goes provider -> OpenConnector's
/// own callback (reverse-proxied through THIS gateway — see
/// `oauth_callback_route` — because OpenConnector itself has no public
/// port, per the security model). Completion is detected by
/// `list_integrations_route`'s reconciliation pass, not by this route or
/// the callback route — see that function's doc comment for why.
pub async fn start_oauth_route(
    State(state): State<Arc<IntegrationsState>>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
) -> Response {
    // Bug 2: reject an unknown/not-ready workspace BEFORE ever writing a
    // `pending` row or calling OpenConnector — a bad workspace id must
    // never reach either.
    if let Err(response) = resolve_ready_workspace(&state.workspace_store, &workspace_id).await {
        return response;
    }

    let Some(provider) = state.find_provider(&provider_id) else {
        return error(
            StatusCode::NOT_FOUND,
            "unknown_provider",
            format!("no provider {provider_id:?} in the registry"),
        );
    };

    if provider.oauth_client_env.is_none() {
        return error(
            StatusCode::BAD_REQUEST,
            "oauth_not_supported",
            format!(
                "{} does not support OAuth connect — use api_key instead.",
                provider.name
            ),
        );
    }

    let connection_name = workspace_connection_name(&workspace_id);

    // Bug 3: attempt the OpenConnector call FIRST. Only write the
    // `pending` row once OpenConnector has actually confirmed it started
    // an authorization — otherwise a failure here left a row stuck
    // `pending` until the 10-minute reconciliation timeout expired it, a
    // bad spinner-forever UX for something that failed instantly. On
    // failure, no row is written at all (a prior row from an earlier
    // attempt, if any, is left untouched — nothing here overwrote it yet).
    let result = state
        .openconnector
        .create_oauth_authorization(&provider.openconnector_service, &connection_name)
        .await;

    audit(
        &state,
        Some(&workspace_id),
        Some(&provider_id),
        "oauth_start",
        result.is_ok(),
        None,
    )
    .await;

    let authorization_url = match result {
        Ok(authorization_url) => authorization_url,
        Err(err) => {
            tracing::warn!(workspace_id = %workspace_id, provider = %provider_id, error = %err, "openconnector create_oauth_authorization failed");
            return error(StatusCode::BAD_GATEWAY, err.safe_code(), err.safe_message());
        }
    };

    if let Err(err) = state
        .store
        .mark_pending(
            &Uuid::new_v4().to_string(),
            &workspace_id,
            &provider_id,
            &connection_name,
        )
        .await
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "integrations_store_failed",
            err.to_string(),
        );
    }

    success(StatusCode::OK, OAuthStartResponseData { authorization_url })
}

/// `GET /oauth/callback` — MUST be this exact path, not a namespaced one
/// like `/integrations/callback`: confirmed LIVE that OpenConnector
/// computes the redirect URI it hands to the provider as
/// `OOMOL_CONNECT_ORIGIN` + the fixed, non-configurable `/oauth/callback`
/// (visible in a real `GET /api/oauth/configs` response's
/// `expectedRedirectUri` field) — a route registered at any other path
/// here would never receive the provider's redirect at all. An earlier
/// version of this route used `/integrations/callback` and was wrong for
/// exactly this reason, caught by hitting a real OpenConnector instance,
/// not assumed correct from documentation.
///
/// NOT workspace-scoped (a provider's redirect carries only `code`/`state`,
/// opaque values OpenConnector itself assigned; there is no workspace id
/// to put in this path). Pure reverse proxy to OpenConnector's OWN
/// `/oauth/callback`, preserving the full query string, because
/// OpenConnector has no public port in this deployment's security model —
/// a provider like GitHub cannot redirect the user's browser directly to
/// it. This gateway's public URL (`OOMOL_CONNECT_ORIGIN`, set to the
/// gateway's own address, NOT OpenConnector's) is what actually gets
/// registered as the OAuth app's redirect URI.
///
/// Real bug hit live (confirmed against a real GitHub OAuth app, not a
/// synthetic test): this route used to relay OpenConnector's callback
/// response BODY AND STATUS verbatim back to the browser. That response
/// is a plain, unwrapped body (HTML or a bare JSON shape, depending on
/// success/failure) that this app's frontend was never built to parse —
/// `apiFetch` on every OTHER route expects this crate's own
/// `{ok, data}`/`{ok, error}` envelope (see `crate::response`), so a raw
/// OpenConnector body landing in the popup surfaced as a generic
/// "Couldn't read the server response" toast even on a real, successful
/// connect. `docs/integrations-poc-findings.md` had already flagged this
/// exact response shape as "unverified against a real provider" — this is
/// that verification, and the fix it called for.
///
/// The real completion signal was ALREADY separate and correct:
/// `use-oauth-connect.ts`'s popup-closed poll hits
/// `GET /workspaces/:id/integrations` (`list_integrations_route`, which
/// reconciles a `pending` row against OpenConnector's live connection
/// list) — this route's own response body was never actually consumed by
/// anything. So OpenConnector's real call still happens exactly as
/// before (needed so the token exchange completes), but the browser is
/// now handed a small, self-contained HTML page that just closes the
/// popup instead of whatever OpenConnector itself returned — decoupling
/// what the user's browser sees from OpenConnector's internal response
/// shape entirely, which is the actual fix rather than a guess at what
/// shape to expect.
pub async fn oauth_callback_route(
    State(state): State<Arc<IntegrationsState>>,
    req: Request,
) -> Response {
    let target_addr = match state.openconnector.host_and_port() {
        Some(addr) => addr,
        None => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "openconnector_url_invalid",
                "OPENCONNECTOR_URL is not a valid host:port URL.",
            )
        }
    };
    // `forward_to`'s `rewrite_path` REPLACES the outgoing path+query
    // entirely (see its own doc comment) — the provider's redirect
    // carries `code`/`state` as query params, so the query string must be
    // preserved explicitly here, the same way
    // `wrapper_prefix_proxy::forward_to_wrapper_namespace` does for every
    // other proxy in this crate.
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let rewritten_path = format!("/oauth/callback{query}");
    // Still actually calls OpenConnector — this is what completes the
    // real token exchange server-side. Only the RESPONSE the browser sees
    // is replaced below; OpenConnector's own work here is unaffected.
    let upstream_response =
        crate::proxy::forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path))
            .await;
    let upstream_status = upstream_response.status();

    // OpenConnector's own real error (state expired/reused, provider
    // denied access, etc.) still surfaces as a real HTTP error status —
    // only a genuinely successful exchange (2xx) gets the "just close"
    // treatment. A non-2xx keeps its real status and OpenConnector's
    // error body, so a failed connect is still debuggable from the
    // Network tab rather than silently reported as success.
    if !upstream_status.is_success() {
        return upstream_response;
    }

    const CLOSE_POPUP_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>Connected</title></head>
<body>
<script>
  try { window.close(); } catch (e) {}
</script>
<p>Connected. You can close this window.</p>
</body></html>"#;

    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        CLOSE_POPUP_HTML,
    )
        .into_response()
}

/// `POST /workspaces/:id/integrations/:provider/connect`
///
/// This slice's connect path only: `api_key` auth, synchronous (no
/// popup/poll cycle) — matches exactly what the POC exercised end to end
/// against a real OpenConnector container. The OAuth authorization-code
/// flow (popup, callback, poll) described in the full plan is real
/// follow-up work, not silently downgraded to this without saying so.
pub async fn connect_integration_route(
    State(state): State<Arc<IntegrationsState>>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
    Json(request): Json<ConnectRequest>,
) -> Response {
    // Bug 2: reject an unknown/not-ready workspace BEFORE ever calling
    // OpenConnector. Confirmed live: skipping this let a real
    // `connect_with_api_key` call create a real, working OpenConnector
    // connection (`ws-<bad-id>`) for a workspace that doesn't exist or
    // isn't ready — nothing ever cleaned that up.
    if let Err(response) = resolve_ready_workspace(&state.workspace_store, &workspace_id).await {
        return response;
    }

    let Some(provider) = state.find_provider(&provider_id) else {
        return error(
            StatusCode::NOT_FOUND,
            "unknown_provider",
            format!("no provider {provider_id:?} in the registry"),
        );
    };

    let connection_name = workspace_connection_name(&workspace_id);

    let connection_summary = match state
        .openconnector
        .connect_with_api_key(
            &provider.openconnector_service,
            &connection_name,
            &request.api_key,
        )
        .await
    {
        Ok(summary) => summary,
        // Nothing was created on OpenConnector's side in this branch —
        // `connect_with_api_key` itself is what failed — so no
        // compensation is needed here.
        Err(err) => {
            tracing::warn!(workspace_id = %workspace_id, provider = %provider_id, error = %err, "openconnector connect_with_api_key failed");
            return error(StatusCode::BAD_GATEWAY, err.safe_code(), err.safe_message());
        }
    };

    match finish_connection(&state, &workspace_id, &provider_id, &connection_summary).await {
        Ok(()) => success(
            StatusCode::OK,
            ConnectResponseData {
                provider_id,
                status: "connected",
                account_label: Some(connection_summary.connection_name),
            },
        ),
        Err(response) => {
            // Compensation: `connect_with_api_key` above DID succeed —
            // OpenConnector really holds this connection now — but
            // something after it failed. Best-effort delete so this
            // connection doesn't orphan forever; never let a compensation
            // failure mask/replace the real error being returned.
            let compensation_result = state
                .openconnector
                .delete_connection(&provider.openconnector_service, &connection_name)
                .await;
            audit(
                &state,
                Some(&workspace_id),
                Some(&provider_id),
                "connect_compensated",
                compensation_result.is_ok(),
                None,
            )
            .await;
            response
        }
    }
}

/// Everything that must happen once OpenConnector reports a connection as
/// `configured` — shared by BOTH connect paths: `connect_integration_route`
/// calls it synchronously right after `api_key` connect succeeds;
/// `list_integrations_route`'s reconciliation pass calls it the moment it
/// notices an OAuth popup finished (see that function's doc comment for
/// why OAuth can't call this synchronously the way `api_key` does).
///
/// Stores the connection row as `Connected`, creates a fresh
/// workspace-scoped OpenConnector runtime token (always create-new, never
/// patch — see the POC finding that in-place token updates don't work),
/// and delivers the bearer into the workspace's real container. Requires
/// the workspace to have a running container; returns a clean
/// `workspace_not_ready` error otherwise rather than storing a token no
/// container will ever pick up.
pub(super) async fn finish_connection(
    state: &IntegrationsState,
    workspace_id: &str,
    provider_id: &str,
    connection_summary: &openconnector::ConnectionSummary,
) -> Result<(), Response> {
    let result =
        finish_connection_inner(state, workspace_id, provider_id, connection_summary).await;
    if result.is_err() {
        // MUST persist this — a real bug hit live: `finish_connection_inner`'s
        // first step already wrote this row's status to `connected` before
        // a LATER step (token creation, or delivery into the container)
        // failed, and without this the row stays stuck at `connected` in
        // the database forever despite the workspace having no working
        // token — confirmed live via a container missing `/run/hermes`.
        // Every caller of `finish_connection` gets this for free, so
        // fixing it once here covers both the synchronous `api_key` path
        // and the OAuth reconciliation poll, rather than duplicating the
        // fix at each call site.
        let _ = state
            .store
            .mark_error(
                workspace_id,
                provider_id,
                "Connected on the provider side but finishing setup failed. Try again.",
            )
            .await;
    }
    audit(
        state,
        Some(workspace_id),
        Some(provider_id),
        "connect_finished",
        result.is_ok(),
        None,
    )
    .await;
    result
}

/// HTTP-agnostic failure from `issue_and_deliver_runtime_token` — mirrors
/// `token_delivery::TokenDeliveryError`'s shape (plain `message: String`)
/// rather than reusing `openconnector::OpenConnectorError` directly: that
/// type's `safe_message`/`safe_code` are specifically about an
/// OpenConnector HTTP response's status code, which doesn't fit a DB or
/// encryption failure at all — a caller that needs OpenConnector's own
/// safe/code pair still has it via the `OpenConnector` variant. Kept in
/// this module (not `openconnector.rs`) because it exists purely to give
/// `issue_and_deliver_runtime_token` — a `route.rs`-local helper — a
/// return type that doesn't drag in axum's `Response`, so it stays usable
/// from a non-HTTP caller like workspace creation.
#[derive(Debug)]
pub(crate) enum IntegrationsTokenError {
    OpenConnector(openconnector::OpenConnectorError),
    TokenEncryptionFailed(crate::crypto::CryptoError),
    RuntimeTokenStoreFailed(sqlx::Error),
    TokenDeliveryFailed(token_delivery::TokenDeliveryError),
}

impl std::fmt::Display for IntegrationsTokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpenConnector(err) => write!(f, "{err}"),
            Self::TokenEncryptionFailed(err) => write!(f, "token encryption failed: {err}"),
            Self::RuntimeTokenStoreFailed(err) => write!(f, "runtime token store failed: {err}"),
            Self::TokenDeliveryFailed(err) => write!(f, "token delivery failed: {err}"),
        }
    }
}

impl std::error::Error for IntegrationsTokenError {}

impl IntegrationsTokenError {
    /// Turn this HTTP-agnostic error into the exact `Response` shape
    /// `rotate_workspace_token`'s callers have always returned — kept
    /// here (not scattered across call sites) so this mapping exists in
    /// exactly one place. Every `code`/status pairing below is copied
    /// verbatim from what this same branch produced before the
    /// extraction (see the removed code this replaces), so a caller
    /// re-checking `rotate_workspace_token`'s existing tests sees
    /// identical responses.
    fn into_response(self) -> Response {
        match self {
            Self::OpenConnector(err) => {
                error(StatusCode::BAD_GATEWAY, err.safe_code(), err.safe_message())
            }
            Self::TokenEncryptionFailed(err) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "token_encryption_failed",
                err.to_string(),
            ),
            Self::RuntimeTokenStoreFailed(err) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "runtime_token_store_failed",
                err.to_string(),
            ),
            Self::TokenDeliveryFailed(err) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "integrations_token_delivery_failed",
                err.to_string(),
            ),
        }
    }
}

/// Create a fresh OpenConnector runtime token scoped to exactly
/// `allowed_connection_ids`, store it (encrypted) for `workspace_id`, and
/// deliver it into `container_name` — the reusable create→hash→encrypt→
/// store→deliver core `rotate_workspace_token` wraps with its own
/// previous-token lookup/revoke (connect-flow-specific — a fresh
/// workspace creation has no previous token to revoke, see
/// `workspaces::route::create::create_workspace_route`'s own call).
///
/// Returns the new token's `openconnector_token_id` — `rotate_workspace_token`
/// needs it to decide whether the previous token is actually different
/// (and therefore safe to revoke); the creation-time caller has no
/// previous token at all and simply ignores it.
///
/// HTTP-agnostic on purpose (`IntegrationsTokenError`, not
/// `Result<(), Response>`): this is called both from an axum handler's
/// call graph (via `rotate_workspace_token`) and from workspace creation,
/// which has no `Response` to return at all.
pub(crate) async fn issue_and_deliver_runtime_token(
    state: &IntegrationsState,
    workspace_id: &str,
    container_name: &str,
    allowed_connection_ids: &[String],
) -> Result<String, IntegrationsTokenError> {
    let token_name = format!("workspace:{workspace_id}");
    let runtime_token = state
        .openconnector
        .create_runtime_token(&token_name, allowed_connection_ids)
        .await
        .map_err(|err| {
            tracing::warn!(workspace_id = %workspace_id, error = %err, "openconnector create_runtime_token failed");
            IntegrationsTokenError::OpenConnector(err)
        })?;

    let token_hash = sha256_hex(&runtime_token.bearer);
    let encrypted_bearer = state
        .token_cipher
        .encrypt(&runtime_token.bearer)
        .map_err(IntegrationsTokenError::TokenEncryptionFailed)?;
    state
        .store
        .upsert_runtime_token(
            workspace_id,
            &runtime_token.openconnector_token_id,
            &token_hash,
            &encrypted_bearer,
        )
        .await
        .map_err(IntegrationsTokenError::RuntimeTokenStoreFailed)?;

    // `runtime_token.bearer` itself must never be logged or returned to a
    // caller — it is now ONLY on disk inside the container (as a 0400
    // file) and, encrypted, in `workspace_runtime_tokens.openconnector_bearer`;
    // this local variable goes out of scope at the end of this function.
    token_delivery::deliver_token_file(container_name, &runtime_token.bearer)
        .await
        .map_err(IntegrationsTokenError::TokenDeliveryFailed)?;

    Ok(runtime_token.openconnector_token_id)
}

/// Thin wrapper around `issue_and_deliver_runtime_token` for the
/// connect/disconnect flows: adds the previous-token lookup and, on
/// success, revokes it — see this function's own doc comment history
/// (Bug 1's fix) for why that lookup→create→...→revoke-old sequence must
/// exist in exactly one place. Behavior is UNCHANGED from before this was
/// split out of a single function — see this file's `#[cfg(test)]`
/// module for the pinned tests proving that.
///
/// Rotation atomicity: the OLD token is only ever revoked AFTER the new
/// one is confirmed stored AND delivered — never the reverse — so a
/// mid-rotation failure leaves the workspace with its OLD, still-valid
/// token rather than none at all. Skipped when there is no previous
/// token, or when "previous" IS the token just created (a call re-entered
/// on the same token — should not happen, but revoking a token this call
/// itself just issued would be a real bug if it ever did).
async fn rotate_workspace_token(
    state: &IntegrationsState,
    workspace_id: &str,
    container_name: &str,
    allowed_connection_ids: &[String],
) -> Result<(), Response> {
    // Bug 5: a transient DB error here is NOT "no previous token" — that
    // would silently skip revoking a real, still-valid OpenConnector
    // token, leaking it forever. Propagate the error instead of
    // swallowing it with `.ok().flatten()`.
    let previous_token = state
        .store
        .find_runtime_token(workspace_id)
        .await
        .map_err(|err| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "runtime_token_lookup_failed",
                err.to_string(),
            )
        })?;

    let new_token_id = issue_and_deliver_runtime_token(
        state,
        workspace_id,
        container_name,
        allowed_connection_ids,
    )
    .await
    .map_err(IntegrationsTokenError::into_response)?;

    if let Some(previous) = previous_token {
        if previous.openconnector_token_id != new_token_id {
            let _ = state
                .openconnector
                .revoke_runtime_token(&previous.openconnector_token_id)
                .await;
        }
    }

    Ok(())
}

async fn finish_connection_inner(
    state: &IntegrationsState,
    workspace_id: &str,
    provider_id: &str,
    connection_summary: &openconnector::ConnectionSummary,
) -> Result<(), Response> {
    let connection_name = workspace_connection_name(workspace_id);

    // Bug 2 (narrow half fixed here too): resolve the container BEFORE
    // touching OpenConnector's token or this row's status — a workspace
    // still `Creating` at connect time is reported as a clean error
    // rather than silently storing a token no container will ever pick
    // up. Moved ahead of the token/connected-row writes below (Bug 4's
    // reorder) rather than staying as the very last check.
    let record = state
        .workspace_store
        .find_by_workspace_id(workspace_id)
        .await
        .map_err(|err| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_lookup_failed",
                err.to_string(),
            )
        })?;
    let Some(container_name) = record.and_then(|r| r.container_name) else {
        return Err(error(
            StatusCode::CONFLICT,
            "workspace_not_ready",
            "This workspace has no running container yet — connect an \
             integration only after its container is ready.",
        ));
    };

    // Bug 1: the token must allow EVERY provider this workspace still has
    // `Connected`, not just the one being connected right now — otherwise
    // each new connect narrows the token down to just itself, silently
    // revoking every other provider's access (confirmed live: connect
    // GitHub, then Slack, and GitHub's `execute_action` calls started
    // failing `connection_not_allowed`). This connection's own row is not
    // necessarily `Connected` in the DB yet at this point (see Bug 4's
    // reorder below — the `Connected` write now happens LAST), so its id
    // is added explicitly rather than relying on `list_connections`
    // already reporting it.
    let mut allowed_connection_ids: Vec<String> = state
        .store
        .list_connections(workspace_id)
        .await
        .map_err(|err| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "integrations_store_failed",
                err.to_string(),
            )
        })?
        .into_iter()
        .filter(|c| c.status == ConnectionStatus::Connected)
        .filter_map(|c| c.openconnector_connection_id)
        .collect();
    if !allowed_connection_ids.contains(&connection_summary.id) {
        allowed_connection_ids.push(connection_summary.id.clone());
    }

    // Write this connection's row as `Pending` (not `Connected` — see
    // Bug 4 below) BEFORE attempting the token rotation. This is NOT the
    // `Connected` write itself; it exists only so the outer
    // `finish_connection`'s `mark_error` compensation (an UPDATE, not an
    // upsert — see `IntegrationStore::mark_error`) always has a row to
    // flip to `error` if rotation fails below, rather than silently
    // no-op-ing against a row that was never created. Overwritten by the
    // real `Connected` write on success, a few lines down.
    state
        .store
        .upsert_connection(
            &Uuid::new_v4().to_string(),
            workspace_id,
            provider_id,
            &connection_name,
            Some(&connection_summary.id),
            ConnectionStatus::Pending,
            None,
        )
        .await
        .map_err(|err| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "integrations_store_failed",
                err.to_string(),
            )
        })?;

    // Bug 4: token creation + storage + delivery ALL happen BEFORE this
    // connection's row is written `Connected` — previously the
    // `Connected` write ran first, so a later token/delivery failure left
    // the row lying about having a working token (a real bug hit live via
    // a container missing `/run/hermes`). The outer `finish_connection`
    // still applies its `mark_error` compensation on ANY failure here as
    // a safety net — this reorder is what stops the happy path from ever
    // showing that lie in the first place.
    rotate_workspace_token(
        state,
        workspace_id,
        &container_name,
        &allowed_connection_ids,
    )
    .await?;

    state
        .store
        .upsert_connection(
            &Uuid::new_v4().to_string(),
            workspace_id,
            provider_id,
            &connection_name,
            Some(&connection_summary.id),
            ConnectionStatus::Connected,
            Some(&connection_summary.connection_name),
        )
        .await
        .map_err(|err| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "integrations_store_failed",
                err.to_string(),
            )
        })?;

    Ok(())
}

/// `DELETE /workspaces/:id/integrations/:provider`
pub async fn disconnect_integration_route(
    State(state): State<Arc<IntegrationsState>>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
) -> Response {
    // Bug 2 (revised): reject an unknown workspace id BEFORE ever calling
    // OpenConnector or touching the store — but only existence, not
    // `Ready`/ports: disconnecting a provider is bookkeeping against
    // `integration_connections` (plus a best-effort OpenConnector
    // delete), not container access, so a workspace stuck
    // `Creating`/`Failed` must still be allowed to disconnect.
    if let Err(response) = resolve_existing_workspace(&state.workspace_store, &workspace_id).await {
        return response;
    }

    let Some(provider) = state.find_provider(&provider_id) else {
        return error(
            StatusCode::NOT_FOUND,
            "unknown_provider",
            format!("no provider {provider_id:?} in the registry"),
        );
    };

    let connection_name = workspace_connection_name(&workspace_id);
    if let Err(err) = state
        .openconnector
        .delete_connection(&provider.openconnector_service, &connection_name)
        .await
    {
        audit(
            &state,
            Some(&workspace_id),
            Some(&provider_id),
            "disconnect",
            false,
            None,
        )
        .await;
        // Issue 2: `err` may embed OpenConnector's raw response body —
        // log the real detail server-side, return only the fixed,
        // non-leaking message to the caller (a browser here).
        tracing::warn!(workspace_id = %workspace_id, provider = %provider_id, error = %err, "openconnector delete_connection failed");
        return error(StatusCode::BAD_GATEWAY, err.safe_code(), err.safe_message());
    }

    if let Err(err) = state
        .store
        .mark_disconnected(&workspace_id, &provider_id)
        .await
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "integrations_store_failed",
            err.to_string(),
        );
    }

    // Bug 1: a workspace with OTHER still-connected providers must have
    // its token ROTATED to a narrower `allowedConnections` set, not left
    // pointing at a connection that no longer exists — previously this
    // case was silently left alone entirely (see the removed comment this
    // replaces). Only a workspace with NO connections left tears its
    // token down completely (existing behavior, unchanged).
    let remaining = match state.store.list_connections(&workspace_id).await {
        Ok(remaining) => remaining,
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "integrations_store_failed",
                err.to_string(),
            )
        }
    };
    let remaining_connection_ids: Vec<String> = remaining
        .iter()
        .filter(|c| c.status == ConnectionStatus::Connected)
        .filter_map(|c| c.openconnector_connection_id.clone())
        .collect();

    if remaining_connection_ids.is_empty() {
        // Bug 5: propagate a real DB error rather than treating it the
        // same as "no previous token" — that would silently skip
        // revoking a real, still-valid OpenConnector token.
        let previous_token = match state.store.find_runtime_token(&workspace_id).await {
            Ok(token) => token,
            Err(err) => {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "runtime_token_lookup_failed",
                    err.to_string(),
                )
            }
        };
        if let Some(token) = previous_token {
            let _ = state
                .openconnector
                .revoke_runtime_token(&token.openconnector_token_id)
                .await;
            let _ = state.store.delete_runtime_token(&workspace_id).await;
        }
        if let Ok(Some(record)) = state
            .workspace_store
            .find_by_workspace_id(&workspace_id)
            .await
        {
            if let Some(container_name) = record.container_name {
                let _ = token_delivery::remove_token_file(&container_name).await;
            }
        }
    } else if let Ok(Some(record)) = state
        .workspace_store
        .find_by_workspace_id(&workspace_id)
        .await
    {
        if let Some(container_name) = record.container_name {
            // Best-effort: a rotation failure here must not fail the
            // disconnect itself (the disconnect already succeeded on
            // OpenConnector's side and in the store above) — the
            // workspace is simply left holding its previous, now
            // slightly-too-broad token until the next successful
            // connect/disconnect rotates it again.
            let _ = rotate_workspace_token(
                &state,
                &workspace_id,
                &container_name,
                &remaining_connection_ids,
            )
            .await;
        }
    }

    audit(
        &state,
        Some(&workspace_id),
        Some(&provider_id),
        "disconnect",
        true,
        None,
    )
    .await;

    success(
        StatusCode::OK,
        serde_json::json!({ "provider_id": provider_id, "status": "disconnected" }),
    )
}

/// `PUT /workspaces/:id/integrations/agents/:agent` — forwards `{enabled}`
/// to that workspace's REAL wrapper (`PUT /api/wrapper/v1/integrations/agents/:agent`,
/// see `backend/wrapper/src/hermes_webui_wrapper/api/v1/integrations.py`).
///
/// Deliberately hand-rolled here rather than reusing
/// `workspaces::proxy::wrapper_prefix_proxy::forward_to_wrapper_namespace`
/// (the pattern every other `/workspaces/:id/<namespace>/*` proxy uses):
/// that helper is `pub(super)` to `workspaces::proxy`, not reachable from
/// this sibling module, and registering an equivalent
/// `register_workspace_proxy_pair` inside `app::build_router` at a
/// namespace literally named `integrations` would collide with THIS
/// module's own `/workspaces/:id/integrations` routes once both routers
/// are merged (axum panics on an exact-path route conflict) — see
/// `bin/rust_gateway.rs`'s merge. A distinct implementation, reusing the
/// same underlying `crate::proxy::forward_to` primitive, avoids both
/// problems without touching `build_router` itself.
pub async fn put_integration_agent_route(
    State(state): State<Arc<IntegrationsState>>,
    Path((workspace_id, agent_slug)): Path<(String, String)>,
    req: Request,
) -> Response {
    let ports = match resolve_ready_workspace(&state.workspace_store, &workspace_id).await {
        Ok(ports) => ports,
        Err(response) => return response,
    };

    let target_addr = workspace_target_addr(ports.wrapper_port);
    let rewritten_path = format!("/api/wrapper/v1/integrations/agents/{agent_slug}");
    crate::proxy::forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
}

/// `GET /workspaces/:id/integrations/agents` — the read counterpart to
/// `put_integration_agent_route` above (same reasoning for being
/// hand-rolled rather than a `register_workspace_proxy_pair`), forwarding
/// to the wrapper's `GET /api/wrapper/v1/integrations/agents`. Lets the
/// frontend restore per-agent toggle state after a page reload instead of
/// defaulting every switch to "off" regardless of what was actually set.
pub async fn list_integration_agents_route(
    State(state): State<Arc<IntegrationsState>>,
    Path(workspace_id): Path<String>,
    req: Request,
) -> Response {
    let ports = match resolve_ready_workspace(&state.workspace_store, &workspace_id).await {
        Ok(ports) => ports,
        Err(response) => return response,
    };

    let target_addr = workspace_target_addr(ports.wrapper_port);
    let rewritten_path = "/api/wrapper/v1/integrations/agents".to_string();
    crate::proxy::forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
}

pub(super) fn workspace_connection_name(workspace_id: &str) -> String {
    format!("ws-{workspace_id}")
}

/// Standalone router for every integrations route, merged onto the main
/// router in `bin/rust_gateway.rs` (see that file). Kept separate from
/// `app::build_router` deliberately — that function has ten existing
/// tests pinned to its exact signature; a brand-new feature composes
/// alongside it via `Router::merge`, axum's normal pattern for this,
/// rather than widening a function every existing caller and test must
/// then be updated for.
pub fn router(state: Arc<IntegrationsState>) -> Router {
    Router::new()
        .route("/integrations/providers", get(list_providers_route))
        .route("/workspaces/:id/integrations", get(list_integrations_route))
        .route(
            "/workspaces/:id/integrations/:provider/connect",
            post(connect_integration_route),
        )
        .route(
            "/workspaces/:id/integrations/:provider/oauth/start",
            post(start_oauth_route),
        )
        .route("/oauth/callback", get(oauth_callback_route))
        .route(
            "/workspaces/:id/integrations/:provider",
            delete(disconnect_integration_route),
        )
        .route(
            "/workspaces/:id/integrations/agents",
            get(list_integration_agents_route),
        )
        .route(
            "/workspaces/:id/integrations/agents/:agent",
            put(put_integration_agent_route),
        )
        .route("/workspaces/:id/mcp", post(integration_mcp_route))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::openconnector::fake::FakeOpenConnector;
    use crate::integrations::store::IntegrationStore;
    use crate::workspaces::WorkspaceStore;
    use tracing_test::traced_test;

    fn seconds_ago(seconds: u64) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        (now - seconds).to_string()
    }

    #[test]
    fn pending_row_is_not_expired_within_the_timeout_window() {
        assert!(!pending_row_is_expired(&seconds_ago(60)));
    }

    #[test]
    fn pending_row_is_expired_past_the_timeout_window() {
        assert!(pending_row_is_expired(&seconds_ago(
            OAUTH_PENDING_TIMEOUT_SECS + 1
        )));
    }

    #[test]
    fn pending_row_is_expired_on_unparseable_timestamp_fail_safe() {
        assert!(
            pending_row_is_expired("not-a-number"),
            "an unparseable updated_at must expire the row (let the user retry) \
             rather than leave it pending forever"
        );
    }

    #[test]
    fn workspace_connection_name_is_gateway_generated_never_user_supplied() {
        assert_eq!(workspace_connection_name("abc-123"), "ws-abc-123");
    }

    // ---- shared test setup ------------------------------------------

    /// Fresh, isolated SQLite pool with every migration applied (both
    /// `workspace_creations` and `integration_connections`/
    /// `workspace_runtime_tokens`) — same "leak the tempdir, pool outlives
    /// it for this short-lived test process" convention as
    /// `workspaces::test_support::temp_store`.
    async fn temp_pool() -> sqlx::SqlitePool {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        std::mem::forget(dir);
        crate::db::connect(&db_path)
            .await
            .expect("connect to fresh sqlite db")
    }

    fn test_token_cipher() -> crate::crypto::TokenCipher {
        crate::crypto::TokenCipher::new(&[7u8; 32])
    }

    /// Build an `IntegrationsState` wired to a fresh store + the given
    /// fake OpenConnector — mirrors `workspaces::test_support::state_with_store`'s
    /// "launcher is a parameter" reasoning: different tests need
    /// different `FakeOpenConnector` failure behavior.
    async fn integrations_state(
        openconnector: Arc<FakeOpenConnector>,
    ) -> (Arc<IntegrationsState>, sqlx::SqlitePool) {
        let pool = temp_pool().await;
        let state = Arc::new(IntegrationsState {
            store: IntegrationStore::new(pool.clone()),
            openconnector,
            providers: vec![test_provider("github"), test_provider("slack")],
            workspace_store: WorkspaceStore::new(pool.clone()),
            http_client: reqwest::Client::new(),
            token_cipher: test_token_cipher(),
            mcp_bearer_lockout: Default::default(),
            catalog_cache: Default::default(),
        });
        (state, pool)
    }

    fn test_provider(id: &str) -> Provider {
        Provider {
            id: id.to_string(),
            name: id.to_string(),
            icon: None,
            openconnector_service: id.to_string(),
            description: None,
            homepage_url: None,
            // `Some` (not `None`) so `start_oauth_route`'s
            // `oauth_not_supported` check does not short-circuit before
            // ever reaching OpenConnector — every OAuth-path test in this
            // module needs a provider that actually supports it. The
            // referenced env vars are never set in this test process, but
            // `start_oauth_route` itself never calls `oauth_credentials()`
            // (only `bin/rust_gateway.rs`'s startup wiring does), so that
            // does not matter here.
            oauth_client_env: Some(format!("TEST_{}_OAUTH", id.to_uppercase())),
            allowed_actions: Vec::new(),
        }
    }

    /// Create a `Ready` workspace row (with a `container_name`, though it
    /// is never a real, reachable container — every test here that
    /// reaches `token_delivery::deliver_token_file` expects that real
    /// `docker` call to fail, matching Bug 4's "token delivery fails"
    /// scenario, since this crate has no Docker-free fake for
    /// `token_delivery` to substitute — see this module's own doc
    /// comment on `IntegrationsState::workspace_store`).
    async fn ready_workspace(pool: &sqlx::SqlitePool, workspace_id: &str) -> WorkspaceStore {
        let store = WorkspaceStore::new(pool.clone());
        let idempotency_key = format!("key-{workspace_id}");
        store
            .begin_creation(&idempotency_key, workspace_id)
            .await
            .expect("begin_creation");
        store
            .mark_ready(&idempotency_key, "not-a-real-container", 1, 2, 3)
            .await
            .expect("mark_ready");
        store
    }

    // ---- GET /integrations/providers exposes homepage_url --------------

    #[tokio::test]
    async fn list_providers_returns_each_providers_homepage_url() {
        let pool = temp_pool().await;
        let mut github = test_provider("github");
        github.homepage_url = Some("https://example.com".to_string());
        let state = Arc::new(IntegrationsState {
            store: IntegrationStore::new(pool.clone()),
            openconnector: Arc::new(FakeOpenConnector::default()),
            providers: vec![github, test_provider("slack")],
            workspace_store: WorkspaceStore::new(pool),
            http_client: reqwest::Client::new(),
            token_cipher: test_token_cipher(),
            mcp_bearer_lockout: Default::default(),
            catalog_cache: Default::default(),
        });

        let response = list_providers_route(State(state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["data"][0]["homepage_url"], "https://example.com");
        assert_eq!(
            body["data"][1]["homepage_url"],
            serde_json::Value::Null,
            "a provider without a homepage must serialize null, not be dropped"
        );
    }

    // ---- Bug 1: second connect must not narrow the first provider out ----

    #[tokio::test]
    async fn connecting_a_second_provider_includes_both_connection_ids_in_the_new_token() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake.clone()).await;
        let workspace_id = "ws-1";
        ready_workspace(&pool, workspace_id).await;

        // First connect: `finish_connection` will fail at token delivery
        // (no real container — see `ready_workspace`'s doc comment), but
        // `create_runtime_token` is called BEFORE delivery, so the fake
        // still records what it was asked to allow.
        let github_summary = openconnector::ConnectionSummary {
            id: "conn-github".to_string(),
            service: "github".to_string(),
            connection_name: "ws-ws-1".to_string(),
            configured: true,
        };
        let _ = finish_connection(&state, workspace_id, "github", &github_summary).await;

        // GitHub's row is NOT `Connected` (delivery failed — see Bug 4),
        // so simulate the invariant Bug 1's fix must not depend on it
        // being there: manually mark it Connected as if delivery HAD
        // succeeded, the same state a real successful first connect would
        // leave behind, then connect Slack.
        state
            .store
            .upsert_connection(
                "row-github",
                workspace_id,
                "github",
                "ws-ws-1",
                Some("conn-github"),
                ConnectionStatus::Connected,
                Some("ws-ws-1"),
            )
            .await
            .expect("mark github connected");

        let slack_summary = openconnector::ConnectionSummary {
            id: "conn-slack".to_string(),
            service: "slack".to_string(),
            connection_name: "ws-ws-1".to_string(),
            configured: true,
        };
        let _ = finish_connection(&state, workspace_id, "slack", &slack_summary).await;

        let calls = fake.create_runtime_token_calls();
        assert_eq!(calls.len(), 2, "one create_runtime_token call per connect");
        let (_, second_call_allowed_ids) = &calls[1];
        assert!(
            second_call_allowed_ids.contains(&"conn-github".to_string()),
            "connecting Slack must not drop GitHub's connection id: {second_call_allowed_ids:?}"
        );
        assert!(
            second_call_allowed_ids.contains(&"conn-slack".to_string()),
            "connecting Slack must include its own connection id: {second_call_allowed_ids:?}"
        );
    }

    #[tokio::test]
    async fn disconnecting_one_of_two_providers_rotates_the_token_to_the_remaining_one() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake.clone()).await;
        let workspace_id = "ws-2";
        ready_workspace(&pool, workspace_id).await;

        // Seed both providers as already `Connected` (as if a real
        // container had made their earlier connects fully succeed) plus
        // an existing runtime token, so disconnect's narrowing path has
        // something real to rotate away from.
        state
            .store
            .upsert_connection(
                "row-github",
                workspace_id,
                "github",
                "ws-ws-2",
                Some("conn-github"),
                ConnectionStatus::Connected,
                Some("ws-ws-2"),
            )
            .await
            .expect("seed github connected");
        state
            .store
            .upsert_connection(
                "row-slack",
                workspace_id,
                "slack",
                "ws-ws-2",
                Some("conn-slack"),
                ConnectionStatus::Connected,
                Some("ws-ws-2"),
            )
            .await
            .expect("seed slack connected");
        state
            .store
            .upsert_runtime_token(workspace_id, "old-token-id", "hash", "encrypted-bearer")
            .await
            .expect("seed existing runtime token");

        let response = disconnect_integration_route(
            State(state.clone()),
            Path((workspace_id.to_string(), "slack".to_string())),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        // A NEW token must have been created scoped to ONLY GitHub's
        // connection id — not simply left unchanged (the old bug), and
        // not torn down entirely (GitHub is still connected).
        let calls = fake.create_runtime_token_calls();
        assert_eq!(
            calls.len(),
            1,
            "disconnecting Slack while GitHub remains must rotate to a new, narrower token"
        );
        let (_, allowed_ids) = &calls[0];
        assert_eq!(allowed_ids, &vec!["conn-github".to_string()]);

        // The old token is revoked only AFTER the new one is delivered
        // (rotation atomicity — see `rotate_workspace_token`'s own doc
        // comment). Delivery always fails in this test process (no real
        // Docker container behind `"not-a-real-container"` — see
        // `ready_workspace`'s doc comment), so the old token is correctly
        // NOT revoked here: the atomicity guarantee itself is what this
        // asserts, not an unrelated skip.
        assert!(
            fake.revoke_runtime_token_calls().is_empty(),
            "must not revoke the old token until the new one is confirmed delivered"
        );
    }

    // ---- Bug 2: a bad workspace id must never reach OpenConnector ----

    #[tokio::test]
    async fn connect_to_unknown_workspace_never_calls_openconnector() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, _pool) = integrations_state(fake.clone()).await;

        let response = connect_integration_route(
            State(state),
            Path(("does-not-exist".to_string(), "github".to_string())),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_found");
        assert!(
            fake.create_runtime_token_calls().is_empty(),
            "an unknown workspace must never reach OpenConnector at all"
        );
    }

    #[tokio::test]
    async fn oauth_start_on_not_ready_workspace_never_calls_openconnector() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake.clone()).await;
        let workspace_id = "ws-creating";
        let store = WorkspaceStore::new(pool.clone());
        store
            .begin_creation("key-creating", workspace_id)
            .await
            .expect("begin_creation");

        let response = start_oauth_route(
            State(state),
            Path((workspace_id.to_string(), "github".to_string())),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_ready");
    }

    #[tokio::test]
    async fn connect_compensates_by_deleting_the_openconnector_connection_on_post_connect_failure()
    {
        // `resolve_ready_workspace` requires `Ready`, so the workspace
        // must be `Ready` to get past `connect_integration_route`'s early
        // check at all. Once past it, `finish_connection_inner` still
        // fails — this crate has no Docker-free fake for
        // `token_delivery`, so delivering into `"not-a-real-container"`
        // always fails a real `docker exec` — a genuine failure AFTER
        // `connect_with_api_key` already created something on
        // OpenConnector's side, exactly the case compensation exists for.
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake.clone()).await;
        let workspace_id = "ws-not-ready-2";
        ready_workspace(&pool, workspace_id).await;

        let response = connect_integration_route(
            State(state),
            Path((workspace_id.to_string(), "github".to_string())),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        assert_ne!(response.status(), StatusCode::OK);
        assert_eq!(
            fake.delete_connection_calls(),
            vec![("github".to_string(), format!("ws-{workspace_id}"))],
            "a post-connect failure must compensate by deleting the OpenConnector connection"
        );
    }

    /// Read back one `integration_audit` row's `outcome` column for
    /// `(workspace_id, event)` — most recent first, since some events
    /// (e.g. `connect_finished`) may be written more than once per test.
    /// No public `IntegrationStore` read exists for this table (write-only,
    /// best-effort audit trail — see `record_audit`'s own doc comment), so
    /// this queries the same underlying pool directly, matching this
    /// module's existing convention of reaching straight into `sqlx` for
    /// test-only assertions (see e.g. the `DROP TABLE` calls above).
    async fn last_audit_outcome(
        pool: &sqlx::SqlitePool,
        workspace_id: &str,
        event: &str,
    ) -> Option<String> {
        sqlx::query_scalar::<_, String>(
            "SELECT outcome FROM integration_audit \
             WHERE workspace_id = ? AND event = ? \
             ORDER BY id DESC LIMIT 1",
        )
        .bind(workspace_id)
        .bind(event)
        .fetch_optional(pool)
        .await
        .expect("query integration_audit")
    }

    // ---- Compensation audit must not lie about its own outcome ----

    #[tokio::test]
    async fn connect_compensation_failure_is_recorded_as_failure_not_success() {
        // Same trigger as
        // `connect_compensates_by_deleting_the_openconnector_connection_on_post_connect_failure`:
        // a `Ready` workspace whose token delivery always fails (no real
        // container behind `"not-a-real-container"`), so
        // `connect_integration_route` reaches its compensation branch.
        // Here `delete_connection` itself ALSO fails, so the audit row
        // must honestly say so rather than hardcoding success.
        let fake = Arc::new(FakeOpenConnector::that_fails_delete_connection());
        let (state, pool) = integrations_state(fake.clone()).await;
        let workspace_id = "ws-compensation-fails";
        ready_workspace(&pool, workspace_id).await;

        let response = connect_integration_route(
            State(state),
            Path((workspace_id.to_string(), "github".to_string())),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        assert_ne!(response.status(), StatusCode::OK);
        assert_eq!(
            fake.delete_connection_calls(),
            vec![("github".to_string(), format!("ws-{workspace_id}"))],
            "compensation must still attempt delete_connection even though it fails"
        );

        let outcome = last_audit_outcome(&pool, workspace_id, "connect_compensated")
            .await
            .expect("connect_compensated audit row was written");
        assert_eq!(
            outcome, "failure",
            "a failed delete_connection must not be logged as a successful compensation"
        );
    }

    // ---- Finding 2: list/disconnect need only existence, not Ready ----

    #[tokio::test]
    async fn list_integrations_succeeds_on_a_workspace_still_creating() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake).await;
        let workspace_id = "ws-list-creating";
        let store = WorkspaceStore::new(pool.clone());
        store
            .begin_creation("key-list-creating", workspace_id)
            .await
            .expect("begin_creation");

        let response = list_integrations_route(State(state), Path(workspace_id.to_string())).await;

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "viewing the integration list must not require a Ready workspace"
        );
    }

    #[tokio::test]
    async fn disconnect_succeeds_on_a_workspace_that_failed_to_launch() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake).await;
        let workspace_id = "ws-disconnect-failed";
        let store = WorkspaceStore::new(pool.clone());
        store
            .begin_creation("key-disconnect-failed", workspace_id)
            .await
            .expect("begin_creation");
        store
            .mark_failed("key-disconnect-failed")
            .await
            .expect("mark_failed");

        let response = disconnect_integration_route(
            State(state),
            Path((workspace_id.to_string(), "github".to_string())),
        )
        .await;

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "disconnecting a provider must not require a Ready workspace"
        );
    }

    #[tokio::test]
    async fn list_integrations_still_404s_on_an_unknown_workspace() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, _pool) = integrations_state(fake).await;

        let response =
            list_integrations_route(State(state), Path("does-not-exist".to_string())).await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_found");
    }

    #[tokio::test]
    async fn disconnect_still_404s_on_an_unknown_workspace() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, _pool) = integrations_state(fake).await;

        let response = disconnect_integration_route(
            State(state),
            Path(("does-not-exist".to_string(), "github".to_string())),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_found");
    }

    // ---- Bug 3: start_oauth_route must not leave a stuck pending row ----

    #[tokio::test]
    async fn oauth_start_failure_leaves_no_pending_row() {
        let fake = Arc::new(FakeOpenConnector::that_fails_create_oauth_authorization());
        let (state, pool) = integrations_state(fake).await;
        let workspace_id = "ws-oauth-fail";
        ready_workspace(&pool, workspace_id).await;

        let response = start_oauth_route(
            State(state.clone()),
            Path((workspace_id.to_string(), "github".to_string())),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let connection = state
            .store
            .find_connection(workspace_id, "github")
            .await
            .expect("find_connection succeeds");
        assert!(
            connection.is_none(),
            "a failed create_oauth_authorization must not leave any row behind, got {connection:?}"
        );
    }

    // ---- Bug 4: Connected must never be written before the token exists ----

    #[tokio::test]
    async fn connection_row_is_not_connected_when_token_delivery_fails() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake).await;
        let workspace_id = "ws-4";
        ready_workspace(&pool, workspace_id).await;

        let summary = openconnector::ConnectionSummary {
            id: "conn-1".to_string(),
            service: "github".to_string(),
            connection_name: "ws-ws-4".to_string(),
            configured: true,
        };
        let result = finish_connection(&state, workspace_id, "github", &summary).await;
        assert!(
            result.is_err(),
            "token delivery must fail (no real container in tests)"
        );

        let connection = state
            .store
            .find_connection(workspace_id, "github")
            .await
            .expect("find_connection succeeds")
            .expect("row was written (mark_error path)");
        assert_ne!(
            connection.status,
            ConnectionStatus::Connected,
            "must never be left Connected when the token was never actually delivered"
        );
    }

    // ---- Bug 5: a DB error on the previous-token lookup must propagate ----

    /// Minimal store double for Bug 5 only: everything else in this
    /// module uses the real `IntegrationStore` against a real temp
    /// SQLite pool, but propagating a genuine `sqlx::Error` from
    /// `find_runtime_token` needs a store that can be told to fail that
    /// one call on demand — dropping the underlying SQLite file/table is
    /// the simplest way to force a REAL `sqlx::Error` without inventing a
    /// second store trait for this one bug.
    #[tokio::test]
    async fn rotate_workspace_token_propagates_a_db_error_from_the_previous_token_lookup() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake.clone()).await;
        let workspace_id = "ws-5";
        ready_workspace(&pool, workspace_id).await;

        // Force a real DB error on the next `find_runtime_token` call by
        // dropping the table it reads from — any query against it now
        // returns `Err`, never silently `Ok(None)`.
        sqlx::query("DROP TABLE workspace_runtime_tokens")
            .execute(&pool)
            .await
            .expect("drop table");

        let result = rotate_workspace_token(
            &state,
            workspace_id,
            "not-a-real-container",
            &["conn-1".to_string()],
        )
        .await;

        let response = result.expect_err("a DB error must propagate, not be swallowed as None");
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            fake.create_runtime_token_calls().is_empty(),
            "must fail BEFORE ever creating a new token — a real previous token must still be \
             revocable, not orphaned by a token this call issued anyway"
        );
    }

    /// Same DB-error propagation, but through `disconnect_integration_route`'s
    /// own lookup (the narrowing path), not `rotate_workspace_token`
    /// directly — the second call site Bug 5 named explicitly.
    #[tokio::test]
    async fn disconnect_narrowing_path_propagates_a_db_error_from_the_previous_token_lookup() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake.clone()).await;
        let workspace_id = "ws-6";
        ready_workspace(&pool, workspace_id).await;

        state
            .store
            .upsert_connection(
                "row-github",
                workspace_id,
                "github",
                "ws-ws-6",
                Some("conn-github"),
                ConnectionStatus::Connected,
                Some("ws-ws-6"),
            )
            .await
            .expect("seed github connected");
        state
            .store
            .upsert_connection(
                "row-slack",
                workspace_id,
                "slack",
                "ws-ws-6",
                Some("conn-slack"),
                ConnectionStatus::Connected,
                Some("ws-ws-6"),
            )
            .await
            .expect("seed slack connected");

        sqlx::query("DROP TABLE workspace_runtime_tokens")
            .execute(&pool)
            .await
            .expect("drop table");

        // Disconnecting Slack (GitHub remains) takes the narrowing path,
        // which calls `rotate_workspace_token` — best-effort there (see
        // its call site's own comment), so the HTTP response itself still
        // succeeds; what matters for Bug 5 is that no new token was
        // created off of a swallowed DB error.
        let response = disconnect_integration_route(
            State(state.clone()),
            Path((workspace_id.to_string(), "slack".to_string())),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            fake.create_runtime_token_calls().is_empty(),
            "a DB error on the previous-token lookup must stop rotation before a new token is \
             ever created"
        );
    }

    #[tokio::test]
    async fn rotate_workspace_token_surfaces_a_create_runtime_token_failure() {
        let fake = Arc::new(FakeOpenConnector::that_fails_create_runtime_token());
        let (state, pool) = integrations_state(fake).await;
        let workspace_id = "ws-7";
        ready_workspace(&pool, workspace_id).await;

        let result = rotate_workspace_token(
            &state,
            workspace_id,
            "not-a-real-container",
            &["conn-1".to_string()],
        )
        .await;

        let response = result.expect_err("must surface the OpenConnector failure");
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    // ---- Self-healing list: discover OpenConnector connections with no local row ----

    /// A `configured` OpenConnector connection for `(service, ws-<workspace_id>)`
    /// — the shape OpenConnector's own `GET /api/connections` reports for a
    /// connection created out-of-band (e.g. via its admin dashboard).
    fn configured_summary(service: &str, workspace_id: &str) -> openconnector::ConnectionSummary {
        openconnector::ConnectionSummary {
            id: format!("conn-{service}-oob"),
            service: service.to_string(),
            connection_name: workspace_connection_name(workspace_id),
            configured: true,
        }
    }

    fn entry_for<'a>(
        body: &'a serde_json::Value,
        provider_id: &str,
    ) -> Option<&'a serde_json::Value> {
        body["data"]
            .as_array()
            .expect("data is an array")
            .iter()
            .find(|entry| entry["provider_id"] == provider_id)
    }

    #[tokio::test]
    async fn list_discovers_a_configured_openconnector_connection_with_no_local_row() {
        let workspace_id = "ws-discover";
        let fake = Arc::new(
            FakeOpenConnector::default()
                .with_connections(vec![configured_summary("github", workspace_id)]),
        );
        let (state, pool) = integrations_state(fake.clone()).await;
        ready_workspace(&pool, workspace_id).await;

        let response =
            list_integrations_route(State(state.clone()), Path(workspace_id.to_string())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;

        let github = entry_for(&body, "github").expect(
            "a provider OpenConnector already holds a configured connection for must be reported",
        );
        // Token delivery always fails in this test process (no real
        // container behind `"not-a-real-container"` — see `ready_workspace`'s
        // doc comment), so the SAME `finish_connection` path the OAuth
        // reconciliation uses lands on its `error` branch here. What this
        // proves: the provider is no longer invisible, and its status
        // comes from `finish_connection`'s real outcome, not a shortcut.
        assert_eq!(github["status"], "error");
        assert!(
            fake.create_runtime_token_calls().iter().any(|(name, ids)| {
                name == &format!("workspace:{workspace_id}")
                    && ids.contains(&"conn-github-oob".to_string())
            }),
            "discovery must run the real finish_connection (token scoped to the discovered \
             connection id), got {:?}",
            fake.create_runtime_token_calls()
        );
        let row = state
            .store
            .find_connection(workspace_id, "github")
            .await
            .expect("find_connection succeeds")
            .expect("discovery must persist a real local row, not just report one");
        assert_eq!(
            row.openconnector_connection_id.as_deref(),
            Some("conn-github-oob")
        );
        assert!(
            entry_for(&body, "slack").is_none(),
            "a provider OpenConnector has nothing for must stay omitted (= available)"
        );
    }

    #[tokio::test]
    async fn list_omits_a_provider_with_no_local_row_and_no_openconnector_match() {
        let workspace_id = "ws-discover-none";
        // Something for a DIFFERENT workspace, and an unconfigured one for
        // this workspace — neither may count as "already connected here".
        let mut unconfigured = configured_summary("slack", workspace_id);
        unconfigured.configured = false;
        let fake = Arc::new(FakeOpenConnector::default().with_connections(vec![
            configured_summary("github", "some-other-workspace"),
            unconfigured,
        ]));
        let (state, pool) = integrations_state(fake.clone()).await;
        ready_workspace(&pool, workspace_id).await;

        let response =
            list_integrations_route(State(state.clone()), Path(workspace_id.to_string())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;

        assert_eq!(body["data"], serde_json::json!([]));
        assert!(fake.create_runtime_token_calls().is_empty());
        assert!(
            state
                .store
                .find_connection(workspace_id, "github")
                .await
                .unwrap()
                .is_none()
                && state
                    .store
                    .find_connection(workspace_id, "slack")
                    .await
                    .unwrap()
                    .is_none(),
            "no local row may be created for a provider OpenConnector has no match for"
        );
    }

    #[tokio::test]
    async fn list_calls_openconnector_list_connections_exactly_once_per_request() {
        let workspace_id = "ws-discover-once";
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake.clone()).await;
        ready_workspace(&pool, workspace_id).await;
        assert_eq!(
            state.providers.len(),
            2,
            "two registered providers, no local rows"
        );

        let response =
            list_integrations_route(State(state.clone()), Path(workspace_id.to_string())).await;
        assert_eq!(response.status(), StatusCode::OK);

        assert_eq!(
            fake.list_connections_calls(),
            1,
            "one OpenConnector-wide fetch per request, never one per provider"
        );
    }

    #[traced_test]
    #[tokio::test]
    async fn list_still_succeeds_and_warns_when_openconnector_list_connections_fails() {
        let workspace_id = "ws-discover-fail";
        let fake = Arc::new(FakeOpenConnector::that_fails_list_connections());
        let (state, pool) = integrations_state(fake.clone()).await;
        ready_workspace(&pool, workspace_id).await;
        // An existing non-pending local row must still be reported as-is.
        state
            .store
            .upsert_connection(
                "row-github",
                workspace_id,
                "github",
                &workspace_connection_name(workspace_id),
                Some("conn-github"),
                ConnectionStatus::Connected,
                Some("ws-ws-discover-fail"),
            )
            .await
            .expect("seed github connected");

        let response = list_integrations_route(State(state), Path(workspace_id.to_string())).await;

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "discovery is best-effort: an OpenConnector failure must not fail the list"
        );
        let body = body_json(response).await;
        assert_eq!(
            entry_for(&body, "github").expect("local row still reported")["status"],
            "connected"
        );
        assert!(entry_for(&body, "slack").is_none());
        assert_eq!(fake.list_connections_calls(), 1);
        assert!(
            logs_contain("openconnector list_connections failed"),
            "the discovery failure must be logged, not silently swallowed"
        );
    }

    // ---- Issue 2: a raw upstream error body must never reach the caller ----

    #[tokio::test]
    async fn connect_failure_response_never_contains_the_raw_openconnector_body() {
        let fake = Arc::new(FakeOpenConnector::that_fails_connect_with_api_key(
            reqwest::StatusCode::UNAUTHORIZED,
            "SECRET-MARKER-XYZ",
        ));
        let (state, pool) = integrations_state(fake).await;
        let workspace_id = "ws-leak-check";
        ready_workspace(&pool, workspace_id).await;

        let response = connect_integration_route(
            State(state),
            Path((workspace_id.to_string(), "github".to_string())),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read response body");
        let body_text = String::from_utf8_lossy(&bytes);
        assert!(
            !body_text.contains("SECRET-MARKER-XYZ"),
            "the raw upstream error body must never reach the caller, got: {body_text}"
        );
    }

    // ---- Issue 3: an audit write failure must be observable, not silent ----

    /// Same "drop the table to force a real `sqlx::Error`" convention as
    /// Bug 5's tests above (`rotate_workspace_token_propagates_a_db_error_from_the_previous_token_lookup`)
    /// — forces `record_audit` itself to fail, and asserts the failure is
    /// actually logged (`tracing::error!`) via `tracing-test`'s log
    /// capture, not silently swallowed the way `let _ = ...` used to.
    #[traced_test]
    #[tokio::test]
    async fn audit_write_failure_is_logged_not_silently_swallowed() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = integrations_state(fake).await;

        sqlx::query("DROP TABLE integration_audit")
            .execute(&pool)
            .await
            .expect("drop table");

        audit(
            &state,
            Some("ws-audit-fail"),
            None,
            "test_event",
            true,
            None,
        )
        .await;

        assert!(
            logs_contain("audit write failed"),
            "a failed audit write must be logged, not silently dropped"
        );
    }
}
