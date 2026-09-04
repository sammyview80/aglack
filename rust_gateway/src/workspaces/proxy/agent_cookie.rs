//! Shared `?agent=<name>` -> `Cookie: hermes_profile=<name>` injection,
//! used by every proxy namespace whose wrapper-side handler resolves the
//! target Hermes profile from that cookie (`chat_proxy.rs`, and
//! `commands_proxy.rs`). Extracted verbatim from `chat_proxy.rs` so the
//! two namespaces share one validation charset and one merge rule rather
//! than drifting apart — a laxer copy in one file would be a header
//! injection hole the other file's tests would never catch.
//!
//! See `docs/hermes-chat-wire-contract.md` §6 and `docs/chat-proxy-plan.md`
//! for why the cookie has to be injected server-side per request at all.

use axum::{
    extract::Request,
    http::{HeaderValue, StatusCode},
    response::Response,
};

use crate::response::error;

const PROFILE_COOKIE_NAME: &str = "hermes_profile";

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

/// Only a conservative charset is allowed into the `Cookie` header value —
/// CR, LF, `;`, and whitespace are exactly the characters that would let an
/// `agent` query param forge additional headers/cookies on the outgoing
/// request (see docs/chat-proxy-plan.md's security note). Reject anything
/// outside ASCII alphanumerics, `-`, `_`, `.` rather than trying to escape
/// it — Hermes profile names have no legitimate need for anything else.
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

/// The full per-request step every cookie-injecting namespace performs:
/// read `agent` from the query string, validate it, and set the merged
/// `Cookie` header on `req`. Returns the 400 response to hand back to the
/// client if the value is rejected; `Ok(())` otherwise (including when no
/// `agent` param is present at all, which is a no-op).
///
/// `agent` is read from the query string but deliberately left IN the
/// forwarded query string (not stripped) — the wrapper/Hermes ignore
/// unknown params, and leaving it keeps the forwarded URL an honest
/// reflection of the original request.
pub(super) fn inject_agent_cookie(req: &mut Request) -> Result<(), Response> {
    let Some(agent) = req.uri().query().and_then(extract_agent_param) else {
        return Ok(());
    };

    if !is_valid_agent_name(&agent) {
        return Err(invalid_agent());
    }
    let cookie_value = merge_cookie_header(req.headers().get(axum::http::header::COOKIE), &agent);
    let header_value = HeaderValue::from_str(&cookie_value).map_err(|_| invalid_agent())?;
    req.headers_mut()
        .insert(axum::http::header::COOKIE, header_value);
    Ok(())
}

fn invalid_agent() -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "invalid_agent",
        "agent must match [A-Za-z0-9_.-]+",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `find_map` over `query.split('&')` takes the FIRST `agent=` match —
    /// pin that behavior explicitly so a future refactor (e.g. swapping to
    /// a different query-string library) that silently picks the LAST one
    /// instead has a test to fail, rather than an unnoticed profile-
    /// selection change for a caller who (accidentally or adversarially)
    /// sends two `agent=` params.
    #[test]
    fn duplicate_agent_param_keeps_the_first() {
        assert_eq!(
            extract_agent_param("agent=pm&agent=evil"),
            Some("pm".to_string())
        );
        assert_eq!(
            extract_agent_param("other=1&agent=first&agent=second"),
            Some("first".to_string())
        );
    }
}
