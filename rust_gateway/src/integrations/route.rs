//! HTTP routes for the integrations feature. Envelope responses
//! (`crate::response`), matching every other gateway-authored route.
//! `integration_mcp_route` lives in `mcp_proxy.rs` (imported/re-exported
//! here) since it is a distinct, security-critical concern worth its own
//! file — see that module's doc comment.

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::Response,
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
use super::{IntegrationStore, OpenConnectorClient, Provider};
use crate::response::{error, success};
use crate::workspaces::resolve::resolve_ready_workspace;
use crate::workspaces::WorkspaceStore;

pub use super::mcp_proxy::integration_mcp_route;

/// Shared state for every integrations route. Constructed once at process
/// start (see `bin/rust_gateway.rs`) and cloned as an `Arc`, matching
/// `WorkspacesState`'s existing convention in this crate.
pub struct IntegrationsState {
    pub store: IntegrationStore,
    pub openconnector: OpenConnectorClient,
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
}

impl IntegrationsState {
    fn find_provider(&self, provider_id: &str) -> Option<&Provider> {
        self.providers
            .iter()
            .find(|provider| provider.id == provider_id)
    }
}

#[derive(Serialize)]
struct ProviderSummary<'a> {
    id: &'a str,
    name: &'a str,
    icon: Option<&'a str>,
    description: Option<&'a str>,
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
pub async fn list_integrations_route(
    State(state): State<Arc<IntegrationsState>>,
    Path(workspace_id): Path<String>,
) -> Response {
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

        out.push(
            reconcile_pending_connection(&state, &workspace_id, connection).await,
        );
    }
    success(StatusCode::OK, out)
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
            let provider_id = connection.provider_id.clone();
            return match finish_connection(state, workspace_id, &provider_id, &summary).await {
                Ok(()) => ConnectionSummaryOut {
                    provider_id,
                    status: status_str(&ConnectionStatus::Connected).to_string(),
                    account_label: Some(summary.connection_name),
                    last_error: None,
                },
                // `finish_connection` itself persists the `error` status
                // on failure now (see its own doc comment) — this branch
                // just needs to report the same thing back to this call's
                // caller, not write it a second time.
                Err(_) => ConnectionSummaryOut {
                    provider_id,
                    status: status_str(&ConnectionStatus::Error).to_string(),
                    account_label: None,
                    last_error: Some(
                        "Connected on the provider side but finishing setup failed. Try again."
                            .to_string(),
                    ),
                },
            };
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
            format!("{} does not support OAuth connect — use api_key instead.", provider.name),
        );
    }

    let connection_name = workspace_connection_name(&workspace_id);

    if let Err(err) = state
        .store
        .mark_pending(&Uuid::new_v4().to_string(), &workspace_id, &provider_id, &connection_name)
        .await
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "integrations_store_failed",
            err.to_string(),
        );
    }

    let result = state
        .openconnector
        .create_oauth_authorization(&provider.openconnector_service, &connection_name)
        .await;

    let _ = state
        .store
        .record_audit(
            Some(&workspace_id),
            Some(&provider_id),
            "oauth_start",
            result.is_ok(),
            None,
        )
        .await;

    match result {
        Ok(authorization_url) => success(
            StatusCode::OK,
            OAuthStartResponseData { authorization_url },
        ),
        Err(err) => error(
            StatusCode::BAD_GATEWAY,
            "openconnector_oauth_start_failed",
            err.to_string(),
        ),
    }
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
/// Deliberately relays OpenConnector's response BODY AND STATUS verbatim
/// (via `crate::proxy::forward_to`, the same "relay upstream verbatim"
/// primitive `proxy::forward` itself uses) rather than trying to
/// reinterpret it — `docs/integrations-poc-findings.md` flagged
/// OpenConnector's exact post-callback response shape as unverified; this
/// route does not need to understand it, only pass it through so
/// OpenConnector's own real work (the token exchange) actually happens.
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
    crate::proxy::forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
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
        Err(err) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "openconnector_connect_failed",
                err.to_string(),
            )
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
        Err(response) => response,
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
async fn finish_connection(
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
    let _ = state
        .store
        .record_audit(
            Some(workspace_id),
            Some(provider_id),
            "connect_finished",
            result.is_ok(),
            None,
        )
        .await;
    result
}

async fn finish_connection_inner(
    state: &IntegrationsState,
    workspace_id: &str,
    provider_id: &str,
    connection_summary: &openconnector::ConnectionSummary,
) -> Result<(), Response> {
    let connection_name = workspace_connection_name(workspace_id);

    // Capture the workspace's CURRENT runtime token (if any) BEFORE
    // creating a new one — this is what makes rotation atomic: the old
    // token is only ever revoked AFTER the new one is confirmed stored
    // and delivered (see the end of this function), never the reverse,
    // so a mid-rotation failure never leaves the workspace with NO valid
    // token at all.
    let previous_token = state.store.find_runtime_token(workspace_id).await.ok().flatten();

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

    let token_name = format!("workspace:{workspace_id}");
    let runtime_token = state
        .openconnector
        .create_runtime_token(&token_name, &connection_summary.id)
        .await
        .map_err(|err| {
            error(
                StatusCode::BAD_GATEWAY,
                "openconnector_token_failed",
                err.to_string(),
            )
        })?;

    let token_hash = sha256_hex(&runtime_token.bearer);
    let encrypted_bearer = state.token_cipher.encrypt(&runtime_token.bearer).map_err(|err| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "token_encryption_failed",
            err.to_string(),
        )
    })?;
    state
        .store
        .upsert_runtime_token(
            workspace_id,
            &runtime_token.openconnector_token_id,
            &token_hash,
            &encrypted_bearer,
        )
        .await
        .map_err(|err| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "runtime_token_store_failed",
                err.to_string(),
            )
        })?;

    // Deliver the bearer into the actual container so an agent can use
    // it — see token_delivery.rs. This can only succeed for a workspace
    // whose container is up (`Ready`, with a real `container_name`); a
    // workspace still `Creating` at connect time (an edge case — the
    // frontend would not normally offer Connect before onboarding
    // finishes) is reported as a clean error rather than silently
    // storing a token no container will ever pick up.
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

    // `runtime_token.bearer` itself must never be logged or returned to a
    // caller — it is now ONLY on disk inside the container (as a 0400
    // file) and, encrypted, in `workspace_runtime_tokens.openconnector_bearer`;
    // this local variable goes out of scope at the end of this function.
    token_delivery::deliver_token_file(&container_name, &runtime_token.bearer)
        .await
        .map_err(|err| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "integrations_token_delivery_failed",
                err.to_string(),
            )
        })?;

    // Rotation atomicity: only NOW — after the new token is stored AND
    // successfully delivered into the container — revoke whatever token
    // this workspace held before. A failure at any earlier step returns
    // `Err` above and never reaches this line, so the workspace keeps its
    // OLD, still-valid token rather than being left with none. Skipped
    // entirely when there was no previous token (first connect), or when
    // the "previous" token IS the one just created (this same connect
    // call, re-entered — should not happen in practice, but revoking a
    // token this function itself just issued would be a real bug if it
    // ever did).
    if let Some(previous) = previous_token {
        if previous.openconnector_token_id != runtime_token.openconnector_token_id {
            let _ = state
                .openconnector
                .revoke_runtime_token(&previous.openconnector_token_id)
                .await;
        }
    }

    Ok(())
}

/// `DELETE /workspaces/:id/integrations/:provider`
pub async fn disconnect_integration_route(
    State(state): State<Arc<IntegrationsState>>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
) -> Response {
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
        let _ = state
            .store
            .record_audit(Some(&workspace_id), Some(&provider_id), "disconnect", false, None)
            .await;
        return error(
            StatusCode::BAD_GATEWAY,
            "openconnector_disconnect_failed",
            err.to_string(),
        );
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

    // If this was the workspace's LAST connection, tear down its token
    // entirely — no connections left means nothing this workspace's
    // agents should be able to call. A workspace with other still-
    // connected providers keeps its existing token as-is: narrowing it
    // onto a smaller `allowedConnections` set on partial disconnect is
    // real follow-up work (see the plan's rotation-atomicity phase), not
    // silently skipped without a comment.
    match state.store.list_connections(&workspace_id).await {
        Ok(remaining)
            if remaining
                .iter()
                .all(|c| c.status != ConnectionStatus::Connected) =>
        {
            if let Some(token) = state
                .store
                .find_runtime_token(&workspace_id)
                .await
                .ok()
                .flatten()
            {
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
        }
        _ => {}
    }

    let _ = state
        .store
        .record_audit(
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

    let target_addr = format!("127.0.0.1:{}", ports.wrapper_port);
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

    let target_addr = format!("127.0.0.1:{}", ports.wrapper_port);
    let rewritten_path = "/api/wrapper/v1/integrations/agents".to_string();
    crate::proxy::forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
}

fn workspace_connection_name(workspace_id: &str) -> String {
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
}
