//! Builds the axum `Router` — route registration only. Keeping this
//! separate from `bin/rust_gateway.rs` (process bootstrapping: config
//! loading, binding a listener, starting the server) means a future
//! integration test can build and exercise a `Router` directly, in-process,
//! without spawning a real subprocess bound to a real port.

use axum::{
    http::{HeaderValue, Method},
    routing::{any, delete, post},
    Router,
};
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::integrations::IntegrationsState;
use crate::proxy::{forward, ProxyState};
use crate::workspaces::{
    agent_history_proxy_route_root, agent_history_proxy_route_with_path,
    agent_seeder_proxy_route_root, agent_seeder_proxy_route_with_path, browser_proxy_route,
    chat_proxy_route_root, chat_proxy_route_with_path, commands_proxy_route_root,
    commands_proxy_route_with_path, create_workspace_route_authenticated, delete_workspace_route,
    desktop_proxy_route_root, desktop_proxy_route_with_path, diagnose_workspace_route,
    hermes_webui_proxy_route_root, hermes_webui_proxy_route_with_path,
    list_workspaces_route_authenticated, onboarding_proxy_route_root,
    onboarding_proxy_route_with_path, WorkspacesState,
};

/// Register one per-workspace proxy feature's pair of routes: the exact
/// prefix (`/workspaces/:id/<feature>/`, no further segments) and its
/// `*path` wildcard sibling. Every proxy feature under `workspaces/`
/// (onboarding, hermes-webui, desktop) needs exactly this same pair —
/// axum's `*path` wildcard does not match a bare trailing-slash request,
/// so the root case needs its own route+handler (see e.g.
/// `onboarding_proxy.rs`'s module doc for the full explanation of why).
/// Collapsing the two `.route(...)` calls into one here means a route
/// registered inconsistently (e.g. one feature's root and wildcard
/// pointing at prefixes that don't match) is a compile-time-obvious single
/// call, not something to eyeball-diff across 6 separate `.route(...)`
/// lines.
fn register_workspace_proxy_pair<H1, H2, T1, T2>(
    router: Router<Arc<WorkspacesState>>,
    prefix: &str,
    root_handler: H1,
    path_handler: H2,
) -> Router<Arc<WorkspacesState>>
where
    H1: axum::handler::Handler<T1, Arc<WorkspacesState>>,
    H2: axum::handler::Handler<T2, Arc<WorkspacesState>>,
    T1: 'static,
    T2: 'static,
{
    router
        .route(&format!("{prefix}/"), any(root_handler))
        .route(&format!("{prefix}/*path"), any(path_handler))
}

/// Expands one configured `FRONTEND_ORIGIN` into the exact set of origins
/// the CORS layer accepts. Always includes the configured origin itself,
/// plus — when its host is exactly `localhost` or `127.0.0.1` — the SAME
/// scheme and port with the other of those two spellings substituted.
///
/// Why this exists: `localhost` and `127.0.0.1` are different origins to
/// a browser even though they resolve to the same machine, but a human
/// (or a browser's own autocomplete/history) switching between the two is
/// not a real misconfiguration — it is the same frontend, the same port,
/// the same developer. Rejecting one spelling while accepting the other
/// produces a confusing "Cross-origin mismatch" CORS error that has
/// recurred multiple times in this project's history for exactly this
/// reason (see `docs/troubleshooting.md`'s "Cross-origin mismatch" entry).
///
/// Deliberately NOT a wildcard host match and NOT `AllowOrigin::any()`:
/// this returns a small, exact, finite list — never `*` — so it stays
/// compatible with `allow_credentials(true)` (see `build_router`), which
/// a real wildcard is not. Any host OTHER than `localhost`/`127.0.0.1`
/// (e.g. a real deployed domain) gets no sibling added — only these two
/// well-known local-dev aliases are ever substituted.
pub fn browser_allowed_origins(frontend_origin: &str) -> Vec<HeaderValue> {
    let mut origins = vec![HeaderValue::from_str(frontend_origin)
        .unwrap_or_else(|err| panic!("invalid FRONTEND_ORIGIN {frontend_origin:?}: {err}"))];

    // `rest` must start with `:` (the port separator) or be empty (no port
    // at all) — otherwise "http://127.0.0.1" would also match the host
    // "127.0.0.11" (a real, different machine) via plain prefix-stripping,
    // and "http://localhost" would match "localhost.evil.com". Requiring
    // the boundary is what makes this an exact host match, not a prefix
    // match.
    fn host_boundary(rest: &str) -> bool {
        rest.is_empty() || rest.starts_with(':')
    }
    let sibling = if let Some(rest) = frontend_origin.strip_prefix("http://localhost") {
        host_boundary(rest).then(|| format!("http://127.0.0.1{rest}"))
    } else if let Some(rest) = frontend_origin.strip_prefix("http://127.0.0.1") {
        host_boundary(rest).then(|| format!("http://localhost{rest}"))
    } else if let Some(rest) = frontend_origin.strip_prefix("https://localhost") {
        host_boundary(rest).then(|| format!("https://127.0.0.1{rest}"))
    } else if let Some(rest) = frontend_origin.strip_prefix("https://127.0.0.1") {
        host_boundary(rest).then(|| format!("https://localhost{rest}"))
    } else {
        None
    };

    if let Some(sibling) = sibling {
        origins.push(
            HeaderValue::from_str(&sibling)
                .unwrap_or_else(|err| panic!("invalid derived sibling origin {sibling:?}: {err}")),
        );
    }

    origins
}

/// Build the full router for this gateway.
///
/// Route order matters here: `/workspaces` is registered before the
/// catch-all proxy route, so it is never accidentally forwarded to the
/// backend instead of being handled by `create_workspace_route`.
///
/// `frontend_origin` (e.g. `http://127.0.0.1:5173`, see
/// `config::GatewayConfig::frontend_origin`) is the primary origin allowed
/// to make browser (CORS) requests here — required, not hardcoded,
/// matching AGENTS.md rule #2 — plus its `localhost`/`127.0.0.1` sibling,
/// see `browser_allowed_origins`. Without this, a browser's own fetch/XHR
/// to `/workspaces` from the frontend's origin is blocked before this
/// process ever sees the request (curl/server-to-server calls are
/// unaffected either way — CORS is enforced by the browser, not this
/// server, so this layer only matters for browser callers).
pub fn build_router(
    proxy_state: Arc<ProxyState>,
    workspaces_state: Arc<WorkspacesState>,
    integrations_state: Arc<IntegrationsState>,
    frontend_origin: &str,
    cors_enabled: bool,
) -> Router {
    let allowed_origins = browser_allowed_origins(frontend_origin);
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([axum::http::header::CONTENT_TYPE])
        // The chat proxy's browser client sends `credentials: 'include'`
        // (see frontend/src/features/chat/api.ts's own doc comment — the
        // gateway translates `?agent=` into a `hermes_profile` cookie the
        // container requires). tower_http REFUSES to pair a wildcard
        // origin with allow_credentials(true) (a browser would reject
        // that combination outright per the CORS spec) — which is
        // exactly why `browser_allowed_origins` below returns an EXACT,
        // finite allow-list (never `*`), even though it can list more
        // than one entry.
        .allow_credentials(true);

    let mut workspaces_router = Router::new()
        .route(
            "/workspaces",
            post(create_workspace_route_authenticated).get(list_workspaces_route_authenticated),
        )
        .route("/workspaces/:id", delete(delete_workspace_route))
        .route("/workspaces/:id/diagnose", post(diagnose_workspace_route));
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/onboarding",
        onboarding_proxy_route_root,
        onboarding_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/agent-seeder",
        agent_seeder_proxy_route_root,
        agent_seeder_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/hermes-webui",
        hermes_webui_proxy_route_root,
        hermes_webui_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/desktop",
        desktop_proxy_route_root,
        desktop_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/agent-history",
        agent_history_proxy_route_root,
        agent_history_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/chat",
        chat_proxy_route_root,
        chat_proxy_route_with_path,
    );
    workspaces_router = register_workspace_proxy_pair(
        workspaces_router,
        "/workspaces/:id/commands",
        commands_proxy_route_root,
        commands_proxy_route_with_path,
    );
    // `register_workspace_proxy_pair` only ever registers `<prefix>/` and
    // `<prefix>/*path` — axum's `*path` wildcard does not match a
    // zero-segment tail AND does not match the bare prefix with no
    // trailing slash at all, so `/workspaces/:id/commands` (no trailing
    // slash) matched NEITHER route above. Every other existing namespace's
    // frontend client only ever calls a real sub-path (e.g.
    // `.../agent-history/agents`) or the exact `<prefix>/`, so this gap
    // was never hit before commands' `listCommands`/`listBundles`
    // (`frontend/src/features/commands/api.ts`) became the first caller
    // to request the bare namespace root with no trailing slash — a real,
    // confirmed 404 in production, not theoretical. Reuses the same root
    // handler (`commands_proxy_route_root`, which already forwards
    // `path=""` correctly to the bare `/api/wrapper/v1/commands`).
    let workspaces_router =
        workspaces_router.route("/workspaces/:id/commands", any(commands_proxy_route_root));
    let workspaces_router = workspaces_router.with_state(workspaces_state);

    // Not `register_workspace_proxy_pair`/the `workspaces_router` above:
    // that helper (and every route on that router) is shaped for
    // `Arc<WorkspacesState>`, matching every OTHER proxy feature's
    // "forward everything under this prefix" shape. This route is
    // different in TWO ways — exactly THREE fixed named segments
    // (`workspace id`, `agent_id`, `action`), with `action` itself
    // validated server-side against a strict allowlist (see
    // `browser_proxy.rs`) rather than forwarded as an open-ended tail
    // path, AND its state is `Arc<IntegrationsState>`, not
    // `Arc<WorkspacesState>`: this route is called FROM INSIDE the
    // workspace's own container (no human browser session) and must pass
    // the SAME per-workspace integrations bearer check
    // `/workspaces/:id/mcp` already requires (see
    // `browser_proxy_route`'s own doc comment for why `IntegrationsState`
    // — not a second, duplicated lockout/state struct — is the right
    // home for that shared machinery). A separate small router, merged
    // in below, is the correct fit for a route with a genuinely different
    // state type, not a forced reuse of the `WorkspacesState` router.
    let browser_router = Router::new()
        .route(
            "/workspaces/:id/browser/:agent_id/:action",
            any(browser_proxy_route),
        )
        .with_state(integrations_state);

    let proxy_router = Router::new()
        .route("/", any(forward))
        .route("/*path", any(forward))
        .with_state(proxy_state);

    let router = workspaces_router.merge(browser_router).merge(proxy_router);
    if cors_enabled {
        router.layer(cors)
    } else {
        router
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::test_support::{state_with_store, temp_store};
    use crate::workspaces::DockerCliLauncher;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    /// `browser_allowed_origins` must add the `localhost`/`127.0.0.1`
    /// sibling for the well-known local-dev pair, but must NEVER treat a
    /// plain string prefix as a host match — "127.0.0.1" is a literal
    /// prefix of "127.0.0.11" (a different, real host) and "localhost" is
    /// a literal prefix of "localhost.evil.com" (an attacker-controlled
    /// domain); naively using `strip_prefix` without a boundary check
    /// would silently add a wrong, unintended origin to the allow-list for
    /// both of these.
    #[test]
    fn browser_allowed_origins_adds_the_localhost_127_sibling_only() {
        let origins: Vec<String> = browser_allowed_origins("http://127.0.0.1:5173")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        assert_eq!(
            origins,
            vec!["http://127.0.0.1:5173", "http://localhost:5173"]
        );

        let origins: Vec<String> = browser_allowed_origins("http://localhost:5173")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        assert_eq!(
            origins,
            vec!["http://localhost:5173", "http://127.0.0.1:5173"]
        );
    }

    #[test]
    fn browser_allowed_origins_never_matches_a_similar_but_different_host() {
        // "127.0.0.11" is a real, different host that happens to start
        // with the literal string "127.0.0.1" — must NOT get a spurious
        // "localhost:..." sibling from a naive prefix strip.
        let origins: Vec<String> = browser_allowed_origins("http://127.0.0.11:5173")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        assert_eq!(origins, vec!["http://127.0.0.11:5173"]);

        // "localhost.evil.com" starts with the literal string "localhost"
        // but is an entirely different, attacker-controlled domain — must
        // NOT get a spurious "127.0.0.1:..." sibling either.
        let origins: Vec<String> = browser_allowed_origins("http://localhost.evil.com:5173")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        assert_eq!(origins, vec!["http://localhost.evil.com:5173"]);
    }

    #[test]
    fn browser_allowed_origins_leaves_a_real_deployed_domain_untouched() {
        let origins: Vec<String> = browser_allowed_origins("https://app.example.com")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        assert_eq!(origins, vec!["https://app.example.com"]);
    }

    async fn temp_workspaces_state() -> Arc<WorkspacesState> {
        state_with_store(
            temp_store().await,
            Arc::new(DockerCliLauncher::new(
                "unused:tag".to_string(),
                "http://localhost:5173".to_string(),
                "/workspace/default".to_string(),
                "http://localhost:5173".to_string(),
                "http://gateway-internal:8080".to_string(),
                "4g".to_string(),
                "1g".to_string(),
                "4".to_string(),
            )),
        )
    }

    /// `IntegrationsState` for the browser route now merged into this
    /// router (see `build_router`'s own doc comment on why it needs a
    /// second state type) — a fresh, isolated SQLite-backed store, same
    /// pattern as `temp_workspaces_state`. None of the CORS/routing tests
    /// below actually authenticate a browser-route request (the one test
    /// that reaches it, `every_proxy_feature_prefix_is_reachable_through_the_real_router`,
    /// uses an unknown workspace id and asserts 404 for its OTHER
    /// prefixes — the browser route on an unknown id 401s on the bearer
    /// check instead, which that test accounts for separately), so this
    /// state never needs a seeded runtime token.
    fn temp_integrations_state() -> Arc<crate::integrations::IntegrationsState> {
        Arc::new(crate::integrations::IntegrationsState {
            store: crate::integrations::IntegrationStore::new(unused_sqlite_pool()),
            openconnector: Arc::new(
                crate::integrations::openconnector::fake::FakeOpenConnector::default(),
            ),
            providers: Vec::new(),
            workspace_store: crate::workspaces::WorkspaceStore::new(unused_sqlite_pool()),
            http_client: reqwest::Client::new(),
            token_cipher: crate::crypto::TokenCipher::new(&[9u8; 32]),
            mcp_bearer_lockout: Default::default(),
            catalog_cache: Default::default(),
        })
    }

    /// An in-memory SQLite pool good enough for `temp_integrations_state`'s
    /// two `Store`s, which none of this file's tests actually query (no
    /// browser-route request in this test module presents a bearer, so
    /// `find_runtime_token`/`workspace_store` lookups never run against
    /// it) — `sqlx::SqlitePool` requires a real (if empty/unmigrated)
    /// connection to construct at all, so this stands in for a full
    /// `db::connect` temp-file pool without needing a temp dir per call.
    fn unused_sqlite_pool() -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect_lazy("sqlite::memory:").expect("open in-memory sqlite pool")
    }

    fn unused_proxy_state() -> Arc<ProxyState> {
        Arc::new(ProxyState {
            http_client: reqwest::Client::new(),
            backend_addr: "127.0.0.1:1".to_string(),
        })
    }

    /// A browser preflight (OPTIONS) request from the configured frontend
    /// origin must get back an Access-Control-Allow-Origin header naming
    /// that exact origin — without it, the browser blocks the real POST
    /// before this server ever runs `create_workspace_route`.
    #[tokio::test]
    async fn preflight_from_configured_frontend_origin_is_allowed() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/workspaces")
                    .header("Origin", "http://127.0.0.1:5173")
                    .header("Access-Control-Request-Method", "POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let allow_origin = response
            .headers()
            .get("access-control-allow-origin")
            .expect("preflight response must include Access-Control-Allow-Origin")
            .to_str()
            .unwrap();
        assert_eq!(allow_origin, "http://127.0.0.1:5173");
    }

    /// A real POST response (not just the preflight) must also carry the
    /// header — some fetch/XHR implementations check it on the actual
    /// response, not only the preflight.
    #[tokio::test]
    async fn post_response_from_configured_frontend_origin_carries_cors_header() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/workspaces")
                    .header("Origin", "http://127.0.0.1:5173")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"name":"cors-test-ws"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        let allow_origin = response
            .headers()
            .get("access-control-allow-origin")
            .expect("POST response must include Access-Control-Allow-Origin")
            .to_str()
            .unwrap();
        assert_eq!(allow_origin, "http://127.0.0.1:5173");
    }

    /// The chat proxy's browser client sends `credentials: 'include'`
    /// (it must — the gateway translates `?agent=` into a `hermes_profile`
    /// cookie the container requires, see `frontend/src/features/chat/api.ts`'s
    /// own doc comment). A `fetch` with `credentials: 'include'` is
    /// rejected by the browser unless BOTH the preflight response's
    /// `Access-Control-Allow-Origin` names the exact origin (never `*`)
    /// AND it carries `Access-Control-Allow-Credentials: true` — the
    /// origin-echo alone (proven by the test above) is not sufficient.
    /// Without this header, every real chat call (`POST .../chat/api/session/new`
    /// and friends) fails as a CORS error in the browser despite the
    /// gateway itself working fine (curl/server-to-server unaffected,
    /// matching this file's own CORS doc comment on `build_router`) — a
    /// real bug hit live against `/workspaces/:id/chat/api/session/new`.
    #[tokio::test]
    async fn preflight_response_allows_credentials_for_cookie_bearing_chat_calls() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/workspaces/some-id/chat/api/session/new")
                    .header("Origin", "http://127.0.0.1:5173")
                    .header("Access-Control-Request-Method", "POST")
                    .header("Access-Control-Request-Headers", "content-type")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let allow_credentials = response
            .headers()
            .get("access-control-allow-credentials")
            .expect("preflight response must include Access-Control-Allow-Credentials: true")
            .to_str()
            .unwrap();
        assert_eq!(allow_credentials, "true");
    }

    /// `localhost` and `127.0.0.1` are DIFFERENT origins to a browser even
    /// though they resolve to the same machine — a real, repeatedly-hit
    /// failure (see docs/troubleshooting.md's "Cross-origin mismatch"
    /// entry): FRONTEND_ORIGIN is configured as one exact string, so if the
    /// browser tab happens to be open at the other spelling of the exact
    /// same port, every request is rejected even though nothing is
    /// actually misconfigured from the operator's point of view. The
    /// gateway now accepts BOTH spellings automatically for whichever
    /// port FRONTEND_ORIGIN names — configuring `127.0.0.1:5173` (as this
    /// test does) must also accept a browser at `localhost:5173`, and
    /// vice versa. This is deliberately NOT a wildcard origin (which
    /// tower_http/every browser refuses to pair with
    /// Access-Control-Allow-Credentials: true, see the credentials test
    /// above) — it is an exact two-item allow-list, still never `*`.
    #[tokio::test]
    async fn preflight_accepts_the_sibling_host_spelling_on_the_same_port() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/workspaces/some-id/chat/api/session/new")
                    .header("Origin", "http://localhost:5173")
                    .header("Access-Control-Request-Method", "POST")
                    .header("Access-Control-Request-Headers", "content-type")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let allow_origin = response
            .headers()
            .get("access-control-allow-origin")
            .expect("preflight response must include Access-Control-Allow-Origin for the sibling host spelling too")
            .to_str()
            .unwrap();
        assert_eq!(allow_origin, "http://localhost:5173");
        let allow_credentials = response
            .headers()
            .get("access-control-allow-credentials")
            .expect("sibling-host preflight response must also include Access-Control-Allow-Credentials: true")
            .to_str()
            .unwrap();
        assert_eq!(allow_credentials, "true");
    }

    /// Proves `register_workspace_proxy_pair` actually wired all FOUR
    /// proxy features' root+wildcard routes into the real router — every
    /// existing proxy-route test elsewhere (`onboarding_proxy.rs` etc.)
    /// calls the handler function directly, never through `build_router`
    /// itself, so a route-registration mistake (wrong prefix, swapped
    /// root/wildcard handler, a feature silently dropped) would NOT have
    /// been caught before this test existed. An unknown workspace id is
    /// used so every prefix below reaches its real handler and returns a
    /// real (404) response — proving actual dispatch, not just "some
    /// route exists that returns 200". The one exception is
    /// `/browser/...`: unlike every other proxy feature here, it is
    /// bearer-gated (see `browser_proxy.rs`/`require_workspace_bearer`),
    /// and this request carries no bearer at all — so it correctly 401s
    /// on the auth check BEFORE ever reaching `resolve_ready_workspace`'s
    /// own 404, which is still real dispatch (not axum's "no route
    /// matched", which this test's whole point is to rule out), just a
    /// different status for a route with an earlier gate.
    #[tokio::test]
    async fn every_proxy_feature_prefix_is_reachable_through_the_real_router() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        for uri in [
            "/workspaces/does-not-exist/onboarding/",
            "/workspaces/does-not-exist/onboarding/status",
            "/workspaces/does-not-exist/agent-seeder/",
            "/workspaces/does-not-exist/agent-seeder/apply",
            "/workspaces/does-not-exist/hermes-webui/",
            "/workspaces/does-not-exist/hermes-webui/api/sessions",
            "/workspaces/does-not-exist/desktop/",
            "/workspaces/does-not-exist/desktop/index.html",
            "/workspaces/does-not-exist/agent-history/",
            "/workspaces/does-not-exist/agent-history/agents",
            "/workspaces/does-not-exist/chat/",
            "/workspaces/does-not-exist/chat/api/chat/start",
            "/workspaces/does-not-exist/commands/",
            "/workspaces/does-not-exist/commands/exec",
            // No trailing slash, no sub-path at all — the exact shape
            // `frontend/src/features/commands/api.ts`'s `listCommands`
            // actually requests. Regression coverage for a REAL confirmed
            // 404 in production: `register_workspace_proxy_pair` only
            // ever registers `<prefix>/` and `<prefix>/*path`, neither of
            // which matches this bare form.
            "/workspaces/does-not-exist/commands",
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();

            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "expected {uri} to reach its proxy handler and report the unknown \
                 workspace id (workspace_not_found), not axum's own \"no route matched\""
            );
            // Status code ALONE does not prove real dispatch — axum's own
            // "no route matched" fallback is ALSO a bare 404, with no
            // body at all. Assert on the actual envelope body too: only
            // `resolve_ready_workspace` (real dispatch) produces this
            // exact `{"ok":false,"error":{"code":"workspace_not_found",...}}`
            // shape (see `resolve.rs`). This is not a hypothetical gap —
            // confirmed live: this test passed at 100% status-only before
            // a real route-registration bug shipped (the bare
            // `/workspaces/:id/commands`, no trailing slash, matched
            // NEITHER of `register_workspace_proxy_pair`'s two registered
            // routes and fell through to axum's own unmatched-route 404,
            // which this status-only assertion could not tell apart from
            // the real handler's own 404).
            let bytes = to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap_or_default();
            let body = String::from_utf8_lossy(&bytes);
            assert!(
                body.contains("workspace_not_found"),
                "expected {uri} to reach its proxy handler and return a real \
                 workspace_not_found envelope body, got: {body:?} — an empty/ \
                 non-JSON body here means axum's router never matched this URI \
                 at all (a registration bug), even though the status code alone \
                 was still 404"
            );
        }

        // `/browser/...` is registered on a genuinely different router
        // (`Arc<IntegrationsState>`, merged in separately — see
        // `build_router`'s own doc comment) than every URI in the loop
        // above, so it is checked on its own here: real dispatch (not
        // axum's "no route matched", which would be a 404 with no JSON
        // envelope body at all), but 401 `missing_bearer` rather than
        // `workspace_not_found`, because the bearer check runs BEFORE
        // workspace resolution for this route (see
        // `require_workspace_bearer`'s own doc comment for why).
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/workspaces/does-not-exist/browser/agent-1/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "expected the browser route to reach its real handler and report a missing \
             bearer, not axum's own \"no route matched\""
        );
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "missing_bearer");
    }

    /// `GET /workspaces` must dispatch to `list_workspaces_route`, not
    /// `create_workspace_route` (both share the `/workspaces` path,
    /// distinguished only by HTTP method) — proven through the real
    /// router, not just by calling the handler function directly.
    #[tokio::test]
    async fn get_workspaces_is_reachable_through_the_real_router() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/workspaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    /// `DELETE /workspaces/:id` must dispatch to `delete_workspace_route`
    /// through the real router — an unknown id is used so the handler
    /// itself runs and returns `workspace_not_found`, proving dispatch
    /// rather than axum's own "no route matched".
    #[tokio::test]
    async fn delete_workspace_is_reachable_through_the_real_router() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::DELETE)
                    .uri("/workspaces/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// A browser preflight for DELETE must be allowed — without DELETE in
    /// `allow_methods`, the dashboard delete button's CORS preflight is
    /// blocked before this server ever runs `delete_workspace_route`.
    #[tokio::test]
    async fn preflight_delete_from_configured_frontend_origin_is_allowed() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/workspaces/does-not-exist")
                    .header("Origin", "http://127.0.0.1:5173")
                    .header("Access-Control-Request-Method", "DELETE")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let allow_origin = response
            .headers()
            .get("access-control-allow-origin")
            .expect("preflight response must include Access-Control-Allow-Origin")
            .to_str()
            .unwrap();
        assert_eq!(allow_origin, "http://127.0.0.1:5173");
    }

    /// `cors_enabled: false` must mean no `CorsLayer` is applied at all —
    /// a preflight OPTIONS request gets no
    /// `Access-Control-Allow-Origin` header, which is what makes a
    /// browser block the cross-origin request itself (the standard "CORS
    /// disabled" meaning, not "allow everything"). This only proves the
    /// ROUTER-built response (this OPTIONS preflight) carries no CORS
    /// header — see `GatewayConfig::cors_enabled`'s doc comment for why a
    /// PROXIED backend response is a separate case this flag does not
    /// touch.
    #[tokio::test]
    async fn preflight_gets_no_allow_origin_header_when_cors_disabled() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            false,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/workspaces/does-not-exist")
                    .header("Origin", "http://127.0.0.1:5173")
                    .header("Access-Control-Request-Method", "DELETE")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert!(
            response
                .headers()
                .get("access-control-allow-origin")
                .is_none(),
            "no Access-Control-Allow-Origin header must be sent when CORS is disabled"
        );
    }

    /// `POST /workspaces/:id/diagnose` must dispatch to
    /// `diagnose_workspace_route` through the real router — an unknown id
    /// is used so the handler itself runs and returns
    /// `workspace_not_found`, proving dispatch rather than axum's own
    /// "no route matched". Also proves this new static `/diagnose`
    /// segment does not collide with the `/workspaces/:id/*path`
    /// wildcard proxy routes registered right after it.
    #[tokio::test]
    async fn diagnose_workspace_is_reachable_through_the_real_router() {
        let app = build_router(
            unused_proxy_state(),
            temp_workspaces_state().await,
            temp_integrations_state(),
            "http://127.0.0.1:5173",
            true,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/workspaces/does-not-exist/diagnose")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
