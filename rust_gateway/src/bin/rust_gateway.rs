//! Rust gateway — process entrypoint. First test slice.
//!
//! Scope right now: prove the routing wire works. This process listens on
//! its own host:port and forwards every incoming request to a backend
//! host:port, both read from the environment — nothing is hardcoded (see
//! .env.example in this directory and ../../.env.shared.example). See
//! AGENTS.md in this directory for how the project is organized, and
//! ../../backend/wrapper/docs/rust-gateway-architecture.md for the full
//! multi-tenant plan this is the first step toward.
//!
//! NOT YET IMPLEMENTED (do not assume any of this exists): tenant/container
//! registry, Docker orchestration, auth, billing, per-tenant routing keys.
//! Every request currently goes to the same single backend address.
//!
//! This file is intentionally thin: load config, build shared state, hand
//! off to `app::build_router`, bind, serve. Actual routing logic lives in
//! `crate::app`; actual forwarding logic lives in `crate::proxy`.
//!
//! Run: cargo run --bin rust_gateway
//! Reads GATEWAY_HOST, GATEWAY_PORT, GATEWAY_BACKEND_HOST,
//! GATEWAY_BACKEND_PORT from the environment (see .env.example).

use std::sync::Arc;

use rust_gateway::app::{browser_allowed_origins, build_router};
use rust_gateway::auth::{AuthState, SessionStore};
use rust_gateway::config::{
    load_dotenv_files, GatewayAuthConfig, GatewayConfig, IntegrationsConfig, WorkspacesConfig,
};
use rust_gateway::integrations::{
    load_providers, IntegrationStore, IntegrationsState, OpenConnectorClient,
};
use rust_gateway::proxy::ProxyState;
use rust_gateway::workspaces::{DockerCliLauncher, WorkspaceStore, WorkspacesState};

#[tokio::main]
async fn main() {
    // `GATEWAY_LOG_FORMAT` is read directly here via `std::env::var`
    // rather than through `config.rs` (a deliberate, narrow deviation
    // from AGENTS.md's "config.rs is the only place env is read" rule):
    // the log format has to be decided BEFORE `tracing_subscriber::init()`
    // runs, and that in turn has to happen before any other startup step
    // so early failures are logged too. Piping this bootstrap-time value
    // through `GatewayConfig` would mean either
    // loading config twice or moving subscriber init after config
    // loading, silently losing every log line config loading itself
    // could emit. Every OTHER env var in this process still goes through
    // `config.rs` exactly as before.
    let json_logs = std::env::var("GATEWAY_LOG_FORMAT")
        .map(|v| v.eq_ignore_ascii_case("json"))
        .unwrap_or(false);
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    if json_logs {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(env_filter)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(env_filter).init();
    }

    load_dotenv_files();

    let config = GatewayConfig::from_env().unwrap_or_else(|err| {
        tracing::error!("invalid configuration: {err}");
        std::process::exit(1);
    });
    let workspaces_config = WorkspacesConfig::from_env().unwrap_or_else(|err| {
        tracing::error!("invalid workspaces configuration: {err}");
        std::process::exit(1);
    });

    let proxy_state = Arc::new(ProxyState {
        http_client: rust_gateway::shared::http::json_client(),
        backend_addr: config.backend_addr(),
    });

    let db_pool = rust_gateway::db::connect(&workspaces_config.database_path)
        .await
        .unwrap_or_else(|err| {
            tracing::error!(
                path = %workspaces_config.database_path.display(),
                "failed to open database: {err}"
            );
            std::process::exit(1);
        });
    // `SqlitePool` is a cheap `Arc`-backed handle — cloning it (rather
    // than opening a second connection pool for the integrations feature)
    // means both features' migrations run against the exact same database
    // file via the one `db::connect` call above, matching this crate's
    // existing "one shared SQLite database, feature-specific tables"
    // convention (see db/mod.rs's own doc comment).
    let integrations_config = IntegrationsConfig::from_env().unwrap_or_else(|err| {
        tracing::error!("invalid integrations configuration: {err}");
        std::process::exit(1);
    });
    let providers = load_providers(&integrations_config.providers_path).unwrap_or_else(|err| {
        tracing::error!("invalid providers registry: {err}");
        std::process::exit(1);
    });
    let token_cipher =
        rust_gateway::crypto::TokenCipher::new(&integrations_config.token_encryption_key);
    let openconnector_client = Arc::new(OpenConnectorClient::new(
        integrations_config.openconnector_url,
        integrations_config.openconnector_admin_token,
    ));
    let integrations_state = Arc::new(IntegrationsState {
        store: IntegrationStore::new(db_pool.clone()),
        openconnector: openconnector_client.clone(),
        providers,
        workspace_store: WorkspaceStore::new(db_pool.clone()),
        // `stream_client()`, not `json_client()`: this client feeds
        // `forward_to` for `put_integration_agent_route`/
        // `list_integration_agents_route`/`oauth_callback_route`, which
        // relay a workspace wrapper's/OpenConnector's response body via
        // `Body::from_stream` — a fixed overall `.timeout()` would cut off
        // a response that legitimately takes longer than that to finish
        // streaming, not just one that never starts answering.
        http_client: rust_gateway::shared::http::stream_client(),
        token_cipher,
        mcp_bearer_lockout: Default::default(),
        catalog_cache: Default::default(),
    });

    // Push OAuth client credentials to OpenConnector for every provider
    // that has them configured in this process's environment — required
    // before `POST /api/oauth/authorizations` can succeed for that
    // provider (confirmed live in the POC: it fails closed with
    // `oauth_client_config_required` otherwise). Best-effort at startup:
    // a provider whose credentials are wrong, or OpenConnector being
    // briefly unreachable, must not crash the whole gateway — it just
    // means that one provider's OAuth connect will fail until fixed,
    // same as any other misconfiguration reported at request time.
    for provider in &integrations_state.providers {
        if let Some((client_id, client_secret)) = provider.oauth_credentials() {
            if let Err(err) = openconnector_client
                .upsert_oauth_config(&provider.openconnector_service, &client_id, &client_secret)
                .await
            {
                tracing::error!(
                    provider = %provider.id,
                    "failed to register OAuth config: {err}"
                );
            }
        }
    }

    let auth_config = GatewayAuthConfig::from_env().unwrap_or_else(|err| {
        tracing::error!("invalid auth configuration: {err}");
        std::process::exit(1);
    });
    let auth_state = Arc::new(AuthState::new(
        SessionStore::new(db_pool.clone()),
        db_pool.clone(),
        auth_config,
        config.frontend_origin.clone(),
        rust_gateway::shared::http::json_client(),
    ));

    let workspaces_state = Arc::new(WorkspacesState {
        store: WorkspaceStore::new(db_pool),
        launcher: Arc::new(DockerCliLauncher::new(
            workspaces_config.workspace_image_tag,
            config.wrapper_allowed_origins(),
            config.workspace_default_path.clone(),
            config.frontend_origin.clone(),
            config.workspace_gateway_url.clone(),
            workspaces_config.workspace_memory_limit,
            workspaces_config.workspace_shm_size,
            workspaces_config.workspace_browser_idle_timeout_minutes,
        )),
        // `stream_client()`: this client also backs the chat/desktop/
        // hermes-webui/onboarding proxies' `forward_to` calls, which
        // relay a workspace's real, potentially long-lived (SSE) response
        // body straight through — see `integrations_state`'s own comment
        // above for why a bounded `.timeout()` client is wrong here.
        http_client: rust_gateway::shared::http::stream_client(),
        // Cloning the `Arc<IntegrationsState>` already constructed above
        // — cheap refcount bump, the exact same shared state every
        // integrations route uses, not a second instance.
        integrations: integrations_state.clone(),
    });

    // Background watcher: if the Docker daemon itself goes down (e.g.
    // Docker Desktop killed) and later comes back up, make sure every
    // workspace the store believes is Ready actually has a running
    // container again. See `workspaces::daemon_watch` for the exact
    // down→up trigger and why it does not run continuously. Cloning the
    // `Arc<WorkspacesState>` (cheap refcount bump, same real store and
    // launcher every HTTP route already uses) keeps this an independent
    // long-lived task, not something that could ever block or be blocked
    // by request handling.
    tokio::spawn(rust_gateway::workspaces::run_daemon_watch(
        workspaces_state.clone(),
        rust_gateway::workspaces::DEFAULT_POLL_INTERVAL,
    ));

    // `build_router`'s own CORS layer is applied to ITS router before this
    // merge, so it does NOT cover the integrations routes merged in below
    // (a previous version of this file left that as a known gap — fixed
    // here). A second `CorsLayer`, wrapping the FULLY MERGED router,
    // covers both: tower's `Layer::layer` wraps outside-in, and
    // `CorsLayer` answers a browser's OPTIONS preflight directly without
    // ever calling into the inner service — so this outer layer handles
    // every preflight itself, including for the routes `build_router`'s
    // own inner layer already covers, without conflicting with it (a
    // request that isn't a CORS preflight just passes through both layers
    // and reaches its handler once, as normal). Real allow-list (never a
    // wildcard, matching `app::build_router`'s own reasoning) via the
    // SAME `browser_allowed_origins` helper — one source of truth for
    // which origins are legitimate, not a second hardcoded guess. Methods
    // include PUT (needed for `PUT /workspaces/:id/integrations/agents/:agent`
    // — `build_router`'s own inner layer only allows GET/POST/DELETE).
    let app = build_router(
        proxy_state,
        workspaces_state,
        integrations_state.clone(),
        &config.frontend_origin,
        config.cors_enabled,
    )
    .merge(rust_gateway::integrations::route::router(
        integrations_state.clone(),
    ))
    .merge(rust_gateway::integrations::catalog::router(
        integrations_state,
    ))
    .merge(rust_gateway::auth::router(auth_state.clone()));

    // The session-check middleware wraps everything ABOVE (every route
    // this process serves), applied via `axum::middleware::from_fn_with_state`
    // rather than a `tower::Layer` — same reasoning as the `CorsLayer`
    // additions elsewhere in this file: touching `app::build_router`
    // itself (ten pinned tests) is worse than composing one more wrapper
    // around its already-merged output. Applied BEFORE the CORS layer
    // below (i.e. CORS ends up OUTERMOST) so a browser's cross-origin
    // preflight — which never carries this gateway's cookie, by the CORS
    // spec — is answered by `CorsLayer` directly and never reaches the
    // session check at all; only the real, credentialed request after a
    // successful preflight does.
    let app = app.layer(axum::middleware::from_fn_with_state(
        auth_state,
        rust_gateway::auth::require_session,
    ));

    let app = if config.cors_enabled {
        use axum::http::Method;
        use tower_http::cors::{AllowOrigin, CorsLayer};
        app.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(browser_allowed_origins(
                    &config.frontend_origin,
                )))
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
                .allow_headers([axum::http::header::CONTENT_TYPE])
                .allow_credentials(true),
        )
    } else {
        app
    };

    let listen_addr = config.listen_addr();
    let listener = tokio::net::TcpListener::bind(&listen_addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {listen_addr}: {err}"));

    tracing::info!("rust_gateway listening on http://{listen_addr}");
    tracing::info!(
        "forwarding every request to http://{}",
        config.backend_addr()
    );
    // Logged on every startup, not just on error: a CORS rejection is
    // silent on the server side (the browser blocks it, this process
    // never logs anything wrong) and looks identical to a real gateway
    // bug from the browser's console alone. Having the exact allowed
    // origin list right here, every time, turns "why is this a CORS
    // error" into a 5-second diff against the browser's own address bar
    // instead of a code-reading exercise — see docs/troubleshooting.md's
    // "Cross-origin mismatch" entry for the full walkthrough. This is the
    // REAL list the CORS layer accepts (via browser_allowed_origins),
    // including the automatic localhost/127.0.0.1 sibling — not just the
    // single FRONTEND_ORIGIN value, which would be misleading now that
    // more than one origin can be genuinely allowed.
    if config.cors_enabled {
        let allowed: Vec<String> = browser_allowed_origins(&config.frontend_origin)
            .iter()
            .map(|v| v.to_str().unwrap_or("<invalid>").to_string())
            .collect();
        tracing::info!(
            "CORS: only {} may make browser (fetch/XHR) requests here — \
             if your frontend is open at a different origin, this is why chat/onboarding calls fail with a CORS error",
            allowed.join(" or ")
        );
    } else {
        tracing::info!("CORS: disabled");
    }

    axum::serve(listener, app)
        .await
        .expect("rust_gateway server error");
}
