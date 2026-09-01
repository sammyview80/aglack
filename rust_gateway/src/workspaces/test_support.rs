//! Shared test-only setup helpers used across every `workspaces::*` test
//! module (`mod.rs`, `route.rs`, `onboarding_proxy.rs`,
//! `hermes_webui_proxy.rs`, `desktop_proxy.rs`, and `crate::app`'s tests).
//! Each of these was previously copy-pasted verbatim into 6 different test
//! modules — extracted here so a change to how a temp store/state is built
//! (e.g. a new required field) only needs updating once. No test behavior
//! changes: every call site keeps asserting exactly what it asserted
//! before, just without redefining its own setup code first.
#![cfg(test)]

use std::sync::Arc;

use axum::{body::to_bytes, response::Response};

use super::{ContainerLauncher, WorkspaceStore, WorkspacesState};

/// A fresh, isolated SQLite-backed `WorkspaceStore` in a throwaway temp
/// dir. The tempdir is deliberately leaked (`std::mem::forget`) rather
/// than dropped — the pool must outlive the directory for the lifetime of
/// a short-lived test process; acceptable since the whole process exits
/// right after.
pub(crate) async fn temp_store() -> WorkspaceStore {
    let dir = tempfile::tempdir().expect("create temp dir");
    let db_path = dir.path().join("test.db");
    std::mem::forget(dir);
    let pool = crate::db::connect(&db_path)
        .await
        .expect("connect to fresh sqlite db");
    WorkspaceStore::new(pool)
}

/// Wrap a store + launcher into the `Arc<WorkspacesState>` every route
/// handler needs, with a fresh `reqwest::Client`. `launcher` is a
/// parameter (not hardcoded to `FakeLauncher::default()`) because
/// different tests need different launcher behavior — a failing launcher
/// to test the retry path, a `DockerCliLauncher` stub when a test only
/// cares about routing/CORS and never actually calls `launch`, etc.
pub(crate) fn state_with_store(
    store: WorkspaceStore,
    launcher: Arc<dyn ContainerLauncher>,
) -> Arc<WorkspacesState> {
    Arc::new(WorkspacesState {
        store,
        launcher,
        http_client: reqwest::Client::new(),
    })
}

/// Parse an axum `Response` body as JSON — every test asserting against
/// the shared `{ok, data}` / `{ok, error}` envelope needs this.
pub(crate) async fn body_json(response: Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
