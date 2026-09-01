//! One JSON envelope shape for every route this gateway itself produces a
//! response body for (as opposed to `proxy::forward`, which relays an
//! upstream backend's response verbatim and must NOT be wrapped — that
//! body belongs to the backend, not this gateway).
//!
//! Success: `{ "ok": true, "data": <T> }`
//! Error:   `{ "ok": false, "error": { "code": "...", "message": "..." } }`
//!
//! A single shared `ok` boolean lets the frontend branch generically for
//! any endpoint using this envelope, instead of each caller inventing its
//! own success/error parsing. `code` is a stable, machine-checkable string
//! (e.g. `"workspace_name_taken"`); `message` is the human-readable detail
//! and MAY change wording without notice — callers must not match on it.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Serialize)]
struct ApiSuccessBody<T: Serialize> {
    ok: bool,
    data: T,
}

/// Wrap any serializable payload as `{ ok: true, data: <T> }` with the
/// given status code (usually `200 OK`, but e.g. `201 Created` is valid
/// too — the envelope shape doesn't dictate the status).
pub fn success<T: Serialize>(status: StatusCode, data: T) -> Response {
    (status, Json(ApiSuccessBody { ok: true, data })).into_response()
}

#[derive(Serialize)]
struct ApiErrorPayload {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct ApiErrorBody {
    ok: bool,
    error: ApiErrorPayload,
}

/// Wrap a machine-checkable `code` and a human-readable `message` as
/// `{ ok: false, error: { code, message } }` with the given status code.
/// `code` is a `&'static str` deliberately — every error site names one of
/// a small, fixed set of stable codes (grep this crate for `error(` call
/// sites to see the current set), rather than formatting an ad hoc string
/// a frontend could never safely match on.
pub fn error(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    (
        status,
        Json(ApiErrorBody {
            ok: false,
            error: ApiErrorPayload {
                code,
                message: message.into(),
            },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn success_envelope_has_ok_true_and_data() {
        let response = success(StatusCode::OK, serde_json::json!({"n": 1}));
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["n"], 1);
    }

    #[tokio::test]
    async fn error_envelope_has_ok_false_and_code_and_message() {
        let response = error(StatusCode::CONFLICT, "workspace_name_taken", "name taken");
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["error"]["code"], "workspace_name_taken");
        assert_eq!(parsed["error"]["message"], "name taken");
    }
}
