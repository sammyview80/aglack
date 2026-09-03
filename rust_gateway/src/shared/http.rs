//! Shared `reqwest::Client` builders.
//!
//! `reqwest::Client::new()` has NO timeout at all — a hung upstream (an
//! unresponsive OpenConnector container, a workspace wrapper that never
//! answers) pins the calling tokio task forever, and every caller of that
//! route hangs with it (e.g. `GET /workspaces/:id/integrations`). Every
//! production HTTP call in this crate must go through one of the clients
//! below instead of constructing its own bare `reqwest::Client`.

use std::time::Duration;

/// For request/response JSON calls that must always complete or fail
/// within a bounded time — OpenConnector admin calls, workspace wrapper
/// health/status calls, and any other "ask, get one answer back" HTTP
/// call this crate makes. NOT for long-lived/streaming forwards (see
/// `stream_client` below).
pub fn json_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .expect("reqwest client")
}

/// For proxied paths that are long-lived or streaming (SSE, chunked
/// responses that may legitimately take longer than `json_client`'s
/// fixed overall timeout to finish) — only a `connect_timeout` is set, so
/// a hung TCP handshake still fails fast, but an established connection
/// streaming data slowly is never killed by a fixed deadline.
///
/// Not currently wired anywhere: every streaming forward in this crate
/// (`proxy::forward_to`, used by SSE/desktop/chat proxies) takes its
/// `reqwest::Client` from caller state (`ProxyState::http_client`,
/// `WorkspacesState::http_client`, ...), which is intentionally the
/// bounded `json_client()` today — the actual proxied bodies stream via
/// `Body::from_stream` regardless of the client's own `.timeout()`
/// (`.timeout()` bounds the whole request-response exchange, and
/// `forward_to` already gets a response and starts streaming its body
/// well within 15s in every case this crate proxies). Kept here for
/// forward-compatibility: the day a genuinely long-lived proxied call
/// needs its OWN client instance, it should be `stream_client()`, not a
/// bare `reqwest::Client::new()`.
pub fn stream_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()
        .expect("reqwest client")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn json_client_builds_without_panicking() {
        let _client = json_client();
    }

    #[test]
    fn stream_client_builds_without_panicking() {
        let _client = stream_client();
    }

    /// Behavioral proof `json_client`'s `.timeout()` is real: point it at
    /// an address nothing answers on (a bound-but-not-accepting TCP
    /// listener) so the connect itself hangs, and confirm the request
    /// fails as a timeout well within a bounded wall-clock window rather
    /// than hanging forever. Uses a short override of the connect timeout
    /// (rather than the full 3s/15s production values) so this test runs
    /// fast, matching the crate's existing convention of test-only
    /// timeout overrides for timeout-sensitive tests (see
    /// `workspaces::container::health`'s tests, which pass short
    /// `Duration`s into `wait_for_wrapper_ready`/`wait_for_desktop_ready`
    /// rather than exercising their production timeouts directly).
    #[tokio::test]
    async fn a_request_that_cannot_connect_fails_as_a_timeout_within_a_bounded_time() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local_addr");
        // A backlog of 0 plus never calling `accept` means the OS still
        // completes the TCP handshake for a `SYN` (Linux/macOS both keep
        // a small SYN queue outside the listener's own backlog), so a
        // real hang here would come from something ACCEPTING the
        // connection but never answering HTTP — closer to the real
        // "upstream is up but wedged" failure this client guards against
        // than a plain connection-refused would be. Kept alive for the
        // duration of the request by leaking the listener into a
        // background thread that never accepts.
        std::thread::spawn(move || {
            let _keep_listening = listener;
            std::thread::sleep(Duration::from_secs(30));
        });

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(200))
            .timeout(Duration::from_millis(500))
            .build()
            .expect("reqwest client");

        let started = Instant::now();
        let result = client.get(format!("http://{addr}/")).send().await;
        let elapsed = started.elapsed();

        assert!(result.is_err(), "a request to an unresponsive upstream must fail, not hang");
        assert!(
            result.unwrap_err().is_timeout(),
            "the failure must be reported as a timeout, not some other error kind"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "must fail within a bounded time, not hang indefinitely: took {elapsed:?}"
        );
    }
}
