//! `ANY /workspaces/:id/chat/*path` (and its no-trailing-path sibling,
//! `/workspaces/:id/chat/`) — validates `id` via `resolve.rs` (must exist
//! AND be `ready`), then forwards the request to that specific workspace's
//! wrapper at `http://127.0.0.1:<wrapper_port>/<path>`, stripping only this
//! route's own `/workspaces/:id/chat` prefix.
//!
//! This does NOT go through `wrapper_prefix_proxy::forward_to_wrapper_namespace`
//! (unlike onboarding/agent-seeder/agent-history) because that helper
//! rewrites onto `/api/wrapper/v1/<namespace>/...` — a wrapper-native
//! namespace. Chat is different: it's upstream Hermes' OWN API, reached
//! through the wrapper's catch-all, the same surface `hermes_webui_proxy.rs`
//! already proxies whole. So `/workspaces/:id/chat/api/chat/start` must
//! become `/api/chat/start` on the wrapper port — a bare prefix strip, not
//! a namespace rewrite. Rather than contort the wrapper-namespace helper to
//! express that, this module has its own small forwarding function (mirrors
//! `hermes_webui_proxy.rs`'s local `hermes_webui_proxy` fn).
//!
//! The one thing this namespace adds beyond `hermes_webui_proxy.rs`: an
//! `?agent=<name>` query param is turned into a `Cookie: hermes_profile=<name>`
//! header on the outgoing request. See `docs/hermes-chat-wire-contract.md`
//! §6 for why — Hermes' per-agent chat visibility check is keyed on that
//! cookie, and neither a browser-global cookie nor `EventSource` (no custom
//! headers at all) can supply a different one per agent from a single
//! origin, so this proxy injects it server-side per request instead. See
//! `docs/chat-proxy-plan.md` for the full write-up.

use axum::{
    extract::{Path, Request, State},
    http::{HeaderValue, StatusCode},
    response::Response,
};
use std::sync::Arc;

use super::resolve::resolve_ready_workspace;
use super::route::WorkspacesState;
use crate::proxy::forward_to;
use crate::response::error;

const PROFILE_COOKIE_NAME: &str = "hermes_profile";

/// Handles `/workspaces/:id/chat/*path`.
pub async fn chat_proxy_route_with_path(
    State(state): State<Arc<WorkspacesState>>,
    Path((workspace_id, path)): Path<(String, String)>,
    req: Request,
) -> Response {
    chat_proxy(state, workspace_id, &path, req).await
}

/// Handles `/workspaces/:id/chat/` (exact prefix, no further segments) —
/// see `onboarding_proxy.rs`'s equivalent for why this needs its own
/// route+handler rather than one extractor covering both shapes.
pub async fn chat_proxy_route_root(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
    req: Request,
) -> Response {
    chat_proxy(state, workspace_id, "", req).await
}

/// Only a conservative charset is allowed into the `Cookie` header value —
/// CR, LF, `;`, and whitespace are exactly the characters that would let an
/// `agent` query param forge additional headers/cookies on the outgoing
/// request (see docs/chat-proxy-plan.md's security note). Reject anything
/// outside ASCII alphanumerics, `-`, `_`, `.` rather than trying to escape
/// it — Hermes profile names have no legitimate need for anything else.
/// Minimal `application/x-www-form-urlencoded` value decoder — enough to
/// find the `agent` param and decode `+`/`%XX` escapes without pulling in
/// a new crate dependency (`url`, though present transitively via
/// `reqwest`, is not a direct dependency this crate can name). Malformed
/// `%XX` sequences pass through as literal bytes; `is_valid_agent_name`
/// rejects anything that doesn't fit the allowed charset either way.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Finds `agent=<value>` in a raw query string and decodes it, without a
/// URL-parsing dependency (see `percent_decode`).
fn extract_agent_param(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "agent").then(|| percent_decode(value))
    })
}

fn is_valid_agent_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Merge the injected `hermes_profile` cookie into any pre-existing
/// `Cookie` header on the incoming request, with the injected value taking
/// precedence for that one cookie name. Other cookies survive unchanged.
fn merge_cookie_header(existing: Option<&HeaderValue>, agent: &str) -> String {
    let injected = format!("{PROFILE_COOKIE_NAME}={agent}");
    let Some(existing) = existing.and_then(|v| v.to_str().ok()) else {
        return injected;
    };
    let kept: Vec<&str> = existing
        .split(';')
        .map(str::trim)
        .filter(|pair| !pair.is_empty())
        .filter(|pair| {
            pair.split_once('=')
                .map(|(name, _)| name.trim() != PROFILE_COOKIE_NAME)
                .unwrap_or(true)
        })
        .collect();
    if kept.is_empty() {
        injected
    } else {
        format!("{}; {injected}", kept.join("; "))
    }
}

async fn chat_proxy(
    state: Arc<WorkspacesState>,
    workspace_id: String,
    path: &str,
    mut req: Request,
) -> Response {
    let ports = match resolve_ready_workspace(&state.store, &workspace_id).await {
        Ok(ports) => ports,
        Err(response) => return response,
    };

    // `agent` is read from the query string but deliberately left IN the
    // forwarded query string below (not stripped) — Hermes ignores unknown
    // params, and leaving it keeps the forwarded URL an honest reflection
    // of the original request.
    let agent = req.uri().query().and_then(extract_agent_param);

    if let Some(agent) = &agent {
        if !is_valid_agent_name(agent) {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_agent",
                "agent must match [A-Za-z0-9_.-]+",
            );
        }
        let cookie_value = merge_cookie_header(req.headers().get(axum::http::header::COOKIE), agent);
        let header_value = match HeaderValue::from_str(&cookie_value) {
            Ok(value) => value,
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_agent",
                    "agent must match [A-Za-z0-9_.-]+",
                )
            }
        };
        req.headers_mut()
            .insert(axum::http::header::COOKIE, header_value);
    }

    let target_addr = format!("127.0.0.1:{}", ports.wrapper_port);
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let rewritten_path = format!("/{path}{query}");

    forward_to(&state.http_client, &target_addr, req, Some(&rewritten_path)).await
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{body_json, temp_store};
    use super::*;
    use crate::workspaces::container::FakeLauncher;
    use axum::{
        body::{to_bytes, Body},
        http::{Request as HttpRequest, StatusCode},
        routing::{any as any_method, Router},
    };

    fn state_with_store(store: crate::workspaces::WorkspaceStore) -> Arc<WorkspacesState> {
        super::super::test_support::state_with_store(store, Arc::new(FakeLauncher::default()))
    }

    /// Echoes back the path it received AND the `Cookie` header it received
    /// (as `path|cookie`, empty string if absent) — enough to assert both
    /// the rewrite and the cookie-injection contract against a real network
    /// hop, not a mock.
    async fn spawn_echo_wrapper() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind echo wrapper");
        let port = listener.local_addr().unwrap().port();
        let echo_handler = |req: HttpRequest<Body>| async move {
            let path = req
                .uri()
                .path_and_query()
                .map(|pq| pq.as_str().to_string())
                .unwrap_or_default();
            let cookie = req
                .headers()
                .get(axum::http::header::COOKIE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            format!("{path}|{cookie}")
        };
        let app: Router = Router::new()
            .route("/", any_method(echo_handler))
            .route("/*path", any_method(echo_handler));
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        port
    }

    async fn ready_state_with_echo() -> (Arc<WorkspacesState>, u16) {
        let echo_port = spawn_echo_wrapper().await;
        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "ws-1")
            .await
            .expect("begin_creation");
        store
            .mark_ready("my-workspace", "hermes-ws-ws-1", echo_port, 12345)
            .await
            .expect("mark_ready");
        (state_with_store(store), echo_port)
    }

    #[tokio::test]
    async fn unknown_workspace_id_returns_404() {
        let state = state_with_store(temp_store().await);

        let response = chat_proxy_route_root(
            State(state),
            Path("does-not-exist".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/does-not-exist/chat/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_found");
    }

    #[tokio::test]
    async fn not_ready_workspace_returns_409() {
        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "ws-1")
            .await
            .expect("begin_creation");
        let state = state_with_store(store);

        let response = chat_proxy_route_root(
            State(state),
            Path("ws-1".to_string()),
            HttpRequest::builder()
                .uri("/workspaces/ws-1/chat/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_ready");
    }

    #[tokio::test]
    async fn ready_workspace_rewrites_path_to_hermes_native_api() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed, "/api/chat/start|");
    }

    #[tokio::test]
    async fn agent_query_param_injects_hermes_profile_cookie() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start?agent=pm")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed, "/api/chat/start?agent=pm|hermes_profile=pm");
    }

    #[tokio::test]
    async fn no_agent_param_injects_no_cookie() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed, "/api/chat/start|");
    }

    #[tokio::test]
    async fn header_injection_attempt_via_crlf_is_rejected_with_400() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start?agent=pm%0d%0aX-Evil:%201")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn agent_name_with_semicolon_is_rejected_with_400() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start?agent=pm;evil")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn existing_unrelated_cookie_survives_alongside_injected_one() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/start".to_string())),
            HttpRequest::builder()
                .method("POST")
                .uri("/workspaces/ws-1/chat/api/chat/start?agent=pm")
                .header("Cookie", "session_id=abc123")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(
            echoed,
            "/api/chat/start?agent=pm|session_id=abc123; hermes_profile=pm"
        );
    }

    #[tokio::test]
    async fn query_string_is_preserved_through_the_rewrite() {
        let (state, _port) = ready_state_with_echo().await;

        let response = chat_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "api/chat/stream".to_string())),
            HttpRequest::builder()
                .method("GET")
                .uri("/workspaces/ws-1/chat/api/chat/stream?stream_id=abc&replay=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let echoed = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(echoed, "/api/chat/stream?stream_id=abc&replay=1|");
    }
}
