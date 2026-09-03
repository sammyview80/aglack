use std::time::Duration;
use tokio::time::sleep;

use super::desktop::desktop_subpath;

/// Poll `http://127.0.0.1:<port>/api/wrapper/v1/health` until it returns a
/// successful HTTP response, or `timeout` elapses. Short, frequent
/// retries — the wrapper crashing loudly and fast (as it does when
/// `wrapper_boot_script`'s safe.directory step is missing) should fail
/// this wait quickly, not silently wait the full timeout every time.
///
/// `pub(crate)` (not just used by `launch` below): `diagnosis.rs`'s heal
/// cycle also waits for a wrapper to come back up after `docker start`,
/// for the exact same reason `launch` waits after `docker create`+`start`
/// — a restarted container's wrapper takes the same real boot time as a
/// freshly created one's.
pub(crate) async fn wait_for_wrapper_ready(
    wrapper_port: u16,
    timeout: Duration,
) -> Result<(), super::super::CreateWorkspaceError> {
    let health_url = format!("http://127.0.0.1:{wrapper_port}/api/wrapper/v1/health");
    // `json_client()`, not a bare `reqwest::Client::new()`: without a
    // per-request timeout, one hung `send()` (the wrapper accepting the
    // TCP connection but never answering) can itself outlast this
    // function's own `timeout`/`deadline` loop below, since the deadline
    // is only checked BETWEEN calls, never during one.
    let client = crate::shared::http::json_client();
    let deadline = tokio::time::Instant::now() + timeout;
    let poll_interval = Duration::from_millis(500);

    loop {
        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(super::super::CreateWorkspaceError::Container(format!(
                "wrapper at {health_url} did not become healthy within {timeout:?}"
            )));
        }
        sleep(poll_interval).await;
    }
}

/// Poll `http://127.0.0.1:<port><desktop_subpath>` (see `desktop_subpath`
/// — NOT the bare root; the desktop's own app is mounted there once
/// `SUBFOLDER` is set) until it answers or `timeout` elapses. Verified
/// live that the desktop reliably comes up faster than the wrapper (~2s
/// vs ~3.5s), so this is a short timeout — it exists to make `Ready` a
/// real guarantee for the desktop too, not because the desktop is
/// expected to be the slow part.
///
/// `pub(crate)` — see `wait_for_wrapper_ready`'s doc comment; `diagnosis.rs`
/// reuses this too.
pub(crate) async fn wait_for_desktop_ready(
    workspace_id: &str,
    desktop_port: u16,
    timeout: Duration,
) -> Result<(), super::super::CreateWorkspaceError> {
    let url = format!(
        "http://127.0.0.1:{desktop_port}{}",
        desktop_subpath(workspace_id)
    );
    // See `wait_for_wrapper_ready`'s identical comment above.
    let client = crate::shared::http::json_client();
    let deadline = tokio::time::Instant::now() + timeout;
    let poll_interval = Duration::from_millis(500);

    loop {
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(super::super::CreateWorkspaceError::Container(format!(
                "desktop at {url} did not become ready within {timeout:?}"
            )));
        }
        sleep(poll_interval).await;
    }
}

/// Single-attempt (no retry loop) check of whether a workspace's wrapper
/// is answering `/api/wrapper/v1/health` RIGHT NOW — the same endpoint
/// `wait_for_wrapper_ready` polls at launch time, but called once, not in
/// a retry loop: a workspace that already reached `Ready` once is either
/// up or it isn't, there's nothing to "wait for" here. Used by
/// `list_workspaces_route` (see `route/list.rs` and
/// `../../docs/list-workspaces-plan.md`) to report LIVE health on every
/// `Ready` row, not just the DB's last-written status.
///
/// Takes a reused `reqwest::Client` (the caller's `WorkspacesState`'s
/// `http_client`) rather than constructing a new one per call — unlike
/// `wait_for_wrapper_ready`/`wait_for_desktop_ready` above (called once
/// per container launch, where a fresh client is cheap and inconsequential),
/// this is called once per `Ready` row on EVERY list request, so reusing
/// the client's connection pool actually matters here.
///
/// Returns a plain `bool`, not a `Result` — every failure mode (timeout,
/// connection refused, non-success status) means exactly one thing to a
/// caller of this function: "not healthy right now." There is no
/// separate action to take for a timeout versus a connection error, so
/// there is no error variant worth distinguishing.
pub(crate) async fn check_wrapper_health(
    client: &reqwest::Client,
    wrapper_port: u16,
    timeout: Duration,
) -> bool {
    let health_url = format!("http://127.0.0.1:{wrapper_port}/api/wrapper/v1/health");
    match tokio::time::timeout(timeout, client.get(&health_url).send()).await {
        Ok(Ok(response)) => response.status().is_success(),
        // Either the request itself errored (connection refused, DNS,
        // etc.) or the outer `timeout` elapsed first — both mean "not
        // healthy right now" to this function's caller.
        Ok(Err(_)) | Err(_) => false,
    }
}

/// Same shape and same reasoning as `check_wrapper_health` immediately
/// above, but against the desktop's own subpath (see `desktop_subpath` —
/// NOT the bare root, once `SUBFOLDER` is set) instead of the wrapper's
/// health endpoint. Used by `diagnosis.rs` so a diagnosis report never
/// treats the desktop as a second-class service that "we don't bother"
/// checking live — see `../../docs/diagnose-workspace-plan.md`.
pub(crate) async fn check_desktop_health(
    client: &reqwest::Client,
    workspace_id: &str,
    desktop_port: u16,
    timeout: Duration,
) -> bool {
    let url = format!(
        "http://127.0.0.1:{desktop_port}{}",
        desktop_subpath(workspace_id)
    );
    match tokio::time::timeout(timeout, client.get(&url).send()).await {
        Ok(Ok(response)) => response.status().is_success(),
        Ok(Err(_)) | Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// A real (if minimal) HTTP server answering `/api/wrapper/v1/health`
    /// with 200 must be reported healthy — proves the URL construction
    /// and success-status check against a REAL listener, not a mocked
    /// `reqwest::Response`.
    #[tokio::test]
    async fn check_wrapper_health_is_true_when_the_real_endpoint_answers_200() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        tokio::spawn(serve_one_health_ok(listener));

        let client = reqwest::Client::new();
        let healthy = check_wrapper_health(&client, port, Duration::from_secs(2)).await;
        assert!(healthy);
    }

    /// Nothing listening on the port at all (the container crashed, or
    /// was never really there) must be reported unhealthy, not panic or
    /// hang — this is the common real-world case this function exists
    /// to detect.
    #[tokio::test]
    async fn check_wrapper_health_is_false_when_nothing_is_listening() {
        // Bind then immediately drop the listener: frees the OS-assigned
        // port back up while guaranteeing nothing else grabbed it in the
        // meantime for the immediately-following connection attempt.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        drop(listener);

        let client = reqwest::Client::new();
        let healthy = check_wrapper_health(&client, port, Duration::from_secs(2)).await;
        assert!(!healthy);
    }

    /// A listener that accepts the TCP connection but never answers must
    /// be treated as unhealthy once the given timeout elapses — proves
    /// the `tokio::time::timeout` wrapper actually bounds the call, not
    /// just the connect step (a hung/wedged wrapper process would accept
    /// the connection and then never respond, not refuse it outright).
    #[tokio::test]
    async fn check_wrapper_health_is_false_when_the_response_never_comes() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        tokio::spawn(async move {
            // Accept and hold the connection open without ever writing a
            // response — simulates a hung wrapper process.
            if let Ok((stream, _)) = listener.accept().await {
                std::mem::forget(stream);
            }
        });

        let client = reqwest::Client::new();
        let healthy = check_wrapper_health(&client, port, Duration::from_millis(200)).await;
        assert!(!healthy);
    }

    /// Minimal HTTP/1.1 server: accepts one connection, replies with a
    /// bare `200 OK`, done. Just enough to make `reqwest` see a real
    /// successful HTTP response for the "healthy" test case above —
    /// deliberately not using axum/a real router here, since the only
    /// thing under test is `check_wrapper_health`'s own request/response
    /// handling, not a full HTTP server implementation.
    async fn serve_one_health_ok(listener: TcpListener) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
        }
    }

    /// Accept exactly one real HTTP connection and answer 200 ONLY if the
    /// request line's path exactly matches `expected_path`, 404
    /// otherwise — proves a caller requested the SUBFOLDER-prefixed path
    /// specifically, not just "any path happened to return 200" (a naive
    /// always-200 fixture would silently pass even after the real
    /// regression this guards against — see `desktop_subpath`'s doc
    /// comment for the live bug this is about).
    async fn serve_ok_only_for_path(listener: TcpListener, expected_path: &'static str) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let request_line = String::from_utf8_lossy(&buf[..n]);
            let requested_path = request_line
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("");
            let response = if requested_path == expected_path {
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice()
            } else {
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .as_slice()
            };
            let _ = stream.write_all(response).await;
        }
    }

    /// Real bug found live: `wait_for_desktop_ready` used to check the
    /// bare root, but once `SUBFOLDER` is set (see
    /// `desktop_subfolder_env_arg`), the desktop's own app answers ONLY
    /// at `/workspaces/<id>/desktop/` — a bare `/` 404s. This proves the
    /// function requests the CORRECT prefixed path specifically (a server
    /// that only answers 200 there, 404 everywhere else, including bare
    /// `/`).
    #[tokio::test]
    async fn wait_for_desktop_ready_requests_the_workspace_subpath_not_bare_root() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        tokio::spawn(serve_ok_only_for_path(
            listener,
            "/workspaces/ws-123/desktop/",
        ));

        let result = wait_for_desktop_ready("ws-123", port, Duration::from_secs(2)).await;
        assert!(
            result.is_ok(),
            "must succeed against a server answering the correct subpath"
        );
    }

    /// Same bug, `check_desktop_health` side (used by `diagnosis.rs`) —
    /// a server answering only at the workspace's subpath must be
    /// reported healthy; one answering only at the bare root (the OLD,
    /// wrong behavior) must be reported UNHEALTHY, since that's not
    /// where the real desktop app answers once `SUBFOLDER` is set.
    #[tokio::test]
    async fn check_desktop_health_is_true_only_for_the_workspace_subpath() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        tokio::spawn(serve_ok_only_for_path(
            listener,
            "/workspaces/ws-456/desktop/",
        ));

        let client = reqwest::Client::new();
        let healthy = check_desktop_health(&client, "ws-456", port, Duration::from_secs(2)).await;
        assert!(healthy);
    }

    #[tokio::test]
    async fn check_desktop_health_is_false_when_server_only_answers_bare_root() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        // Simulates the OLD, wrong behavior: a server that only answers
        // "/" — exactly what the desktop's own app stops doing once
        // SUBFOLDER is set (see desktop_subpath's doc comment).
        tokio::spawn(serve_ok_only_for_path(listener, "/"));

        let client = reqwest::Client::new();
        let healthy = check_desktop_health(&client, "ws-789", port, Duration::from_secs(2)).await;
        assert!(
            !healthy,
            "a server that only answers bare '/' must be reported unhealthy — that's not \
             where the real desktop app answers once SUBFOLDER is set"
        );
    }
}
