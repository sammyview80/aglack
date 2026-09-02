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
use rust_gateway::config::{load_dotenv_files, GatewayConfig, WorkspacesConfig};
use rust_gateway::proxy::ProxyState;
use rust_gateway::workspaces::{DockerCliLauncher, WorkspaceStore, WorkspacesState};

#[tokio::main]
async fn main() {
    load_dotenv_files();

    let config = GatewayConfig::from_env().unwrap_or_else(|err| {
        eprintln!("rust_gateway: invalid configuration: {err}");
        std::process::exit(1);
    });
    let workspaces_config = WorkspacesConfig::from_env().unwrap_or_else(|err| {
        eprintln!("rust_gateway: invalid workspaces configuration: {err}");
        std::process::exit(1);
    });

    let proxy_state = Arc::new(ProxyState {
        http_client: reqwest::Client::new(),
        backend_addr: config.backend_addr(),
    });

    let db_pool = rust_gateway::db::connect(&workspaces_config.database_path)
        .await
        .unwrap_or_else(|err| {
            eprintln!(
                "rust_gateway: failed to open database at {}: {err}",
                workspaces_config.database_path.display()
            );
            std::process::exit(1);
        });
    let workspaces_state = Arc::new(WorkspacesState {
        store: WorkspaceStore::new(db_pool),
        launcher: Arc::new(DockerCliLauncher::new(
            workspaces_config.workspace_image_tag,
            config.wrapper_allowed_origins(),
            config.workspace_default_path.clone(),
            config.frontend_origin.clone(),
        )),
        http_client: reqwest::Client::new(),
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

    let app = build_router(
        proxy_state,
        workspaces_state,
        &config.frontend_origin,
        config.cors_enabled,
    );

    let listen_addr = config.listen_addr();
    let listener = tokio::net::TcpListener::bind(&listen_addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {listen_addr}: {err}"));

    println!("rust_gateway listening on http://{listen_addr}");
    println!(
        "forwarding every request to http://{}",
        config.backend_addr()
    );
    // Printed on every startup, not just on error: a CORS rejection is
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
        println!(
            "CORS: only {} may make browser (fetch/XHR) requests here — \
             if your frontend is open at a different origin, this is why chat/onboarding calls fail with a CORS error",
            allowed.join(" or ")
        );
    } else {
        println!("CORS: disabled");
    }

    axum::serve(listener, app)
        .await
        .expect("rust_gateway server error");
}
