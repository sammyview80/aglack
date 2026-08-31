//! Throwaway test backend — stands in for the real wrapper (which runs on
//! whatever host/port HERMES_WRAPPER_HOST/HERMES_WRAPPER_PORT resolve to in
//! the final architecture; see ../../backend/wrapper) until the gateway's
//! Docker-orchestration + real container routing exists.
//!
//! Only purpose: answer every request with a plain "okay" so the gateway's
//! forwarding path can be proven end-to-end before anything real is wired
//! up. Delete or replace this once the gateway forwards to an actual
//! per-tenant workspace container instead of one fixed backend address.
//!
//! Run: cargo run --bin test_backend
//! Reads TEST_BACKEND_HOST and TEST_BACKEND_PORT from the environment (see
//! .env.example) — no hardcoded host/port. Point GATEWAY_BACKEND_HOST /
//! GATEWAY_BACKEND_PORT (the gateway's own config) at the same values to
//! test the two together.

use axum::{routing::get, Router};
use rust_gateway::config::load_dotenv_files;
use std::env;

#[tokio::main]
async fn main() {
    load_dotenv_files();

    let host = env::var("TEST_BACKEND_HOST").unwrap_or_else(|_| {
        eprintln!("test_backend: missing required env var TEST_BACKEND_HOST (see .env.example)");
        std::process::exit(1);
    });
    let port = env::var("TEST_BACKEND_PORT").unwrap_or_else(|_| {
        eprintln!("test_backend: missing required env var TEST_BACKEND_PORT (see .env.example)");
        std::process::exit(1);
    });
    let addr = format!("{host}:{port}");

    let app = Router::new().route("/", get(|| async { "okay" }));

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {addr}: {err}"));

    println!("test_backend listening on http://{addr} (always replies \"okay\")");

    axum::serve(listener, app)
        .await
        .expect("test_backend server error");
}
