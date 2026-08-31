//! The actual request-forwarding logic: take one incoming request, send it
//! to the configured backend address, relay the response back unchanged.
//!
//! This is the seam that becomes "look up which tenant's container to
//! forward to" once a real tenant/container registry exists (see
//! ../../../backend/wrapper/docs/rust-gateway-architecture.md). Today
//! there is exactly one backend address for every request — no per-tenant
//! resolution, no auth, no Docker involvement. Keeping that limitation
//! isolated to this one function (rather than scattered through routing
//! code) is the point of this module existing separately from `app.rs`.

use axum::{
    body::Body,
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
pub async fn forward(State(state): State<Arc<ProxyState>>, req: Request) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    let target_uri = format!("http://{}{path_and_query}", state.backend_addr);
    let target_uri: Uri = match target_uri.parse() {
        Ok(uri) => uri,
        Err(_) => {
            return (StatusCode::BAD_GATEWAY, "invalid upstream target").into_response();
        }
    };

    let method = req.method().clone();
    let body_bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "failed to read request body").into_response();
        }
    };

    let upstream_result = state
        .http_client
        .request(method, target_uri.to_string())
        .body(body_bytes)
        .send()
        .await;

    match upstream_result {
        Ok(upstream_response) => {
            let status = upstream_response.status();
            let body_bytes = upstream_response
                .bytes()
                .await
                .unwrap_or_else(|_| axum::body::Bytes::new());
            Response::builder()
                .status(status)
                .body(Body::from(body_bytes))
                .unwrap_or_else(|_| {
                    (StatusCode::BAD_GATEWAY, "failed to build response").into_response()
                })
        }
        Err(err) => {
            eprintln!(
                "rust_gateway: failed to reach backend {}: {err}",
                state.backend_addr
            );
            (
                StatusCode::BAD_GATEWAY,
                format!("backend unreachable: {err}"),
            )
                .into_response()
        }
    }
}
