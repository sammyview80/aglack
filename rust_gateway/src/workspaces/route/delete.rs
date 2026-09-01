use axum::{extract::Path, extract::State, http::StatusCode, response::Response};
use serde::Serialize;
use std::sync::Arc;

use super::WorkspacesState;
use crate::response::{error, success};
use crate::workspaces::{delete_workspace, CreateWorkspaceError};

#[derive(Serialize)]
struct DeleteWorkspaceData {
    workspace_id: String,
}

/// DELETE /workspaces/:id
///
/// Stops the workspace container (if one exists) and drops the store row.
/// Unknown id → `404 workspace_not_found`. Docker remove failure →
/// `502 workspace_delete_failed` and the row is left so the caller can
/// retry. A workspace that never launched a container (failed/creating)
/// still deletes the row.
pub async fn delete_workspace_route(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
) -> Response {
    match delete_workspace(&state.store, state.launcher.as_ref(), &workspace_id).await {
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "workspace_not_found",
            format!("no workspace with id {workspace_id:?}"),
        ),
        Ok(Some(record)) => success(
            StatusCode::OK,
            DeleteWorkspaceData {
                workspace_id: record.workspace_id,
            },
        ),
        Err(err @ CreateWorkspaceError::Store(_)) => {
            eprintln!("rust_gateway: delete_workspace store error: {err}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_store_failed",
                "failed to delete workspace",
            )
        }
        Err(err @ CreateWorkspaceError::Container(_)) => {
            eprintln!("rust_gateway: delete_workspace container error: {err}");
            error(
                StatusCode::BAD_GATEWAY,
                "workspace_delete_failed",
                "failed to remove workspace container",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::container::FakeLauncher;
    use crate::workspaces::route::create::{create_workspace_route, CreateWorkspaceRequest};
    use crate::workspaces::route::list::{list_workspaces_route, ListWorkspacesQuery};
    use crate::workspaces::test_support::{body_json, state_with_store, temp_store};
    use axum::extract::Query;
    use axum::Json;

    async fn temp_state() -> Arc<WorkspacesState> {
        state_with_store(temp_store().await, Arc::new(FakeLauncher::default()))
    }

    #[tokio::test]
    async fn deleting_unknown_workspace_returns_404_not_found() {
        let state = temp_state().await;
        let response =
            delete_workspace_route(State(state), Path("does-not-exist".to_string())).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "workspace_not_found");
    }

    #[tokio::test]
    async fn deleting_a_ready_workspace_returns_its_id_and_empties_the_list() {
        let state = temp_state().await;
        let created = create_workspace_route(
            State(state.clone()),
            Json(CreateWorkspaceRequest {
                name: "delete-me".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let created_body = body_json(created).await;
        let workspace_id = created_body["data"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();

        let deleted =
            delete_workspace_route(State(state.clone()), Path(workspace_id.clone())).await;
        assert_eq!(deleted.status(), StatusCode::OK);
        let deleted_body = body_json(deleted).await;
        assert_eq!(deleted_body["ok"], true);
        assert_eq!(deleted_body["data"]["workspace_id"], workspace_id);

        let listed = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: None,
            }),
        )
        .await;
        let listed_body = body_json(listed).await;
        assert_eq!(listed_body["data"]["workspaces"], serde_json::json!([]));
    }
}
