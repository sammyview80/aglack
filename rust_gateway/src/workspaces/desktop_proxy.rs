//! `ANY /workspaces/:id/desktop/*path` (and its no-trailing-path sibling)
//! — validates `id` via `resolve.rs`, then forwards to that workspace's
//! webtop desktop (nginx on port 3000 inside the container, fronting
//! KasmVNC — see `backend/workspace-image/Dockerfile` and the real nginx
//! config confirmed live inside a running container: `/` proxies to
//! KasmVNC's web client on 6900, `/websockify` proxies the actual VNC
//! stream to 6901 as a WebSocket upgrade).
//!
//! Two distinct forwarding paths, because the desktop is NOT a plain
//! request/response HTTP service end to end:
//!   - a normal HTTP request (the KasmVNC web client's HTML/JS/CSS, and
//!     any of its own plain XHR calls) forwards exactly like
//!     `onboarding_proxy.rs`/`hermes_webui_proxy.rs` do, via `forward_to`.
//!   - a WebSocket UPGRADE request (`/websockify` — the actual pixel/input
//!     stream) cannot go through `forward_to` at all (that function
//!     buffers one request body and returns one response body; a
//!     WebSocket is a long-lived bidirectional byte stream that never
//!     "completes" a single response). This is handled by
//!     `relay_websocket`: accept the browser's upgrade with axum's own
//!     `WebSocketUpgrade`, separately dial a `tokio-tungstenite` WebSocket
//!     CLIENT connection to the container's own `/websockify`, then relay
//!     frames in both directions until either side closes.

use axum::{
    extract::{
        ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade},
        Path, Request, State,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http, Message as TungsteniteMessage};

use super::resolve::resolve_ready_workspace;
use super::route::WorkspacesState;
use crate::proxy::forward_to;

/// Build the outbound WebSocket handshake request to `target_ws_url` with
/// the two headers KasmVNC's own websockify implementation REQUIRES —
/// both found only by reading the container's own log
/// (`docker logs <container>`) after each was rejected in turn, not
/// guessed or assumed from documentation:
///   - `Origin` — a bare `connect_async(url)` (no headers) is rejected
///     with `"missing Sec-WebSocket-Origin header"`.
///   - `Sec-WebSocket-Protocol: binary` — once `Origin` was added, the
///     NEXT rejection was `"missing Sec-WebSocket-Protocol header"`;
///     `binary` matches what a real noVNC/KasmVNC web client requests
///     (confirmed by this container's own `/index.html`, which defaults
///     its `Path` setting to `websockify` and negotiates a binary
///     subprotocol for the RFB byte stream).
fn build_upstream_request(
    target_ws_url: &str,
) -> Result<http::Request<()>, tokio_tungstenite::tungstenite::Error> {
    let mut request = target_ws_url.into_client_request()?;
    // A same-origin request is what a real browser-embedded noVNC client
    // would send when loaded from this same desktop proxy — matching that
    // shape here (rather than an arbitrary/absent origin) is what
    // satisfies KasmVNC's check.
    request.headers_mut().insert(
        http::header::ORIGIN,
        http::HeaderValue::from_str(target_ws_url)
            .unwrap_or_else(|_| http::HeaderValue::from_static("http://127.0.0.1")),
    );
    request.headers_mut().insert(
        http::header::SEC_WEBSOCKET_PROTOCOL,
        http::HeaderValue::from_static("binary"),
    );
    Ok(request)
}

/// Handles `/workspaces/:id/desktop/*path`.
pub async fn desktop_proxy_route_with_path(
    State(state): State<Arc<WorkspacesState>>,
    Path((workspace_id, path)): Path<(String, String)>,
    ws: Option<WebSocketUpgrade>,
    req: Request,
) -> Response {
    desktop_proxy(state, workspace_id, &path, ws, req).await
}

/// Handles `/workspaces/:id/desktop/` (exact prefix, no further segments)
/// — see `onboarding_proxy.rs`'s equivalent for why this needs its own
/// route+handler rather than one extractor covering both shapes.
pub async fn desktop_proxy_route_root(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
    ws: Option<WebSocketUpgrade>,
    req: Request,
) -> Response {
    desktop_proxy(state, workspace_id, "", ws, req).await
}

async fn desktop_proxy(
    state: Arc<WorkspacesState>,
    workspace_id: String,
    path: &str,
    ws: Option<WebSocketUpgrade>,
    req: Request,
) -> Response {
    let ports = match resolve_ready_workspace(&state.store, &workspace_id).await {
        Ok(ports) => ports,
        Err(response) => return response,
    };

    let rewritten_path = format!("/{path}");

    if let Some(ws) = ws {
        let target_ws_url = format!("ws://127.0.0.1:{}{rewritten_path}", ports.desktop_port);
        return ws.on_upgrade(move |socket| relay_websocket(socket, target_ws_url));
    }

    let target_addr = format!("127.0.0.1:{}", ports.desktop_port);
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let full_rewritten_path = format!("{rewritten_path}{query}");

    forward_to(&state.http_client, &target_addr, req, Some(&full_rewritten_path)).await
}

/// Relay frames bidirectionally between the browser's already-upgraded
/// `socket` and a freshly dialed WebSocket client connection to
/// `target_ws_url` (the container's own `/websockify`), until either side
/// closes or errors. Neither direction inspects/modifies frame contents —
/// this is a byte-transparent relay, not a VNC-aware proxy; KasmVNC's
/// protocol framing is entirely opaque to this code, exactly as intended.
///
/// The outbound request carries an explicit `Origin` header — REQUIRED,
/// not optional: verified live via the container's own KasmVNC log
/// (`docker logs <container>`), a bare `connect_async(url)` (no headers)
/// is rejected with `"/websockify request failed websocket checks,
/// missing Sec-WebSocket-Origin header"` and a `404`. `tokio-tungstenite`
/// does not add this header on its own; it must be set explicitly on the
/// outbound handshake request.
async fn relay_websocket(socket: WebSocket, target_ws_url: String) {
    let request = match build_upstream_request(&target_ws_url) {
        Ok(request) => request,
        Err(err) => {
            eprintln!("rust_gateway: failed to build desktop websocket request for {target_ws_url}: {err}");
            return;
        }
    };

    let (upstream, _response) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(err) => {
            eprintln!("rust_gateway: desktop websocket dial to {target_ws_url} failed: {err}");
            return;
        }
    };

    let (mut browser_tx, mut browser_rx) = socket.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let browser_to_upstream = async {
        while let Some(Ok(msg)) = browser_rx.next().await {
            let forwarded = match msg {
                AxumMessage::Text(text) => TungsteniteMessage::Text(text),
                AxumMessage::Binary(bin) => TungsteniteMessage::Binary(bin),
                AxumMessage::Ping(bin) => TungsteniteMessage::Ping(bin),
                AxumMessage::Pong(bin) => TungsteniteMessage::Pong(bin),
                AxumMessage::Close(_) => break,
            };
            if upstream_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };

    let upstream_to_browser = async {
        while let Some(Ok(msg)) = upstream_rx.next().await {
            let forwarded = match msg {
                TungsteniteMessage::Text(text) => AxumMessage::Text(text),
                TungsteniteMessage::Binary(bin) => AxumMessage::Binary(bin),
                TungsteniteMessage::Ping(bin) => AxumMessage::Ping(bin),
                TungsteniteMessage::Pong(bin) => AxumMessage::Pong(bin),
                TungsteniteMessage::Close(_) => break,
                // Raw frames are handled internally by tungstenite's own
                // read loop and never surface here in practice.
                TungsteniteMessage::Frame(_) => continue,
            };
            if browser_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = browser_tx.close().await;
    };

    tokio::join!(browser_to_upstream, upstream_to_browser);
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_support::{body_json, temp_store};
    use crate::workspaces::container::FakeLauncher;
    use axum::{
        body::{to_bytes, Body},
        http::{Request as HttpRequest, StatusCode},
        routing::{any as any_method, get, Router},
    };

    fn state_with_store(store: crate::workspaces::WorkspaceStore) -> Arc<WorkspacesState> {
        super::super::test_support::state_with_store(store, Arc::new(FakeLauncher::default()))
    }

    #[tokio::test]
    async fn unknown_workspace_id_returns_404() {
        let state = state_with_store(temp_store().await);

        let response = desktop_proxy_route_root(
            State(state),
            Path("does-not-exist".to_string()),
            None,
            HttpRequest::builder()
                .uri("/workspaces/does-not-exist/desktop/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_found");
    }

    /// Plain (non-WebSocket) HTTP requests — the KasmVNC web client's own
    /// HTML/JS/CSS — must forward exactly like the other two proxy
    /// routes, via a real network hop.
    #[tokio::test]
    async fn plain_http_request_forwards_to_recorded_desktop_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind echo desktop");
        let desktop_port = listener.local_addr().unwrap().port();
        let echo_handler = |req: HttpRequest<Body>| async move {
            req.uri().path().to_string()
        };
        let app: Router = Router::new()
            .route("/", any_method(echo_handler))
            .route("/*path", any_method(echo_handler));
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });

        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "ws-1")
            .await
            .expect("begin_creation");
        store
            .mark_ready("my-workspace", "hermes-ws-ws-1", 12345, desktop_port)
            .await
            .expect("mark_ready");
        let state = state_with_store(store);

        let response = desktop_proxy_route_with_path(
            State(state),
            Path(("ws-1".to_string(), "index.html".to_string())),
            None,
            HttpRequest::builder()
                .uri("/workspaces/ws-1/desktop/index.html")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(String::from_utf8(bytes.to_vec()).unwrap(), "/index.html");
    }

    /// The real thing this whole module exists for: a genuine WebSocket
    /// upgrade, relayed end to end through `desktop_proxy` to a real
    /// "upstream" WebSocket echo server, over REAL sockets (not an
    /// in-process fake) — proves frames actually survive the relay in
    /// both directions.
    #[tokio::test]
    async fn websocket_upgrade_is_relayed_bidirectionally_to_the_recorded_desktop_port() {
        // The fake "container desktop": a real WebSocket echo server.
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind upstream ws echo");
        let desktop_port = upstream_listener.local_addr().unwrap().port();
        let upstream_app: Router = Router::new().route(
            "/websockify",
            get(|ws: WebSocketUpgrade| async move {
                // Real KasmVNC requires (and itself sends back) a
                // negotiated `Sec-WebSocket-Protocol` — `.protocols(...)`
                // is this fixture's equivalent of that, so the outbound
                // request `build_upstream_request` builds (which now sets
                // `Sec-WebSocket-Protocol: binary`, per the real fix)
                // gets a compliant response instead of tungstenite's own
                // strict client rejecting a server that names none.
                ws.protocols(["binary"]).on_upgrade(|mut socket: WebSocket| async move {
                    while let Some(Ok(msg)) = socket.next().await {
                        if let AxumMessage::Close(_) = msg {
                            break;
                        }
                        if socket.send(msg).await.is_err() {
                            break;
                        }
                    }
                })
            }),
        );
        tokio::spawn(async move {
            axum::serve(upstream_listener, upstream_app).await.ok();
        });

        // The real workspace record this whole route resolves against.
        let store = temp_store().await;
        store
            .begin_creation("my-workspace", "ws-1")
            .await
            .expect("begin_creation");
        store
            .mark_ready("my-workspace", "hermes-ws-ws-1", 12345, desktop_port)
            .await
            .expect("mark_ready");
        let state = state_with_store(store);

        // The gateway's OWN desktop_proxy route, bound to a real port —
        // this is the code under test, reached exactly as a browser would.
        let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind gateway under test");
        let gateway_port = gateway_listener.local_addr().unwrap().port();
        let gateway_app: Router = Router::new()
            .route(
                "/workspaces/:id/desktop/*path",
                any_method(desktop_proxy_route_with_path),
            )
            .with_state(state);
        tokio::spawn(async move {
            axum::serve(gateway_listener, gateway_app).await.ok();
        });

        // The "browser": a real tokio-tungstenite WebSocket client
        // connecting to the GATEWAY's desktop route, not the upstream
        // directly — proving the whole relay chain works.
        let gateway_ws_url =
            format!("ws://127.0.0.1:{gateway_port}/workspaces/ws-1/desktop/websockify");
        let (mut browser_socket, _response) = tokio_tungstenite::connect_async(&gateway_ws_url)
            .await
            .expect("browser connects through the gateway's desktop proxy");

        browser_socket
            .send(TungsteniteMessage::Text("hello desktop".to_string()))
            .await
            .expect("send through the relay");

        let echoed = tokio::time::timeout(std::time::Duration::from_secs(5), browser_socket.next())
            .await
            .expect("did not time out waiting for the echo")
            .expect("stream did not close")
            .expect("no transport error");

        assert_eq!(
            echoed,
            TungsteniteMessage::Text("hello desktop".to_string()),
            "a frame sent by the browser must be relayed to the real upstream desktop and its \
             echoed reply relayed all the way back, proving both directions of the relay work"
        );
    }
}
