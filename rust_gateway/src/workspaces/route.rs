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

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::{
    create_workspace, ContainerLauncher, CreateWorkspaceError, WorkspaceStatus, WorkspaceStore,
};
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

/// Default page size for `GET /workspaces` when `limit` is omitted.
const DEFAULT_LIST_LIMIT: i64 = 50;

/// Upper bound on `limit`, enforced regardless of what a caller requests —
/// see `../../docs/list-workspaces-plan.md`: without this, `?limit=100000`
/// could force one query to scan/return the entire table.
const MAX_LIST_LIMIT: i64 = 200;

#[derive(Deserialize)]
pub struct ListWorkspacesQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize)]
struct WorkspaceListItemData {
    workspace_id: String,
    name: String,
    status: &'static str,
    host_port: Option<i64>,
    desktop_port: Option<i64>,
    created_at: String,
}

#[derive(Serialize)]
struct ListWorkspacesData {
    workspaces: Vec<WorkspaceListItemData>,
    limit: i64,
    offset: i64,
}

/// GET /workspaces
///
/// Optional `?limit=<n>&offset=<n>` query params. `limit` defaults to
/// `DEFAULT_LIST_LIMIT` and is capped at `MAX_LIST_LIMIT`; `offset`
/// defaults to 0. Both must be non-negative — a negative value is a
/// caller bug, rejected with `400 invalid_pagination` rather than
/// silently clamped (see module/plan doc for why silent clamping is
/// worse). A `limit` above the cap is NOT rejected — it's silently
/// clamped down to `MAX_LIST_LIMIT`, since "you asked for more than we
/// allow" is a normal, expected case, not a caller bug the way a
/// negative number is; the response's echoed `limit` tells the caller
/// what was actually used.
///
/// Pure DB projection — no container/network calls, one SQL query. See
/// `../../docs/list-workspaces-plan.md`.
pub async fn list_workspaces_route(
    State(state): State<Arc<WorkspacesState>>,
    Query(query): Query<ListWorkspacesQuery>,
) -> Response {
    let offset = query.offset.unwrap_or(0);
    if offset < 0 {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_pagination",
            "offset must not be negative",
        );
    }

    let requested_limit = query.limit.unwrap_or(DEFAULT_LIST_LIMIT);
    if requested_limit < 0 {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_pagination",
            "limit must not be negative",
        );
    }
    let limit = requested_limit.min(MAX_LIST_LIMIT);

    match state.store.list(limit, offset).await {
        Ok(items) => {
            let workspaces = items
                .into_iter()
                .map(|item| WorkspaceListItemData {
                    workspace_id: item.workspace_id,
                    name: item.name,
                    status: match item.status {
                        WorkspaceStatus::Creating => "creating",
                        WorkspaceStatus::Ready => "ready",
                        WorkspaceStatus::Failed => "failed",
                    },
                    host_port: item.host_port,
                    desktop_port: item.desktop_port,
                    created_at: item.created_at,
                })
                .collect();
            success(
                StatusCode::OK,
                ListWorkspacesData {
                    workspaces,
                    limit,
                    offset,
                },
            )
        }
        Err(err) => {
            eprintln!("rust_gateway: list_workspaces store error: {err}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_list_failed",
                "failed to list workspaces",
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

    #[tokio::test]
    async fn list_workspaces_returns_empty_array_when_none_exist() {
        let state = temp_state().await;
        let response =
            list_workspaces_route(State(state), Query(ListWorkspacesQuery { limit: None, offset: None }))
                .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["ok"], true);
        assert_eq!(body["data"]["workspaces"], serde_json::json!([]));
        assert_eq!(body["data"]["limit"], DEFAULT_LIST_LIMIT);
        assert_eq!(body["data"]["offset"], 0);
    }

    /// The `idempotency_key`/name distinction must survive all the way out
    /// through the HTTP response, not just in the store layer — see
    /// `store.rs`'s `list_surfaces_idempotency_key_as_name`.
    #[tokio::test]
    async fn list_workspaces_includes_created_workspace_with_name() {
        let state = temp_state().await;
        create_workspace_route(
            State(state.clone()),
            Json(CreateWorkspaceRequest {
                name: "listed-workspace".to_string(),
                password: None,
            }),
        )
        .await;

        let response =
            list_workspaces_route(State(state), Query(ListWorkspacesQuery { limit: None, offset: None }))
                .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        let workspaces = body["data"]["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["name"], "listed-workspace");
        assert_eq!(workspaces[0]["status"], "ready");
        assert!(workspaces[0]["host_port"].is_number());
        assert!(workspaces[0]["desktop_port"].is_number());
    }

    #[tokio::test]
    async fn list_workspaces_rejects_negative_limit() {
        let state = temp_state().await;
        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery { limit: Some(-1), offset: None }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "invalid_pagination");
    }

    #[tokio::test]
    async fn list_workspaces_rejects_negative_offset() {
        let state = temp_state().await;
        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery { limit: None, offset: Some(-1) }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "invalid_pagination");
    }

    /// A `limit` above `MAX_LIST_LIMIT` is clamped, not rejected — the
    /// response's echoed `limit` must reflect what was actually used, not
    /// what was requested (see the route's doc comment for why this case
    /// differs from a negative value).
    #[tokio::test]
    async fn list_workspaces_clamps_limit_above_max() {
        let state = temp_state().await;
        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery { limit: Some(100_000), offset: None }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["data"]["limit"], MAX_LIST_LIMIT);
    }
}
