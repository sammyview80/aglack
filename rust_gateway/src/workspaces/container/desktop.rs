/// The single source of truth for the desktop's subpath — the SAME
/// string used both as the container's `SUBFOLDER` env var (see
/// `desktop_subfolder_env_arg`) and as the path segment every desktop
/// HTTP check must request instead of the bare root. Real bug found live
/// (via a real headless-Chrome + CDP session, then confirmed by manually
/// launching a real container): once `SUBFOLDER` is set, the container's
/// own kclient app mounts its ENTIRE Express app under that exact path
/// (`app.use(SUBFOLDER, baseRouter)`) — a bare `GET /` against the
/// desktop port now 404s; only `GET <this path>` answers. Every caller
/// that talks to the desktop's HTTP port (`wait_for_desktop_ready`,
/// `check_desktop_health`) MUST use this same path, not a hardcoded `/`,
/// or the fix that made the browser's OWN websocket connect to the right
/// place breaks the gateway's own readiness/health checks against that
/// same container instead.
pub(crate) fn desktop_subpath(workspace_id: &str) -> String {
    format!("/workspaces/{workspace_id}/desktop/")
}

/// Build the `-e SUBFOLDER=<value>` argument (as one `KEY=VALUE` string,
/// the exact shape `docker create -e` expects) so the webtop image's
/// bundled KasmVNC client ("kclient", `/kclient/index.js` inside the
/// container) knows it is being served from a subpath instead of the
/// site root.
///
/// This is REQUIRED, not cosmetic — verified live with a real headless
/// Chrome + CDP session: without it, the desktop's own VNC client (its
/// `app/ui.js`'s `UI.connect()`) builds an ABSOLUTE websocket URL as
/// `ws://<host>[:<port>]/websockify` — no path prefix at all — because
/// `kclient`'s own server-rendered iframe template only injects the
/// correct subpath into the client's `path` setting when `SUBFOLDER` is
/// set (see `kclient`'s own `index.js`: `SUBFOLDER != '/'` computes
/// `PATH = '&path=' + SUBFOLDER.substring(1) + 'websockify'`, injected
/// into the iframe src via `<%- path -%>`). Without it, the browser's
/// real WebSocket connects to the GATEWAY'S OWN ROOT `/websockify` —
/// which has no route — and the handshake never completes: this is the
/// exact, confirmed mechanism behind a real "stuck on Connecting..."
/// report (`Network.webSocketCreated` fires, no
/// `Network.webSocketHandshakeResponseReceived` ever follows).
///
/// The trailing slash is REQUIRED: `kclient` computes
/// `SUBFOLDER.substring(1) + 'websockify'` with no separator inserted —
/// a value without a trailing slash would produce e.g.
/// `workspaces/<id>/desktopwebsockify` (missing path segment boundary).
/// Also required as the exact prefix `kclient`'s own `app.use(SUBFOLDER,
/// baseRouter)` mounts its whole Express app under, so its other routes
/// (`/vnc/*`, `/public/*`, `/manifest.json`, the file-browser socket.io
/// namespace) resolve correctly through the gateway too, not just the
/// VNC websocket specifically.
pub(crate) fn desktop_subfolder_env_arg(workspace_id: &str) -> String {
    format!("SUBFOLDER={}", desktop_subpath(workspace_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real bug found live (via a real headless-Chrome + CDP session):
    /// without `SUBFOLDER` set to the exact gateway-facing prefix, the
    /// desktop's own VNC client opens its websocket at the gateway's
    /// ROOT (`ws://<host>/websockify`, no route there) instead of the
    /// per-workspace path — the handshake then never completes, which is
    /// the exact mechanism behind a real "stuck on Connecting..." report.
    #[test]
    fn desktop_subfolder_env_arg_has_the_workspaces_prefix_and_trailing_slash() {
        let arg = desktop_subfolder_env_arg("abc-123");
        assert_eq!(
            arg, "SUBFOLDER=/workspaces/abc-123/desktop/",
            "kclient's own index.js computes `SUBFOLDER.substring(1) + 'websockify'` with \
             no separator inserted — a missing trailing slash would produce a malformed path \
             like 'desktopwebsockify', and a wrong prefix would point the client's websocket \
             at a path this gateway doesn't route at all"
        );
    }
}
