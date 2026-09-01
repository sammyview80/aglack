//! The actual request-forwarding logic: take one incoming request, send it
//! to a backend address, relay the response back unchanged.
//!
//! `forward` (fixed one-backend-for-everything) and `onboarding.rs`'s
//! per-workspace forwarding both funnel through `forward_to` — the byte-
//! level "send this request to this address, relay the response verbatim"
//! logic lives in exactly one place, not duplicated between "no tenant
//! resolution" and "resolved via the workspace registry" callers.

use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
};
use std::sync::Arc;

use super::ProxyState;

/// Forward `req` to `state`'s configured backend address and return its
/// response verbatim (status + body). A backend that cannot be reached, or
/// a request whose body cannot be read, produces a clear error response
/// rather than a panic or a silently wrong status code.
///
/// Today there is exactly one backend address for every request through
/// this route — no per-tenant resolution. See `onboarding.rs` for the
/// route that DOES resolve a target per-request (by workspace_id, via the
/// workspaces store) and also calls `forward_to`.
pub async fn forward(State(state): State<Arc<ProxyState>>, req: Request) -> Response {
    forward_to(&state.http_client, &state.backend_addr, req, None).await
}

/// Forward `req` to `target_addr` (`host:port`, no scheme) and return the
/// response verbatim. `rewrite_path` optionally replaces the outgoing
/// request's path+query entirely (used by `onboarding.rs` to strip its own
/// `/workspaces/:id/onboarding` prefix before forwarding to the workspace's
/// wrapper) — `None` forwards the incoming request's own path+query
/// unchanged, matching `forward`'s existing behavior.
pub async fn forward_to(
    http_client: &reqwest::Client,
    target_addr: &str,
    req: Request,
    rewrite_path: Option<&str>,
) -> Response {
    let path_and_query = match rewrite_path {
        Some(rewritten) => rewritten.to_string(),
        None => req
            .uri()
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/")
            .to_string(),
    };

    let target_uri = format!("http://{target_addr}{path_and_query}");
    let target_uri: Uri = match target_uri.parse() {
        Ok(uri) => uri,
        Err(_) => {
            return (StatusCode::BAD_GATEWAY, "invalid upstream target").into_response();
        }
    };

    let method = req.method().clone();
    // Forward the incoming request's own headers (notably Content-Type —
    // without it, a JSON POST body arrives at the backend with no way to
    // tell it's JSON; confirmed live: FastAPI/pydantic backends reject an
    // onboarding POST outright without this, where upstream's more lenient
    // stdlib JSON parsing happened to mask the same gap). `Host` and
    // `Content-Length` are skipped: `Host` must name the ACTUAL target
    // (reqwest sets this itself from `target_uri`), and `Content-Length`
    // is recomputed by reqwest from the real outgoing body — forwarding
    // the original request's stale values for either would produce a
    // request that doesn't match its own frame.
    let mut forwarded_headers = axum::http::HeaderMap::new();
    for (name, value) in req.headers() {
        if name == axum::http::header::HOST || name == axum::http::header::CONTENT_LENGTH {
            continue;
        }
        forwarded_headers.insert(name.clone(), value.clone());
    }

    let body_bytes: Bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "failed to read request body").into_response();
        }
    };

    let upstream_result = http_client
        .request(method, target_uri.to_string())
        .headers(forwarded_headers)
        .body(body_bytes)
        .send()
        .await;

    match upstream_result {
        Ok(upstream_response) => {
            let status = upstream_response.status();
            // Real bug found live (see CHECKPOINT.md): every upstream
            // response header used to be dropped here — only `status` and
            // `body` were ever copied onto the outgoing response. A
            // browser refuses to apply a stylesheet served with no
            // `Content-Type` (the exact symptom reported), and every
            // other header (caching, CSP, ETag, ...) was silently lost
            // the same way for every route that shares this function
            // (hermes-webui, desktop, onboarding proxies).
            //
            // `Content-Length` and `Transfer-Encoding` are skipped —
            // recomputed by axum itself from the real outgoing `Body`;
            // forwarding the upstream's original values for either would
            // describe a body that doesn't match what's actually sent
            // (mirrors the SAME skip-list reasoning already applied to
            // the outgoing REQUEST's headers above).
            let mut response_headers = axum::http::HeaderMap::new();
            for (name, value) in upstream_response.headers() {
                if name == axum::http::header::CONTENT_LENGTH
                    || name == axum::http::header::TRANSFER_ENCODING
                {
                    continue;
                }
                response_headers.insert(name.clone(), value.clone());
            }
            let body_bytes = upstream_response
                .bytes()
                .await
                .unwrap_or_else(|_| axum::body::Bytes::new());
            let mut builder = Response::builder().status(status);
            if let Some(headers) = builder.headers_mut() {
                *headers = response_headers;
            }
            builder.body(Body::from(body_bytes)).unwrap_or_else(|_| {
                (StatusCode::BAD_GATEWAY, "failed to build response").into_response()
            })
        }
        Err(err) => {
            eprintln!("rust_gateway: failed to reach backend {target_addr}: {err}");
            (
                StatusCode::BAD_GATEWAY,
                format!("backend unreachable: {err}"),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::Request as HttpRequest,
        routing::{any as any_method, Router},
    };

    /// Real echo server reporting the Content-Type header it actually
    /// received — proves `forward_to` really forwards headers now,
    /// against a real network hop, not a mock.
    async fn spawn_content_type_echo() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind echo server");
        let port = listener.local_addr().unwrap().port();
        let app: Router = Router::new().route(
            "/*path",
            any_method(|req: HttpRequest<Body>| async move {
                req.headers()
                    .get(axum::http::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string()
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        port
    }

    /// This is the exact bug found live: a POST with a JSON body forwarded
    /// through `forward_to` must carry the original Content-Type header
    /// through, or a strict (e.g. FastAPI/pydantic) backend on the other
    /// end rejects the body outright even though the bytes are correct.
    #[tokio::test]
    async fn forward_to_preserves_content_type_header() {
        let echo_port = spawn_content_type_echo().await;
        let target_addr = format!("127.0.0.1:{echo_port}");

        let request = HttpRequest::builder()
            .method("POST")
            .uri("/some/path")
            .header("Content-Type", "application/json")
            .body(Body::from(r#"{"a":1}"#))
            .unwrap();

        let response = forward_to(&reqwest::Client::new(), &target_addr, request, None).await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(bytes.to_vec()).unwrap(),
            "application/json"
        );
    }

    /// Real bug found live (see CHECKPOINT.md): a stylesheet served
    /// through `forward_to` lost its `Content-Type`, so browsers refused
    /// to apply it — `forward_to` only ever copied `status` + `body` from
    /// the upstream response, never `headers()`. A response header (any
    /// of them — `Content-Type` here, but the bug affected all of them)
    /// must survive the relay back to the caller exactly as the real
    /// backend sent it.
    async fn spawn_fixed_header_backend() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind header-serving backend");
        let port = listener.local_addr().unwrap().port();
        let app: Router = Router::new().route(
            "/*path",
            any_method(|| async move {
                (
                    [
                        (axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8"),
                        (axum::http::header::CACHE_CONTROL, "no-cache"),
                    ],
                    "body { color: red }",
                )
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        port
    }

    #[tokio::test]
    async fn forward_to_preserves_upstream_response_headers() {
        let backend_port = spawn_fixed_header_backend().await;
        let target_addr = format!("127.0.0.1:{backend_port}");

        let request = HttpRequest::builder()
            .uri("/static/style.css")
            .body(Body::empty())
            .unwrap();

        let response = forward_to(&reqwest::Client::new(), &target_addr, request, None).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("text/css; charset=utf-8"),
            "a browser refuses to apply a stylesheet served with no Content-Type — this is \
             the exact live bug (see CHECKPOINT.md's hermes-webui CSS report)"
        );
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-cache"),
            "every upstream response header must survive, not just Content-Type specifically"
        );
    }
}
