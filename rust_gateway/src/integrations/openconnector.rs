//! Thin client over the OpenConnector admin API — request/response shapes
//! copied directly from `docs/integrations-poc-findings.md`'s "Exact API
//! shapes confirmed" section, verified against a real running container,
//! not written from documentation alone.
//!
//! This client is the ONLY thing in this codebase that holds the
//! OpenConnector admin token — never forwarded to a browser or a
//! workspace container (see `docs/integrations-plan.md`'s security model,
//! layer 2).

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug)]
pub struct OpenConnectorError {
    pub message: String,
}

impl std::fmt::Display for OpenConnectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for OpenConnectorError {}

impl From<reqwest::Error> for OpenConnectorError {
    fn from(err: reqwest::Error) -> Self {
        Self {
            message: format!("openconnector request failed: {err}"),
        }
    }
}

/// Client for OpenConnector's admin-scoped API. `base_url` has no trailing
/// slash (e.g. `http://openconnector:3000`); reachable ONLY over the
/// internal network, per the plan's security model — this struct does
/// nothing to enforce that itself, deployment (no published port) does.
pub struct OpenConnectorClient {
    base_url: String,
    admin_token: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
pub struct ConnectionSummary {
    pub id: String,
    pub service: String,
    #[serde(rename = "connectionName")]
    pub connection_name: String,
    pub configured: bool,
}

#[derive(Debug, Deserialize)]
struct RuntimeTokenCreated {
    token: String,
    record: RuntimeTokenRecord,
}

#[derive(Debug, Deserialize)]
struct RuntimeTokenRecord {
    id: String,
}

pub struct RuntimeToken {
    /// Raw bearer — shown once by OpenConnector, never persisted. Caller
    /// is responsible for writing it into the workspace container's token
    /// file and hashing it for `workspace_runtime_tokens.token_hash`, then
    /// dropping this value.
    pub bearer: String,
    pub openconnector_token_id: String,
}

impl OpenConnectorClient {
    /// `host:port` for `base_url`, for callers that need to hand it to
    /// `crate::proxy::forward_to` (which takes a scheme-less address, not
    /// a full URL) — see `route.rs`'s `oauth_callback_route`. `None` if
    /// `base_url` isn't a valid URL with a host.
    pub fn host_and_port(&self) -> Option<String> {
        let url = reqwest::Url::parse(&self.base_url).ok()?;
        let host = url.host_str()?;
        match url.port_or_known_default() {
            Some(port) => Some(format!("{host}:{port}")),
            None => Some(host.to_string()),
        }
    }

    pub fn new(base_url: String, admin_token: String) -> Self {
        Self {
            base_url,
            admin_token,
            http: reqwest::Client::new(),
        }
    }

    fn admin_request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.base_url, path))
            .bearer_auth(&self.admin_token)
    }

    /// `PUT /api/connections/:service` with `authType: api_key`. Matches
    /// the POC's confirmed shape exactly. OAuth-flow connect
    /// (`POST /api/oauth/authorizations`) is a separate, not-yet-built
    /// method — see `docs/integrations-poc-findings.md`'s "still open"
    /// section.
    pub async fn connect_with_api_key(
        &self,
        service: &str,
        connection_name: &str,
        api_key: &str,
    ) -> Result<ConnectionSummary, OpenConnectorError> {
        let body = serde_json::json!({
            "authType": "api_key",
            "connectionName": connection_name,
            "values": { "apiKey": api_key },
        });
        let response = self
            .admin_request(reqwest::Method::PUT, &format!("/api/connections/{service}"))
            .json(&body)
            .send()
            .await?;
        parse_or_error(response).await
    }

    /// `PUT /api/oauth/configs/:service` — registers this provider's
    /// OAuth client credentials with OpenConnector, so
    /// `create_oauth_authorization` below can succeed for it. Called once
    /// at gateway startup for every provider with credentials present
    /// (see `bin/rust_gateway.rs`), not per-request — OpenConnector
    /// persists this config itself.
    pub async fn upsert_oauth_config(
        &self,
        service: &str,
        client_id: &str,
        client_secret: &str,
    ) -> Result<(), OpenConnectorError> {
        let body = serde_json::json!({ "clientId": client_id, "clientSecret": client_secret });
        let response = self
            .admin_request(reqwest::Method::PUT, &format!("/api/oauth/configs/{service}"))
            .json(&body)
            .send()
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(response_to_error(response).await)
        }
    }

    /// `POST /api/oauth/authorizations` — starts a real OAuth
    /// authorization-code flow for `connection_name`. Confirmed live
    /// against OpenConnector (see `docs/integrations-poc-findings.md`):
    /// requires `upsert_oauth_config` to have been called for `service`
    /// first, or this returns `oauth_client_config_required`.
    pub async fn create_oauth_authorization(
        &self,
        service: &str,
        connection_name: &str,
    ) -> Result<String, OpenConnectorError> {
        #[derive(Deserialize)]
        struct AuthorizationResponse {
            #[serde(rename = "authorizationUrl")]
            authorization_url: String,
        }
        let body = serde_json::json!({ "service": service, "connectionName": connection_name });
        let response = self
            .admin_request(reqwest::Method::POST, "/api/oauth/authorizations")
            .json(&body)
            .send()
            .await?;
        let parsed: AuthorizationResponse = parse_or_error(response).await?;
        Ok(parsed.authorization_url)
    }

    /// `GET /api/connections`, filtered client-side to one
    /// `(service, connection_name)` pair — used by the reconciliation
    /// pass (see `route.rs`'s `list_integrations_route`) to detect that
    /// an OAuth popup finished successfully, since nothing calls this
    /// gateway back directly when that happens (the browser lands on
    /// OpenConnector's own callback response, not ours — see
    /// `integrations-plan.md`'s callback-proxy design). `None` means not
    /// connected yet (or never will be, if the user closed the popup).
    pub async fn find_connection(
        &self,
        service: &str,
        connection_name: &str,
    ) -> Result<Option<ConnectionSummary>, OpenConnectorError> {
        let response = self.admin_request(reqwest::Method::GET, "/api/connections").send().await?;
        let all: Vec<ConnectionSummary> = parse_or_error(response).await?;
        Ok(all
            .into_iter()
            .find(|c| c.service == service && c.connection_name == connection_name))
    }

    pub async fn delete_connection(
        &self,
        service: &str,
        connection_name: &str,
    ) -> Result<(), OpenConnectorError> {
        let response = self
            .admin_request(
                reqwest::Method::DELETE,
                &format!("/api/connections/{service}?connectionName={connection_name}"),
            )
            .send()
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(response_to_error(response).await)
        }
    }

    /// `POST /api/runtime-tokens` restricted to exactly one connection id.
    /// Confirmed by the POC: there is no working partial in-place update
    /// (`PUT /api/runtime-tokens/:id` with a partial body 400s), so
    /// rotation must always be create-new-then-revoke-old, never patch.
    pub async fn create_runtime_token(
        &self,
        name: &str,
        allowed_connection_id: &str,
    ) -> Result<RuntimeToken, OpenConnectorError> {
        let body = serde_json::json!({
            "name": name,
            "allowedConnections": [allowed_connection_id],
        });
        let response = self
            .admin_request(reqwest::Method::POST, "/api/runtime-tokens")
            .json(&body)
            .send()
            .await?;
        let created: RuntimeTokenCreated = parse_or_error(response).await?;
        Ok(RuntimeToken {
            bearer: created.token,
            openconnector_token_id: created.record.id,
        })
    }

    pub async fn revoke_runtime_token(&self, token_id: &str) -> Result<(), OpenConnectorError> {
        let response = self
            .admin_request(
                reqwest::Method::DELETE,
                &format!("/api/runtime-tokens/{token_id}"),
            )
            .send()
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(response_to_error(response).await)
        }
    }

    /// Forward one already-validated MCP JSON-RPC request body to
    /// OpenConnector's `/mcp`, using the WORKSPACE's runtime token (never
    /// the admin token). Caller (`mcp_proxy.rs`) is responsible for every
    /// bit of request sanitization BEFORE calling this — this method does
    /// no validation of its own, matching `forward_to`'s existing
    /// "relay verbatim" convention elsewhere in this crate.
    pub async fn forward_mcp(
        &self,
        workspace_bearer: &str,
        body: &Value,
    ) -> Result<Value, OpenConnectorError> {
        let response = self
            .http
            .post(format!("{}/mcp", self.base_url))
            .bearer_auth(workspace_bearer)
            .header("accept", "application/json, text/event-stream")
            .json(body)
            .send()
            .await?;
        let status = response.status();
        let text = response.text().await?;
        // OpenConnector's /mcp responds with an SSE-framed single event
        // for a plain POST (confirmed in the POC): "event: message\ndata:
        // <json>\n\n". Strip that framing to hand callers plain JSON.
        let json_text = text
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap_or(&text);
        let parsed: Value = serde_json::from_str(json_text).map_err(|err| OpenConnectorError {
            message: format!("openconnector /mcp returned non-JSON body (status {status}): {err}"),
        })?;
        Ok(parsed)
    }
}

async fn parse_or_error<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, OpenConnectorError> {
    if response.status().is_success() {
        response.json::<T>().await.map_err(OpenConnectorError::from)
    } else {
        Err(response_to_error(response).await)
    }
}

async fn response_to_error(response: reqwest::Response) -> OpenConnectorError {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    OpenConnectorError {
        message: format!("openconnector returned {status}: {body}"),
    }
}
