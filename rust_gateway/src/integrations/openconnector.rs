//! Thin client over the OpenConnector admin API — request/response shapes
//! copied directly from `docs/integrations-poc-findings.md`'s "Exact API
//! shapes confirmed" section, verified against a real running container,
//! not written from documentation alone.
//!
//! This client is the ONLY thing in this codebase that holds the
//! OpenConnector admin token — never forwarded to a browser or a
//! workspace container (see `docs/integrations-plan.md`'s security model,
//! layer 2).

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

/// An OpenConnector call failed. `message` may contain OpenConnector's own
/// raw response body — see `response_to_error` — so it is safe to log
/// (`tracing::warn!`/`error!`) but MUST NEVER be sent verbatim in an HTTP
/// response to a browser or workspace container: `safe_message` is the
/// fixed, non-leaking text to return instead (see that method's own doc
/// comment and Issue 2 in the task this was fixed under).
#[derive(Debug)]
pub struct OpenConnectorError {
    pub message: String,
    /// The upstream HTTP status, when this error came from an actual
    /// OpenConnector HTTP response (as opposed to e.g. a connect
    /// failure/timeout, where there is no status at all). Lets
    /// `safe_message` distinguish "OpenConnector rejected this request"
    /// (4xx — likely bad credentials/input) from "OpenConnector itself is
    /// unreachable or broken" (5xx, or no status) without parsing prose
    /// back out of `message`.
    pub status: Option<reqwest::StatusCode>,
}

impl std::fmt::Display for OpenConnectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for OpenConnectorError {}

impl OpenConnectorError {
    /// Fixed, non-leaking text safe to return to a browser or workspace
    /// container — see this struct's own doc comment for why `message`
    /// itself is not: it embeds OpenConnector's raw response body
    /// verbatim, which can contain echoed request fields or other
    /// internal detail that must never reach an untrusted caller (Issue 2).
    /// Callers must still log the real `message`/`self` via `tracing`
    /// before discarding it into this fixed string.
    pub fn safe_message(&self) -> &'static str {
        match self.status {
            Some(status) if status.is_client_error() => {
                "The provider rejected the request. Check your credentials and try again."
            }
            Some(_) => "The provider is currently unavailable. Try again shortly.",
            None => "Could not reach the provider. Try again shortly.",
        }
    }

    /// Fixed error `code` string (for the JSON error envelope's `code`
    /// field) matching `safe_message`'s three cases — kept alongside it
    /// so a caller can't return one without the other by accident.
    pub fn safe_code(&self) -> &'static str {
        match self.status {
            Some(status) if status.is_client_error() => "provider_rejected",
            Some(_) => "provider_unavailable",
            None => "provider_unreachable",
        }
    }
}

impl From<reqwest::Error> for OpenConnectorError {
    fn from(err: reqwest::Error) -> Self {
        // Distinguish "OpenConnector took too long to answer" from other
        // connection failures (refused, DNS, TLS, ...) in the message
        // itself — `json_client()` (see `shared::http`) now gives every
        // OpenConnector call a real timeout (Issue 1), so this case is
        // now reachable in practice, not just a theoretical `reqwest`
        // error kind. `.is_timeout()` catches both connect-timeout and
        // overall-timeout; this crate doesn't yet need to tell those two
        // apart in a raw string, only "timed out" vs "did not".
        let message = if err.is_timeout() {
            format!("openconnector request timed out: {err}")
        } else {
            format!("openconnector request failed: {err}")
        };
        Self { message, status: None }
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

/// Every OpenConnector admin call `route.rs` needs, behind a trait —
/// mirrors `workspaces::container::ContainerLauncher` (see that module's
/// doc comment for the reasoning): `route.rs`'s handlers depend on this
/// trait, never the concrete `OpenConnectorClient` directly, so tests can
/// swap in `FakeOpenConnector` (below, `#[cfg(test)]`) without a real
/// OpenConnector container. `OpenConnectorClient` is the real, production
/// implementation; nothing about its own public API changes.
#[async_trait]
pub trait OpenConnectorApi: Send + Sync {
    fn host_and_port(&self) -> Option<String>;

    async fn connect_with_api_key(
        &self,
        service: &str,
        connection_name: &str,
        api_key: &str,
    ) -> Result<ConnectionSummary, OpenConnectorError>;

    async fn create_oauth_authorization(
        &self,
        service: &str,
        connection_name: &str,
    ) -> Result<String, OpenConnectorError>;

    async fn find_connection(
        &self,
        service: &str,
        connection_name: &str,
    ) -> Result<Option<ConnectionSummary>, OpenConnectorError>;

    async fn delete_connection(
        &self,
        service: &str,
        connection_name: &str,
    ) -> Result<(), OpenConnectorError>;

    /// See `OpenConnectorClient::create_runtime_token` for why this takes
    /// the FULL set of connection ids to allow, never just one (bug fix:
    /// a second `connect` used to narrow an existing token down to only
    /// its own connection id, silently revoking every other provider's
    /// access — see `route.rs`'s `finish_connection_inner`/
    /// `rotate_workspace_token`).
    async fn create_runtime_token(
        &self,
        name: &str,
        allowed_connection_ids: &[String],
    ) -> Result<RuntimeToken, OpenConnectorError>;

    async fn revoke_runtime_token(&self, token_id: &str) -> Result<(), OpenConnectorError>;

    async fn forward_mcp(
        &self,
        workspace_bearer: &str,
        body: &Value,
    ) -> Result<Value, OpenConnectorError>;
}

impl OpenConnectorClient {
    pub fn new(base_url: String, admin_token: String) -> Self {
        Self {
            base_url,
            admin_token,
            http: crate::shared::http::json_client(),
        }
    }

    fn admin_request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.base_url, path))
            .bearer_auth(&self.admin_token)
    }

    /// `PUT /api/oauth/configs/:service` — registers this provider's
    /// OAuth client credentials with OpenConnector, so
    /// `create_oauth_authorization` can succeed for it. Called once at
    /// gateway startup for every provider with credentials present (see
    /// `bin/rust_gateway.rs`), not per-request — OpenConnector persists
    /// this config itself. Not on `OpenConnectorApi`: only ever called
    /// from real startup wiring, never from a route/test.
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
}

#[async_trait]
impl OpenConnectorApi for OpenConnectorClient {
    /// `host:port` for `base_url`, for callers that need to hand it to
    /// `crate::proxy::forward_to` (which takes a scheme-less address, not
    /// a full URL) — see `route.rs`'s `oauth_callback_route`. `None` if
    /// `base_url` isn't a valid URL with a host.
    fn host_and_port(&self) -> Option<String> {
        let url = reqwest::Url::parse(&self.base_url).ok()?;
        let host = url.host_str()?;
        match url.port_or_known_default() {
            Some(port) => Some(format!("{host}:{port}")),
            None => Some(host.to_string()),
        }
    }

    /// `PUT /api/connections/:service` with `authType: api_key`. Matches
    /// the POC's confirmed shape exactly. OAuth-flow connect
    /// (`POST /api/oauth/authorizations`) is a separate method — see
    /// `docs/integrations-poc-findings.md`'s "still open" section.
    async fn connect_with_api_key(
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

    /// `POST /api/oauth/authorizations` — starts a real OAuth
    /// authorization-code flow for `connection_name`. Confirmed live
    /// against OpenConnector (see `docs/integrations-poc-findings.md`):
    /// requires `upsert_oauth_config` to have been called for `service`
    /// first, or this returns `oauth_client_config_required`.
    async fn create_oauth_authorization(
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
    async fn find_connection(
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

    async fn delete_connection(
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

    /// `POST /api/runtime-tokens`. Takes the FULL set of connection ids
    /// this token should allow (never just one — see `OpenConnectorApi`'s
    /// own doc comment on this method for why: `route.rs`'s
    /// `finish_connection_inner`/`rotate_workspace_token` compute that
    /// full set before calling this). Confirmed by the POC: there is no
    /// working partial in-place update (`PUT /api/runtime-tokens/:id`
    /// with a partial body 400s), so rotation must always be
    /// create-new-then-revoke-old, never patch.
    async fn create_runtime_token(
        &self,
        name: &str,
        allowed_connection_ids: &[String],
    ) -> Result<RuntimeToken, OpenConnectorError> {
        let body = serde_json::json!({
            "name": name,
            "allowedConnections": allowed_connection_ids,
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

    async fn revoke_runtime_token(&self, token_id: &str) -> Result<(), OpenConnectorError> {
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
    async fn forward_mcp(
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
        // Issue 4: check status BEFORE treating the body as SSE/JSON data.
        // A 401/500 from OpenConnector still has a body — parsing it as if
        // it were a normal MCP response would hand the caller (a
        // workspace container) an error's JSON as if it were real data,
        // as HTTP 200. Routed through `response_to_error` so this gets
        // the same status-aware, non-leaking treatment as every other
        // OpenConnector failure (Issue 2).
        if !response.status().is_success() {
            return Err(response_to_error(response).await);
        }
        let text = response.text().await?;
        let json_text = extract_sse_data(&text).unwrap_or_else(|| text.clone());
        let parsed: Value = serde_json::from_str(&json_text).map_err(|err| OpenConnectorError {
            message: format!("openconnector /mcp returned non-JSON body: {err}"),
            status: None,
        })?;
        Ok(parsed)
    }
}

/// Reconstruct the `data` field of the first SSE event in `text`, per the
/// SSE spec (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation):
/// an event is terminated by a blank line, and multiple `data:` lines
/// within one event are joined with `\n` to form the field's actual
/// value (not simply the first `data:` line found, which truncates any
/// event whose payload was split across more than one `data:` line).
///
/// `None` if `text` contains no `data:` line at all (not SSE-framed).
///
/// LIMITATION (documented, not silently pretended away): this returns
/// only the FIRST event's reconstructed data. OpenConnector's plain-POST
/// `/mcp` response is confirmed (see the POC findings) to be exactly one
/// event for one request, so this is correct for every case this crate
/// actually sends today. If OpenConnector ever answers a single POST with
/// multiple SSE events, matching the right one by the request's own
/// JSON-RPC `id` would be needed — not done here, since `forward_mcp`'s
/// `body` is a `serde_json::Value` `id` field is caller-supplied and
/// nothing here has threaded it through yet; flagged as a real gap rather
/// than a fully spec-compliant multi-event demultiplexer.
fn extract_sse_data(text: &str) -> Option<String> {
    let mut current_event_data: Vec<&str> = Vec::new();
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:")) {
            current_event_data.push(data.trim_start_matches(' '));
            continue;
        }
        if line.is_empty() && !current_event_data.is_empty() {
            // Blank line: this event is complete.
            return Some(current_event_data.join("\n"));
        }
        // Any other line (`event:`, `id:`, `retry:`, a comment starting
        // with `:`) belongs to SSE framing this crate doesn't need to
        // interpret — ignored, matching the original "strip framing"
        // intent, just without truncating a multi-line `data:` field.
    }
    if current_event_data.is_empty() {
        None
    } else {
        // No trailing blank line before EOF — still a complete event in
        // practice (OpenConnector's real responses end this way).
        Some(current_event_data.join("\n"))
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
        status: Some(status),
    }
}

/// Docker/OpenConnector-free test double for `OpenConnectorApi` — mirrors
/// `workspaces::container::FakeLauncher`'s style exactly (see that
/// module's doc comment): deterministic fake responses, call counters,
/// and a `fail_next_*` knob so a test can force one specific call to fail
/// without a real OpenConnector container. `#[cfg(test)]` on every item
/// here, not just this doc comment, for the same reason `FakeLauncher`
/// does it — nothing outside `cargo test` ever constructs one.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct FakeOpenConnector {
        state: Mutex<FakeState>,
    }

    #[derive(Default)]
    struct FakeState {
        next_connection_id: u32,
        /// Every `(name, allowed_connection_ids)` pair passed to
        /// `create_runtime_token`, in call order — the whole point of
        /// this fake: Bug 1's test asserts on this directly rather than
        /// inferring it indirectly.
        create_runtime_token_calls: Vec<(String, Vec<String>)>,
        revoke_runtime_token_calls: Vec<String>,
        delete_connection_calls: Vec<(String, String)>,
        fail_create_oauth_authorization: bool,
        fail_create_runtime_token: bool,
        fail_delete_connection: bool,
        /// Forces `connect_with_api_key` to fail with this exact
        /// `(status, raw upstream body)` pair — lets a test drive a real
        /// route through a specific upstream failure body (e.g. one
        /// containing a distinctive marker string) and assert on how that
        /// body is or isn't exposed further up the stack (Issue 2).
        fail_connect_with_api_key: Option<(reqwest::StatusCode, String)>,
        next_token_id: u32,
    }

    impl FakeOpenConnector {
        pub(crate) fn that_fails_create_oauth_authorization() -> Self {
            let fake = Self::default();
            fake.state.lock().unwrap().fail_create_oauth_authorization = true;
            fake
        }

        pub(crate) fn that_fails_create_runtime_token() -> Self {
            let fake = Self::default();
            fake.state.lock().unwrap().fail_create_runtime_token = true;
            fake
        }

        /// Forces `delete_connection` (the compensation-path call) to
        /// fail, for asserting that a failed compensation is recorded
        /// honestly rather than always logged as `success = true`.
        pub(crate) fn that_fails_delete_connection() -> Self {
            let fake = Self::default();
            fake.state.lock().unwrap().fail_delete_connection = true;
            fake
        }

        /// Forces `connect_with_api_key` to fail as if OpenConnector
        /// itself returned `status` with `body` as its raw response text
        /// — see `fail_connect_with_api_key`'s own doc comment.
        pub(crate) fn that_fails_connect_with_api_key(
            status: reqwest::StatusCode,
            body: impl Into<String>,
        ) -> Self {
            let fake = Self::default();
            fake.state.lock().unwrap().fail_connect_with_api_key = Some((status, body.into()));
            fake
        }

        pub(crate) fn create_runtime_token_calls(&self) -> Vec<(String, Vec<String>)> {
            self.state.lock().unwrap().create_runtime_token_calls.clone()
        }

        pub(crate) fn revoke_runtime_token_calls(&self) -> Vec<String> {
            self.state.lock().unwrap().revoke_runtime_token_calls.clone()
        }

        pub(crate) fn delete_connection_calls(&self) -> Vec<(String, String)> {
            self.state.lock().unwrap().delete_connection_calls.clone()
        }
    }

    #[async_trait]
    impl OpenConnectorApi for FakeOpenConnector {
        fn host_and_port(&self) -> Option<String> {
            Some("127.0.0.1:1".to_string())
        }

        async fn connect_with_api_key(
            &self,
            service: &str,
            connection_name: &str,
            _api_key: &str,
        ) -> Result<ConnectionSummary, OpenConnectorError> {
            let mut state = self.state.lock().unwrap();
            if let Some((status, body)) = state.fail_connect_with_api_key.clone() {
                return Err(OpenConnectorError {
                    message: format!("openconnector returned {status}: {body}"),
                    status: Some(status),
                });
            }
            state.next_connection_id += 1;
            let id = format!("conn-{}", state.next_connection_id);
            Ok(ConnectionSummary {
                id,
                service: service.to_string(),
                connection_name: connection_name.to_string(),
                configured: true,
            })
        }

        async fn create_oauth_authorization(
            &self,
            _service: &str,
            _connection_name: &str,
        ) -> Result<String, OpenConnectorError> {
            if self.state.lock().unwrap().fail_create_oauth_authorization {
                return Err(OpenConnectorError {
                    message: "simulated create_oauth_authorization failure".to_string(),
                    status: None,
                });
            }
            Ok("https://example.invalid/oauth/authorize".to_string())
        }

        async fn find_connection(
            &self,
            _service: &str,
            _connection_name: &str,
        ) -> Result<Option<ConnectionSummary>, OpenConnectorError> {
            Ok(None)
        }

        async fn delete_connection(
            &self,
            service: &str,
            connection_name: &str,
        ) -> Result<(), OpenConnectorError> {
            let mut state = self.state.lock().unwrap();
            state
                .delete_connection_calls
                .push((service.to_string(), connection_name.to_string()));
            if state.fail_delete_connection {
                return Err(OpenConnectorError {
                    message: "simulated delete_connection failure".to_string(),
                    status: None,
                });
            }
            Ok(())
        }

        async fn create_runtime_token(
            &self,
            name: &str,
            allowed_connection_ids: &[String],
        ) -> Result<RuntimeToken, OpenConnectorError> {
            let mut state = self.state.lock().unwrap();
            state
                .create_runtime_token_calls
                .push((name.to_string(), allowed_connection_ids.to_vec()));
            if state.fail_create_runtime_token {
                return Err(OpenConnectorError {
                    message: "simulated create_runtime_token failure".to_string(),
                    status: None,
                });
            }
            state.next_token_id += 1;
            let id = format!("token-{}", state.next_token_id);
            Ok(RuntimeToken {
                bearer: format!("bearer-{id}"),
                openconnector_token_id: id,
            })
        }

        async fn revoke_runtime_token(&self, token_id: &str) -> Result<(), OpenConnectorError> {
            self.state
                .lock()
                .unwrap()
                .revoke_runtime_token_calls
                .push(token_id.to_string());
            Ok(())
        }

        async fn forward_mcp(
            &self,
            _workspace_bearer: &str,
            _body: &Value,
        ) -> Result<Value, OpenConnectorError> {
            Ok(Value::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ---- Issue 4: SSE parsing must join multi-line `data:` fields ----

    #[test]
    fn extract_sse_data_joins_a_data_field_split_across_two_lines() {
        // Per the SSE spec, each `data:` line contributes one line to the
        // field's value, joined with `\n` — this body's real JSON value
        // (`{"a":\n1}`, which is valid JSON) is split across two `data:`
        // lines exactly as a spec-compliant multi-line event would be.
        let text = "event: message\ndata: {\"a\":\ndata: 1}\n\n";
        let extracted = extract_sse_data(text).expect("event has data lines");
        let parsed: Value = serde_json::from_str(&extracted).expect("reconstructed JSON parses");
        assert_eq!(parsed, serde_json::json!({"a": 1}));
    }

    #[test]
    fn extract_sse_data_handles_a_single_line_event_unchanged() {
        let text = "event: message\ndata: {\"ok\":true}\n\n";
        let extracted = extract_sse_data(text).expect("event has data");
        assert_eq!(extracted, "{\"ok\":true}");
    }

    #[test]
    fn extract_sse_data_returns_none_for_non_sse_text() {
        assert!(extract_sse_data("{\"ok\":true}").is_none());
    }

    // ---- Issue 4: a non-2xx /mcp response must error, not be parsed as data ----

    #[tokio::test]
    async fn forward_mcp_returns_err_on_a_500_response_instead_of_treating_the_body_as_data() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/mcp"))
            .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
                "error": "internal server error"
            })))
            .mount(&server)
            .await;

        let client = OpenConnectorClient::new(server.uri(), "admin-token".to_string());
        let result = client
            .forward_mcp("workspace-bearer", &serde_json::json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
            .await;

        assert!(
            result.is_err(),
            "a 500 response must never be returned as Ok(data) to the caller"
        );
    }

    #[tokio::test]
    async fn forward_mcp_parses_a_multi_line_sse_event_from_a_real_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/mcp"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw("event: message\ndata: {\"a\":\ndata: 1}\n\n", "text/event-stream"),
            )
            .mount(&server)
            .await;

        let client = OpenConnectorClient::new(server.uri(), "admin-token".to_string());
        let result = client
            .forward_mcp("workspace-bearer", &serde_json::json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
            .await
            .expect("a successful 200 SSE response must parse");

        assert_eq!(result, serde_json::json!({"a": 1}));
    }

    // ---- Issue 2: safe_message/safe_code never leak the raw upstream body ----

    #[test]
    fn safe_message_for_a_4xx_status_does_not_contain_the_raw_upstream_body() {
        let err = OpenConnectorError {
            message: "openconnector returned 401 Unauthorized: SECRET-MARKER-XYZ".to_string(),
            status: Some(reqwest::StatusCode::UNAUTHORIZED),
        };
        assert!(!err.safe_message().contains("SECRET-MARKER-XYZ"));
        assert_eq!(err.safe_code(), "provider_rejected");
    }

    #[test]
    fn safe_message_for_a_5xx_status_is_the_unavailable_variant() {
        let err = OpenConnectorError {
            message: "openconnector returned 500 Internal Server Error: SECRET-MARKER-XYZ"
                .to_string(),
            status: Some(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
        };
        assert!(!err.safe_message().contains("SECRET-MARKER-XYZ"));
        assert_eq!(err.safe_code(), "provider_unavailable");
    }

    #[test]
    fn safe_message_with_no_status_is_the_unreachable_variant() {
        let err = OpenConnectorError {
            message: "openconnector request timed out: SECRET-MARKER-XYZ".to_string(),
            status: None,
        };
        assert!(!err.safe_message().contains("SECRET-MARKER-XYZ"));
        assert_eq!(err.safe_code(), "provider_unreachable");
    }
}
