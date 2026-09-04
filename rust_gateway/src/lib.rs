//! Shared library code for the rust_gateway crate's binaries
//! (bin/rust_gateway.rs and bin/test_backend.rs).
//!
//! Module layout:
//!   config      — the ONE place environment variables are read (see AGENTS.md)
//!   proxy       — request-forwarding logic + the state it needs
//!   db          — SQLite connection setup (schema-aware, feature-unaware)
//!   workspaces  — create-workspace feature: idempotency + container launch
//!   response    — shared JSON success/error envelope for routes this
//!                 gateway itself produces a body for (NOT `proxy::forward`,
//!                 which relays an upstream backend's response verbatim)
//!   shared      — small crate-wide helpers with no feature of their own
//!                 (currently just `http`'s reqwest client builders)
//!   app         — route registration (builds the axum Router)
//!
//! See AGENTS.md and docs/ in this directory before changing any of these.

pub mod app;
pub mod auth;
pub mod config;
pub mod crypto;
pub mod db;
pub mod integrations;
pub mod proxy;
pub mod response;
pub mod shared;
pub mod workspaces;
