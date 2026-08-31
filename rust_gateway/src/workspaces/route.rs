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
//! The workspace `name` doubles as the idempotency key: two requests for
//! the same name are treated as the same logical creation attempt, so a
//! page refresh or a client retry never creates a second container. See
//! ../../docs/create-workspace-plan.md for why, and the migration comment
//! in ../../migrations/0001_workspace_creations.sql for the schema this
//! relies on.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::{create_workspace, ContainerLauncher, CreateWorkspaceError, WorkspaceStatus, WorkspaceStore};

pub struct WorkspacesState {
    pub store: WorkspaceStore,
    pub launcher: Arc<dyn ContainerLauncher>,
}

#[derive(Deserialize)]
pub struct CreateWorkspaceRequest {
    pub name: String,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Serialize)]
struct CreateWorkspaceResponse {
    workspace_id: String,
    status: &'static str,
    container_name: Option<String>,
}

/// POST /workspaces
///
/// Body: `{ "name": "my-workspace", "password": "optional" }`. `name` is
/// required and doubles as the idempotency key (see module docs). Hitting
/// this endpoint with a name that was already requested returns the
/// existing (or in-progress, or now-retried) workspace instead of creating
/// a second container.
pub async fn create_workspace_route(
    State(state): State<Arc<WorkspacesState>>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> Response {
    let name = request.name.trim();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    }

    // `password` is accepted (matching the existing frontend contract) but
    // not yet used by anything — auth for workspace containers is not
    // built yet. Accepting and silently ignoring it here, rather than
    // rejecting requests that include it, keeps the existing frontend
    // working unmodified against this route.
    let _password = request.password;

    match create_workspace(&state.store, state.launcher.as_ref(), name).await {
        Ok(record) => {
            let status_text = match record.status {
                WorkspaceStatus::Creating => "creating",
                WorkspaceStatus::Ready => "ready",
                WorkspaceStatus::Failed => "failed",
            };
            (
                StatusCode::OK,
                Json(CreateWorkspaceResponse {
                    workspace_id: record.workspace_id,
                    status: status_text,
                    container_name: record.container_name,
                }),
            )
                .into_response()
        }
        Err(err @ CreateWorkspaceError::Store(_)) => {
            eprintln!("rust_gateway: create_workspace store error: {err}");
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to record workspace request")
                .into_response()
        }
        Err(err @ CreateWorkspaceError::Container(_)) => {
            eprintln!("rust_gateway: create_workspace container error: {err}");
            (StatusCode::BAD_GATEWAY, "failed to launch workspace container").into_response()
        }
    }
}
