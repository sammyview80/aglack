use axum::{extract::{Extension, State}, http::StatusCode, response::Response, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::WorkspacesState;
use crate::integrations::route::issue_and_deliver_runtime_token;
use crate::response::{error, success};
use crate::workspaces::{create_workspace, CreateWorkspaceError, WorkspaceRecord, WorkspaceStatus};
use crate::auth::AuthenticatedUser;

#[derive(Deserialize)]
pub struct CreateWorkspaceRequest {
    pub name: String,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Serialize)]
struct CreateWorkspaceData {
    workspace_id: String,
    status: &'static str,
    container_name: Option<String>,
}

/// POST /workspaces
///
/// Body: `{ "name": "my-workspace", "password": "optional" }`. `name` is
/// required and doubles as the idempotency key (see module docs) unless
/// it already belongs to a `ready` workspace, in which case this returns
/// `409 workspace_name_taken`.
///
/// The workspace `name` doubles as the idempotency key, but only while a
/// creation is still in flight or previously failed: a request for a name
/// whose creation already finished (`status: ready`) is a name COLLISION,
/// not a retry — it is rejected with `409 workspace_name_taken` rather
/// than silently handing back the existing workspace (a caller has no way
/// to tell "you got your own workspace back" from "you got someone else's
/// same-named workspace back" otherwise). A `creating` or `failed` record
/// still retries exactly as before — that distinction has its own
/// regression test in `mod.rs`
/// (`a_key_whose_launch_failed_is_retried_on_the_next_call_with_the_same_key`)
/// and is unaffected by this file's `Ready` check.
pub async fn create_workspace_route(
    State(state): State<Arc<WorkspacesState>>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> Response {
    create_workspace_route_inner(state, request, None).await
}

pub async fn create_workspace_route_authenticated(
    State(state): State<Arc<WorkspacesState>>,
    user: Option<Extension<AuthenticatedUser>>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> Response {
    create_workspace_route_inner(state, request, user.map(|Extension(user)| user)).await
}

async fn create_workspace_route_inner(
    state: Arc<WorkspacesState>,
    request: CreateWorkspaceRequest,
    user: Option<AuthenticatedUser>,
) -> Response {
    let name = request.name.trim();
    if name.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "workspace_name_required",
            "name is required",
        );
    }

    // `password` is accepted (matching the existing frontend contract) but
    // not yet used by anything — auth for workspace containers is not
    // built yet. Accepting and silently ignoring it here, rather than
    // rejecting requests that include it, keeps the existing frontend
    // working unmodified against this route.
    let _password = request.password;

    // Name-collision check: a `ready` record for this exact name already
    // exists. This is deliberately checked here, not inside
    // `create_workspace` itself — `create_workspace`'s own idempotency
    // contract (same key while `creating`/`failed` retries) stays intact
    // for its existing callers/tests; only the HTTP-facing "is this name
    // already taken" question changes shape (an error, not a 200) at this
    // boundary.
    match state.store.find(name).await {
        Ok(Some(existing)) if existing.status == WorkspaceStatus::Ready => {
            return error(
                StatusCode::CONFLICT,
                "workspace_name_taken",
                format!("workspace name {name:?} is already in use"),
            );
        }
        Ok(_) => {}
        Err(err) => {
            eprintln!("rust_gateway: workspace lookup error: {err}");
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_lookup_failed",
                "failed to check workspace name",
            );
        }
    }

    match create_workspace(&state.store, state.launcher.as_ref(), name).await {
        Ok(record) => {
            if let Some(user) = user.as_ref() {
                if let Err(err) = state.store.set_owner(&record.workspace_id, &user.google_sub).await {
                    eprintln!("rust_gateway: workspace owner update failed: {err}");
                    return error(StatusCode::INTERNAL_SERVER_ERROR, "workspace_store_failed", "failed to assign workspace owner");
                }
            }
            // Best-effort, AFTER the workspace already exists and is
            // `Ready`: deliver `/run/hermes/integrations.token` at
            // creation time, not only on this workspace's first real
            // OpenConnector connect (see this function's own doc comment
            // below for the full "why" and the sentinel-UUID design). A
            // `Creating`/`Failed` result (still-in-progress retry, or a
            // launch that gave up) has no container to deliver into yet
            // and is left exactly as before — the workspace's own
            // eventual `Ready` transition has no single call site outside
            // this route to hook a second attempt into, and the first
            // real `connect_integration_route` call remains the fallback
            // either way (see `issue_creation_time_runtime_token`'s doc
            // comment).
            if record.status == WorkspaceStatus::Ready {
                issue_creation_time_runtime_token(&state, &record).await;
            }

            let status_text = match record.status {
                WorkspaceStatus::Creating => "creating",
                WorkspaceStatus::Ready => "ready",
                WorkspaceStatus::Failed => "failed",
            };
            success(
                StatusCode::OK,
                CreateWorkspaceData {
                    workspace_id: record.workspace_id,
                    status: status_text,
                    container_name: record.container_name,
                },
            )
        }
        Err(err @ CreateWorkspaceError::Store(_)) => {
            eprintln!("rust_gateway: create_workspace store error: {err}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_store_failed",
                "failed to record workspace request",
            )
        }
        Err(err @ CreateWorkspaceError::Container(_)) => {
            eprintln!("rust_gateway: create_workspace container error: {err}");
            error(
                StatusCode::BAD_GATEWAY,
                "workspace_launch_failed",
                "failed to launch workspace container",
            )
        }
    }
}

/// Mint and deliver this workspace's `/run/hermes/integrations.token` at
/// CREATION time, before any real OpenConnector connect ever happens.
///
/// Real motivating bug: the `open_browser`/`close_browser`/`browser_task`
/// stdio MCP tools (`backend/seeder/tools/`) read this SAME file and fail
/// outright (`[Errno 2] No such file or directory`) on any workspace with
/// zero integrations connected, since before this the file was only ever
/// delivered by a real `connect_integration_route` call
/// (`integrations::route::finish_connection` → `rotate_workspace_token`).
///
/// Security-critical design: this must NEVER call
/// `issue_and_deliver_runtime_token` with an EMPTY `allowed_connection_ids`.
/// OpenConnector's own `ActionPolicySnapshot.evaluateConnection` (real,
/// vendored source — see `open-connector/src/core/action-policy.ts`)
/// treats an empty allow-list as "no restriction" (fail OPEN — allows
/// EVERY connection), not "no access": `allowedConnections.length === 0`
/// short-circuits to `{ allowed: true }` before the id comparison ever
/// runs. Every real OpenConnector authorization path (`mcp.ts`,
/// `proxy-runner.ts`, `action-runner.ts`) relies on this same semantics.
/// This crate's OWN `disconnect_integration_route` already deliberately
/// avoids this trap — it revokes/tears down the token entirely rather
/// than rotating to `&[]` once a workspace's last connection is removed.
///
/// The fix here: mint the token scoped to exactly ONE random UUID v4 —
/// syntactically a plausible connection id, but one that will never
/// match a real OpenConnector connection (see this function's own
/// collision-probability reasoning in the crate's security review; a
/// UUID v4 is not attacker- or caller-influenced in any way, generated
/// fresh via `uuid::Uuid::new_v4()` purely server-side). This forces
/// OpenConnector's `evaluateConnection` onto its NON-empty branch —
/// `connectionId && allowedConnections.includes(connectionId)` — which
/// denies every real connection id by construction, since the sentinel
/// was never registered as a connection at all. The token file exists
/// (unblocking `open_browser`'s presence check) but grants NO real
/// integration access until this workspace's first genuine
/// `connect_integration_route` call rotates it to the real, correctly-
/// scoped connection id list.
///
/// Best-effort by design, NOT a workspace-creation failure: by the time
/// this runs, `record.status` is already `Ready` — a real, running,
/// otherwise fully usable container. Failing the whole HTTP response here
/// would misreport a genuinely successful creation as failed. A failure
/// is logged (`tracing::warn!`, workspace_id only — the bearer itself is
/// never captured in a local variable this function can see, only inside
/// `issue_and_deliver_runtime_token`, and is never part of this error
/// path) and the workspace falls back to the OLD lazy-delivery-on-first-
/// connect behavior: `open_browser` still fails until a real connect
/// happens for THIS one workspace, but nothing else about it breaks.
async fn issue_creation_time_runtime_token(state: &WorkspacesState, record: &WorkspaceRecord) {
    let Some(container_name) = record.container_name.as_deref() else {
        // `Ready` always carries a container_name in practice (see
        // `WorkspaceStore::mark_ready`) — defensive, not reachable via
        // any known path, but a missing container name has nothing to
        // deliver into either way.
        return;
    };

    let sentinel_connection_id = uuid::Uuid::new_v4().to_string();
    if let Err(err) = issue_and_deliver_runtime_token(
        &state.integrations,
        &record.workspace_id,
        container_name,
        std::slice::from_ref(&sentinel_connection_id),
    )
    .await
    {
        tracing::warn!(
            workspace_id = %record.workspace_id,
            error = %err,
            "failed to issue the creation-time integrations runtime token; \
             open_browser/close_browser/browser_task will fail until this \
             workspace's first real integration connect"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::container::FakeLauncher;
    use crate::workspaces::test_support::{body_json, state_with_store, temp_store};

    async fn temp_state() -> Arc<WorkspacesState> {
        state_with_store(temp_store().await, Arc::new(FakeLauncher::default()))
    }

    /// A name whose creation already succeeded (`status: ready`) must be
    /// rejected with 409 + `workspace_name_taken` on a second POST, not
    /// silently handed back as a 200 — see this file's module doc for why.
    #[tokio::test]
    async fn posting_a_name_that_is_already_ready_returns_409_name_taken() {
        let state = temp_state().await;

        let first = create_workspace_route(
            State(state.clone()),
            Json(CreateWorkspaceRequest {
                name: "taken-name".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);
        let first_body = body_json(first).await;
        assert_eq!(first_body["data"]["status"], "ready");

        let second = create_workspace_route(
            State(state),
            Json(CreateWorkspaceRequest {
                name: "taken-name".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(second.status(), StatusCode::CONFLICT);
        let second_body = body_json(second).await;
        assert_eq!(second_body["ok"], false);
        assert_eq!(second_body["error"]["code"], "workspace_name_taken");
    }

    /// A name that is still `creating` (never launched, or a launch
    /// failure was retried and eventually succeeded) must NOT be treated
    /// as a collision — this is the existing idempotent-retry contract
    /// from `workspaces::create_workspace` and must survive the 409 check
    /// added in front of it.
    #[tokio::test]
    async fn posting_a_name_that_previously_failed_still_retries_instead_of_409() {
        let state = state_with_store(
            temp_store().await,
            // Exceeds LaunchRetryPolicy::production()'s 3 in-call attempts so
            // the launch genuinely never succeeds within the first call.
            Arc::new(FakeLauncher::that_fails_first(3)),
        );

        let first = create_workspace_route(
            State(state.clone()),
            Json(CreateWorkspaceRequest {
                name: "retry-name".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(first.status(), StatusCode::BAD_GATEWAY);

        let retry = create_workspace_route(
            State(state),
            Json(CreateWorkspaceRequest {
                name: "retry-name".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(
            retry.status(),
            StatusCode::OK,
            "a name stuck at 'failed' must retry, not 409"
        );
        let retry_body = body_json(retry).await;
        assert_eq!(retry_body["data"]["status"], "ready");
    }

    #[tokio::test]
    async fn empty_name_returns_400_with_error_envelope() {
        let state = temp_state().await;
        let response = create_workspace_route(
            State(state),
            Json(CreateWorkspaceRequest {
                name: "   ".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "workspace_name_required");
    }

    // ---- Creation-time integrations runtime token (sentinel UUID) ----

    use crate::integrations::openconnector::fake::FakeOpenConnector;
    use crate::integrations::{IntegrationStore, IntegrationsState};

    fn temp_pool() -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect_lazy("sqlite::memory:").expect("open in-memory sqlite pool")
    }

    /// Build a `WorkspacesState` wired to the GIVEN `FakeOpenConnector`
    /// (not `test_support::state_with_store`'s default one) — every test
    /// in this section needs to inspect that exact fake's
    /// `create_runtime_token_calls()` spy afterward.
    fn state_with_integrations(
        store: crate::workspaces::WorkspaceStore,
        launcher: Arc<dyn crate::workspaces::ContainerLauncher>,
        openconnector: Arc<FakeOpenConnector>,
    ) -> Arc<WorkspacesState> {
        let pool = temp_pool();
        Arc::new(WorkspacesState {
            store,
            launcher,
            http_client: reqwest::Client::new(),
            integrations: Arc::new(IntegrationsState {
                store: IntegrationStore::new(pool.clone()),
                openconnector,
                providers: Vec::new(),
                workspace_store: crate::workspaces::WorkspaceStore::new(pool),
                http_client: reqwest::Client::new(),
                token_cipher: crate::crypto::TokenCipher::new(&[3u8; 32]),
                mcp_bearer_lockout: Default::default(),
                catalog_cache: Default::default(),
            }),
        })
    }

    /// The core new behavior: creating a workspace must issue a runtime
    /// token — `create_runtime_token` must actually be called — without
    /// waiting for any real OpenConnector connect. Proves the call
    /// happened at all; the next test proves WHAT it was called with.
    #[tokio::test]
    async fn creating_a_workspace_issues_a_runtime_token_for_its_real_container_name() {
        let fake = Arc::new(FakeOpenConnector::default());
        let state = state_with_integrations(
            temp_store().await,
            Arc::new(FakeLauncher::default()),
            fake.clone(),
        );

        let response = create_workspace_route(
            State(state),
            Json(CreateWorkspaceRequest {
                name: "ws-creation-token".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["data"]["status"], "ready");

        let calls = fake.create_runtime_token_calls();
        assert_eq!(
            calls.len(),
            1,
            "workspace creation must issue exactly one runtime token up front, \
             not wait for a real connect"
        );
        assert_eq!(
            calls[0].0,
            format!("workspace:{}", body["data"]["workspace_id"].as_str().unwrap()),
            "the token must be named for the real created workspace_id"
        );
    }

    /// The security-critical assertion: the creation-time token must be
    /// scoped to exactly ONE random sentinel connection id — NEVER an
    /// empty `allowed_connection_ids` slice, which OpenConnector's real
    /// `evaluateConnection` treats as "no restriction" (fail OPEN, allows
    /// every connection) rather than "no access" — see this file's
    /// `issue_creation_time_runtime_token` doc comment for the full
    /// citation against the vendored OpenConnector source.
    #[tokio::test]
    async fn creation_time_token_is_scoped_to_one_sentinel_id_never_an_empty_list() {
        let fake = Arc::new(FakeOpenConnector::default());
        let state = state_with_integrations(
            temp_store().await,
            Arc::new(FakeLauncher::default()),
            fake.clone(),
        );

        let _ = create_workspace_route(
            State(state),
            Json(CreateWorkspaceRequest {
                name: "ws-sentinel".to_string(),
                password: None,
            }),
        )
        .await;

        let calls = fake.create_runtime_token_calls();
        assert_eq!(calls.len(), 1);
        let allowed_connection_ids = &calls[0].1;
        assert_eq!(
            allowed_connection_ids.len(),
            1,
            "must be scoped to exactly one sentinel id, never empty (fail-open) \
             and never more than the one sentinel: got {allowed_connection_ids:?}"
        );
        assert!(
            uuid::Uuid::parse_str(&allowed_connection_ids[0]).is_ok(),
            "the sentinel must be a real UUID, not a guessable/fixed placeholder \
             string: got {:?}",
            allowed_connection_ids[0]
        );
    }

    /// Two different workspace creations must each get their OWN fresh
    /// random sentinel — proves this isn't a single hardcoded constant
    /// that every workspace would share (which would make the "sentinel"
    /// pointless: a fixed string checked into source is guessable).
    #[tokio::test]
    async fn each_workspace_creation_gets_a_distinct_random_sentinel() {
        let fake = Arc::new(FakeOpenConnector::default());
        let state = state_with_integrations(
            temp_store().await,
            Arc::new(FakeLauncher::default()),
            fake.clone(),
        );

        for name in ["ws-sentinel-a", "ws-sentinel-b"] {
            let _ = create_workspace_route(
                State(state.clone()),
                Json(CreateWorkspaceRequest {
                    name: name.to_string(),
                    password: None,
                }),
            )
            .await;
        }

        let calls = fake.create_runtime_token_calls();
        assert_eq!(calls.len(), 2);
        assert_ne!(
            calls[0].1[0], calls[1].1[0],
            "each workspace's sentinel must be independently random, not shared"
        );
    }

    /// Failure-handling decision (step 4): a token-issuance failure after
    /// the workspace is already `Ready` must NOT turn workspace creation
    /// into a failure response — the container genuinely exists and is
    /// usable for everything except integrations/browser tools. Forcing
    /// `create_runtime_token` itself to fail (rather than relying on
    /// `deliver_token_file`'s always-fails-in-tests behavior) isolates
    /// this assertion to the failure-handling behavior alone.
    #[tokio::test]
    async fn creation_still_reports_ready_even_when_token_issuance_fails() {
        let fake = Arc::new(FakeOpenConnector::that_fails_create_runtime_token());
        let state = state_with_integrations(
            temp_store().await,
            Arc::new(FakeLauncher::default()),
            fake.clone(),
        );

        let response = create_workspace_route(
            State(state),
            Json(CreateWorkspaceRequest {
                name: "ws-token-fails".to_string(),
                password: None,
            }),
        )
        .await;

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "a failed token issuance must not fail an otherwise-successful workspace creation"
        );
        let body = body_json(response).await;
        assert_eq!(
            body["data"]["status"], "ready",
            "the workspace itself is genuinely Ready (container up) regardless of \
             whether the best-effort token step succeeded"
        );
        assert!(
            body["data"]["container_name"].is_string(),
            "the real container_name must still be reported"
        );
    }

    /// A workspace creation that never reaches `Ready` (launch keeps
    /// failing) must not attempt to issue a token at all — there is no
    /// container to deliver into yet, and the eventual retry that DOES
    /// reach `Ready` is what issues it (see the next test).
    #[tokio::test]
    async fn a_still_creating_or_failed_workspace_never_attempts_token_issuance() {
        let fake = Arc::new(FakeOpenConnector::default());
        let state = state_with_integrations(
            temp_store().await,
            // Exceeds LaunchRetryPolicy::production()'s 3 in-call attempts.
            Arc::new(FakeLauncher::that_fails_first(3)),
            fake.clone(),
        );

        let response = create_workspace_route(
            State(state),
            Json(CreateWorkspaceRequest {
                name: "ws-never-ready".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(
            fake.create_runtime_token_calls().is_empty(),
            "a workspace that never became Ready must never attempt token issuance"
        );
    }
}
