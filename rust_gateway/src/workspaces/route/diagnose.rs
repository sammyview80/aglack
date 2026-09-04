use axum::{extract::Path, extract::State, http::StatusCode, response::Response};
use serde::Serialize;
use std::sync::Arc;

use super::WorkspacesState;
use crate::response::{error, success};
use crate::workspaces::diagnosis::{
    diagnose_workspace, DiagnoseWorkspaceError, DiagnosisAction, DiagnosisSnapshot,
    DiagnosisTimeouts,
};

#[derive(Serialize)]
struct DiagnosisSnapshotData {
    container_running: bool,
    container_exit_code: Option<i64>,
    container_oom_killed: bool,
    wrapper_healthy: bool,
    desktop_healthy: bool,
}

impl From<DiagnosisSnapshot> for DiagnosisSnapshotData {
    fn from(snapshot: DiagnosisSnapshot) -> Self {
        Self {
            container_running: snapshot.container_running,
            container_exit_code: snapshot.container_exit_code,
            container_oom_killed: snapshot.container_oom_killed,
            wrapper_healthy: snapshot.wrapper_healthy,
            desktop_healthy: snapshot.desktop_healthy,
        }
    }
}

#[derive(Serialize)]
struct DiagnosisReportData {
    workspace_id: String,
    before: DiagnosisSnapshotData,
    action: &'static str,
    after: Option<DiagnosisSnapshotData>,
}

/// POST /workspaces/:id/diagnose
///
/// Real, live diagnosis of a workspace's container — Docker state
/// (running/exit code/OOM-killed) plus live wrapper/desktop health
/// checks. If unhealthy, runs a real stop-then-start recovery cycle and
/// re-checks before responding. See
/// `../../../docs/diagnose-workspace-plan.md` for the full behavior.
///
/// A POST, not a GET: this can mutate real infrastructure (stop/start a
/// container) — see the plan doc's opening section for why that rules
/// out GET here.
///
/// Unknown id → `404 workspace_not_found`. A workspace that has never
/// had a container (still `creating` with nothing launched yet, or
/// `failed` before any container existed) → `409 workspace_no_container`
/// — there is nothing to diagnose. A real Docker/store error during the
/// diagnosis itself (not the heal cycle, which reports its own failure
/// as `action: "restart_failed"` inside a normal `200`) →
/// `500 workspace_diagnosis_failed`.
pub async fn diagnose_workspace_route(
    State(state): State<Arc<WorkspacesState>>,
    Path(workspace_id): Path<String>,
) -> Response {
    match diagnose_workspace(
        &state.store,
        state.launcher.as_ref(),
        &state.http_client,
        &workspace_id,
        DiagnosisTimeouts::production(),
    )
    .await
    {
        Ok(report) => {
            let action = match report.action {
                DiagnosisAction::None => "none",
                DiagnosisAction::Restarted => "restarted",
                DiagnosisAction::RestartFailed => "restart_failed",
            };
            success(
                StatusCode::OK,
                DiagnosisReportData {
                    workspace_id,
                    before: report.before.into(),
                    action,
                    after: report.after.map(Into::into),
                },
            )
        }
        Err(DiagnoseWorkspaceError::NotFound) => error(
            StatusCode::NOT_FOUND,
            "workspace_not_found",
            format!("no workspace with id {workspace_id:?}"),
        ),
        Err(DiagnoseWorkspaceError::NoContainer) => error(
            StatusCode::CONFLICT,
            "workspace_no_container",
            format!("workspace {workspace_id:?} has no container to diagnose yet"),
        ),
        Err(DiagnoseWorkspaceError::Other(err)) => {
            eprintln!("rust_gateway: diagnose_workspace error for {workspace_id:?}: {err}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_diagnosis_failed",
                "failed to diagnose workspace",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::container::FakeLauncher;
    use crate::workspaces::route::create::{create_workspace_route, CreateWorkspaceRequest};
    use crate::workspaces::test_support::{body_json, state_with_store, temp_store};
    use axum::Json;

    async fn temp_state() -> Arc<WorkspacesState> {
        state_with_store(temp_store().await, Arc::new(FakeLauncher::default()))
    }

    #[tokio::test]
    async fn diagnosing_unknown_workspace_returns_404_not_found() {
        let state = temp_state().await;
        let response =
            diagnose_workspace_route(State(state), Path("does-not-exist".to_string())).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_found");
    }

    /// A workspace that never launched a container (a `failed` attempt
    /// with no `container_name` — see `mod.rs`'s
    /// `launch_and_record`) has nothing for a diagnosis to inspect.
    #[tokio::test]
    async fn diagnosing_a_workspace_with_no_container_returns_409() {
        let state = state_with_store(
            temp_store().await,
            // Exceeds LaunchRetryPolicy::production()'s 3 in-call attempts so
            // the launch genuinely never succeeds, matching this test's
            // "no container ever existed" premise.
            Arc::new(FakeLauncher::that_fails_first(3)),
        );
        let created = create_workspace_route(
            State(state.clone()),
            Json(CreateWorkspaceRequest {
                name: "never-launched".to_string(),
                password: None,
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::BAD_GATEWAY);
        let created_body = body_json(created).await;
        // The route only returns workspace_id on success; look the
        // workspace up by name instead to get its id for the diagnosis
        // call below.
        assert_eq!(created_body["error"]["code"], "workspace_launch_failed");

        let record = state
            .store
            .find("never-launched")
            .await
            .expect("lookup succeeds")
            .expect("row exists after failed launch");

        let response = diagnose_workspace_route(State(state), Path(record.workspace_id)).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_no_container");
    }

    /// End-to-end through the HTTP route: a healthy `Ready` workspace
    /// must come back as `action: "none"` with a real `before` shape in
    /// the JSON response — proves the route wires
    /// `diagnose_workspace`'s real result into the shared envelope
    /// correctly. Deliberately the HEALTHY path, not the unhealthy/
    /// restart path: this route always runs with
    /// `DiagnosisTimeouts::production()` (30s/15s post-restart waits, as
    /// it must for real behavior — see the route's own doc comment), so
    /// a route-level test of the restart path would genuinely wait tens
    /// of real seconds. The restart path's actual logic (stop+start,
    /// re-check, store update) is already fully covered, fast, by
    /// `diagnosis.rs`'s own tests using injectable short timeouts.
    #[tokio::test]
    async fn diagnosing_a_healthy_ready_workspace_reports_action_none() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        async fn serve_ok(listener: TcpListener) {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
            }
        }

        let wrapper_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let wrapper_port = wrapper_listener.local_addr().unwrap().port();
        tokio::spawn(serve_ok(wrapper_listener));
        let desktop_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let desktop_port = desktop_listener.local_addr().unwrap().port();
        tokio::spawn(serve_ok(desktop_listener));

        let store = temp_store().await;
        store
            .begin_creation("healthy-ws", "id-healthy")
            .await
            .expect("begin_creation succeeds");
        store
            .mark_ready(
                "healthy-ws",
                "container-1",
                wrapper_port,
                desktop_port,
                desktop_port,
            )
            .await
            .expect("mark_ready succeeds");
        let launcher = FakeLauncher::that_reports(crate::workspaces::container::ContainerState {
            running: true,
            exit_code: None,
            oom_killed: false,
        });
        let state = state_with_store(store, Arc::new(launcher));

        let response = diagnose_workspace_route(State(state), Path("id-healthy".to_string())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["data"]["before"]["container_running"], true);
        assert_eq!(body["data"]["before"]["wrapper_healthy"], true);
        assert_eq!(body["data"]["before"]["desktop_healthy"], true);
        assert_eq!(body["data"]["action"], "none");
        assert!(body["data"]["after"].is_null());
    }
}
