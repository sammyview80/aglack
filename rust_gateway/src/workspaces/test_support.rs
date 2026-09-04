//! Shared test-only setup helpers used across every `workspaces::*` test
//! module (`mod.rs`, `route.rs`, `onboarding_proxy.rs`,
//! `hermes_webui_proxy.rs`, `desktop_proxy.rs`, and `crate::app`'s tests).
//! Each of these was previously copy-pasted verbatim into 6 different test
//! modules — extracted here so a change to how a temp store/state is built
//! (e.g. a new required field) only needs updating once. No test behavior
//! changes: every call site keeps asserting exactly what it asserted
//! before, just without redefining its own setup code first.
#![cfg(test)]

use std::future::Future;
use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    extract::{Path, Request, State},
    http::{Request as HttpRequest, StatusCode},
    response::Response,
    routing::{any as any_method, Router},
};

use super::container::FakeLauncher;
use super::{ContainerLauncher, WorkspaceStatus, WorkspaceStore, WorkspacesState};
use crate::integrations::openconnector::fake::FakeOpenConnector;
use crate::integrations::{IntegrationStore, IntegrationsState};

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

/// A minimal, Docker-free `Arc<IntegrationsState>` good enough for every
/// `WorkspacesState` test that never itself exercises integrations
/// behavior (i.e. everything except `create.rs`'s own creation-time
/// token-issuance tests, which build their own `IntegrationsState` with a
/// specific `FakeOpenConnector` to assert against). A FRESH, isolated
/// in-memory SQLite pool — deliberately NOT the same pool `state_with_store`'s
/// `WorkspaceStore` uses: nothing here needs the two to share rows, and a
/// real `db::connect` migration run per call would be needless overhead
/// for tests that never touch this state's tables at all. `FakeOpenConnector`
/// (not a real `OpenConnectorClient`) matches every other test double in
/// this crate (see `integrations::route`'s own test module) — no test
/// built on `state_with_store` may ever reach a real network call.
pub(crate) fn temp_integrations_state() -> Arc<IntegrationsState> {
    let pool = sqlx::SqlitePool::connect_lazy("sqlite::memory:")
        .expect("open in-memory sqlite pool");
    Arc::new(IntegrationsState {
        store: IntegrationStore::new(pool.clone()),
        openconnector: Arc::new(FakeOpenConnector::default()),
        providers: Vec::new(),
        workspace_store: WorkspaceStore::new(pool),
        http_client: reqwest::Client::new(),
        token_cipher: crate::crypto::TokenCipher::new(&[9u8; 32]),
        mcp_bearer_lockout: Default::default(),
        catalog_cache: Default::default(),
    })
}

/// Wrap a store + launcher into the `Arc<WorkspacesState>` every route
/// handler needs, with a fresh `reqwest::Client`. `launcher` is a
/// parameter (not hardcoded to `FakeLauncher::default()`) because
/// different tests need different launcher behavior — a failing launcher
/// to test the retry path, a `DockerCliLauncher` stub when a test only
/// cares about routing/CORS and never actually calls `launch`, etc.
/// `integrations` defaults to `temp_integrations_state()` via
/// `state_with_store` below for every existing call site (none of them
/// care about creation-time token issuance); a test that DOES care
/// constructs `WorkspacesState` directly with its own `IntegrationsState`
/// instead of calling this helper — see `create.rs`'s new tests.
pub(crate) fn state_with_store(
    store: WorkspaceStore,
    launcher: Arc<dyn ContainerLauncher>,
) -> Arc<WorkspacesState> {
    Arc::new(WorkspacesState {
        store,
        launcher,
        http_client: reqwest::Client::new(),
        integrations: temp_integrations_state(),
    })
}

/// Parse an axum `Response` body as JSON — every test asserting against
/// the shared `{ok, data}` / `{ok, error}` envelope needs this.
pub(crate) async fn body_json(response: Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// The plain-path `spawn_echo_wrapper()` variant shared verbatim by
/// `onboarding_proxy.rs`, `agent_seeder_proxy.rs`, and
/// `agent_history_proxy.rs` — a tiny real axum server standing in for "a
/// workspace's wrapper", bound to a real OS-assigned port, echoing back
/// the exact path it received. `hermes_webui_proxy.rs` and `chat_proxy.rs`
/// keep their own local variants (they echo different things — root-route
/// support and cookie value respectively).
pub(crate) async fn spawn_echo_wrapper() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind echo wrapper");
    let port = listener.local_addr().unwrap().port();
    let app: Router = Router::new().route(
        "/*path",
        any_method(|req: HttpRequest<Body>| async move {
            req.uri()
                .path_and_query()
                .map(|pq| pq.as_str().to_string())
                .unwrap_or_default()
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    port
}

fn fake_state(store: WorkspaceStore) -> Arc<WorkspacesState> {
    state_with_store(store, Arc::new(FakeLauncher::default()))
}

/// Shared body for the "unknown workspace id -> 404" test duplicated
/// across `onboarding_proxy.rs`, `agent_seeder_proxy.rs`,
/// `agent_history_proxy.rs`, `hermes_webui_proxy.rs`, and `chat_proxy.rs`.
/// `namespace` reproduces each file's own request URI shape
/// (`/workspaces/does-not-exist/<namespace>/`) exactly as it was before.
pub(crate) async fn assert_unknown_workspace_id_returns_404<F, Fut>(namespace: &str, route: F)
where
    F: Fn(State<Arc<WorkspacesState>>, Path<String>, Request) -> Fut,
    Fut: Future<Output = Response>,
{
    let state = fake_state(temp_store().await);

    let response = route(
        State(state),
        Path("does-not-exist".to_string()),
        HttpRequest::builder()
            .uri(format!("/workspaces/does-not-exist/{namespace}/"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = body_json(response).await;
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"]["code"], "workspace_not_found");
}

/// Shared body for the "workspace still `creating` -> 409" test
/// duplicated across the same 5 files. See
/// `assert_unknown_workspace_id_returns_404` for the `namespace` param.
pub(crate) async fn assert_not_ready_workspace_returns_409<F, Fut>(namespace: &str, route: F)
where
    F: Fn(State<Arc<WorkspacesState>>, Path<String>, Request) -> Fut,
    Fut: Future<Output = Response>,
{
    let store = temp_store().await;
    let record = store
        .begin_creation("my-workspace", "ws-1")
        .await
        .expect("begin_creation");
    assert_eq!(record.status, WorkspaceStatus::Creating);
    let state = fake_state(store);

    let response = route(
        State(state),
        Path("ws-1".to_string()),
        HttpRequest::builder()
            .uri(format!("/workspaces/ws-1/{namespace}/"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = body_json(response).await;
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"]["code"], "workspace_not_ready");
}

/// Shared body for the "workspace `failed` -> 409 not ready" test
/// duplicated across `onboarding_proxy.rs`, `agent_seeder_proxy.rs`, and
/// `agent_history_proxy.rs` (the only 3 files that have this test today).
pub(crate) async fn assert_failed_workspace_returns_409_not_ready<F, Fut>(namespace: &str, route: F)
where
    F: Fn(State<Arc<WorkspacesState>>, Path<String>, Request) -> Fut,
    Fut: Future<Output = Response>,
{
    let store = temp_store().await;
    store
        .begin_creation("my-workspace", "ws-1")
        .await
        .expect("begin_creation");
    store
        .mark_failed("my-workspace")
        .await
        .expect("mark_failed");
    let state = fake_state(store);

    let response = route(
        State(state),
        Path("ws-1".to_string()),
        HttpRequest::builder()
            .uri(format!("/workspaces/ws-1/{namespace}/"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = body_json(response).await;
    assert_eq!(body["error"]["code"], "workspace_not_ready");
}
