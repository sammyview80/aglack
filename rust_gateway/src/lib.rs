//! Shared library code for the rust_gateway crate's binaries
//! (bin/rust_gateway.rs and bin/test_backend.rs).
//!
//! Module layout:
//!   config      — the ONE place environment variables are read (see AGENTS.md)
//!   proxy       — request-forwarding logic + the state it needs
//!   db          — SQLite connection setup (schema-aware, feature-unaware)
//!   workspaces  — create-workspace feature: idempotency + container launch
//!   app         — route registration (builds the axum Router)
//!
//! See AGENTS.md and docs/ in this directory before changing any of these.

pub mod app;
pub mod config;
pub mod db;
pub mod proxy;
pub mod workspaces;
