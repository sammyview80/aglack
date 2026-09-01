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

use rust_gateway::app::build_router;
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

    let app = build_router(proxy_state, workspaces_state, &config.frontend_origin);

    let listen_addr = config.listen_addr();
    let listener = tokio::net::TcpListener::bind(&listen_addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {listen_addr}: {err}"));

    println!("rust_gateway listening on http://{listen_addr}");
    println!(
        "forwarding every request to http://{}",
        config.backend_addr()
    );

    axum::serve(listener, app)
        .await
        .expect("rust_gateway server error");
}
