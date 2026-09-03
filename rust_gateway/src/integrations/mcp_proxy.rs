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
use serde_json::{json, Value};
use std::sync::Arc;

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

    let token_record = match state.store.find_runtime_token(&workspace_id).await {
        Ok(Some(record)) => record,
        Ok(None) => {
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

    // Constant-time-in-spirit: comparing hashes rather than raw bearers
    // means a timing side channel would only ever leak information about
    // a SHA-256 digest, not the credential itself. A dedicated
    // constant-time compare is worth adding before this handles real
    // traffic; noted rather than silently assumed sufficient.
    if sha256_hex(&bearer) != token_record.token_hash {
        // The security-relevant audit event in this whole route: a bearer
        // that doesn't match ITS OWN workspace's stored hash is exactly
        // what a cross-tenant attempt (or a stale bearer post-rotation)
        // looks like. Never logs the bearer itself, only that this
        // workspace saw a rejected attempt.
        let _ = state
            .store
            .record_audit(
                Some(&workspace_id),
                None,
                "mcp_proxy_invalid_bearer",
                false,
                None,
            )
            .await;
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_bearer",
            "Bearer token does not match this workspace's current token.",
        );
    }

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
        Err(err) => error(
            StatusCode::BAD_GATEWAY,
            "openconnector_unreachable",
            err.to_string(),
        ),
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
