//! HTTP handler for POST /workspaces. Translates the HTTP request/response
//! shape into a call to `create_workspace` — no idempotency or container
//! logic lives here, only translation. See ../../docs/create-workspace-plan.md.
//!
//! Request/response shape matches the existing frontend contract (see
//! frontend/src/onboarding/CreateWorkspace.tsx's `CreateWorkspaceInput` and
//! frontend/src/api/client.ts's `createInstall`): `{ name, password? }`.
//! `password` is genuinely optional there already (an empty field is
//! omitted from the request, never sent as `""`) — this route keeps that
//! contract rather than requiring it.
//!
//! The workspace `name` doubles as the idempotency key, but only while a
//! creation is still in flight or previously failed: a request for a name
//! whose creation already finished (`status: ready`) is a name COLLISION,
//! not a retry — it is rejected with `409 workspace_name_taken` rather
//! than silently handing back the existing workspace (a caller has no way
//! to tell "you got your own workspace back" from "you got someone else's
//! same-named workspace back" otherwise). A `creating` or `failed` record
//! still retries exactly as before — that distinction has its own
//! regression test in `mod.rs`
//! (`a_key_whose_launch_failed_is_retried_on_the_next_call_with_the_same_key`)
//! and is unaffected by this file's `Ready` check.
//!
//! Every response from this route uses the shared envelope in
//! `crate::response` — `{ ok: true, data }` or
//! `{ ok: false, error: { code, message } }` — so the frontend has one
//! generic parser for both outcomes instead of a bespoke shape per route.

use axum::{extract::State, http::StatusCode, response::Response, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::{create_workspace, ContainerLauncher, CreateWorkspaceError, WorkspaceStatus, WorkspaceStore};
use crate::response::{error, success};

pub struct WorkspacesState {
    pub store: WorkspaceStore,
    pub launcher: Arc<dyn ContainerLauncher>,
    /// Reused HTTP client for forwarding onboarding calls to a specific
    /// workspace's wrapper — see `onboarding_proxy.rs`. Lives here (not a
    /// separate state struct) because that route's only real dependency
    /// besides an HTTP client is this same `store`, for the workspace_id
    /// lookup.
    pub http_client: reqwest::Client,
}

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
pub async fn create_workspace_route(
    State(state): State<Arc<WorkspacesState>>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> Response {
    let name = request.name.trim();
    if name.is_empty() {
        return error(StatusCode::BAD_REQUEST, "workspace_name_required", "name is required");
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_support::{body_json, state_with_store, temp_store};
    use crate::workspaces::container::FakeLauncher;

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
            Arc::new(FakeLauncher::that_fails_first(1)),
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
}
