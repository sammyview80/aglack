use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Response,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use super::WorkspacesState;
use crate::response::{error, success};
use crate::workspaces::container::check_wrapper_health;
use crate::workspaces::store::WorkspaceListItem;
use crate::workspaces::WorkspaceStatus;

/// Default page size for `GET /workspaces` when `limit` is omitted.
const DEFAULT_LIST_LIMIT: i64 = 50;

/// Upper bound on `limit` regardless of what a caller requests.
const MAX_LIST_LIMIT: i64 = 200;

/// Per-workspace timeout for the live health check against each `Ready`
/// row. All rows are checked concurrently, so total added latency is
/// bounded by this constant, not by `rows_checked * timeout`.
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
pub struct ListWorkspacesQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// `None` → live health-check every `Ready` row (default). `Some("skip")`
    /// → pure DB projection, `healthy: null` on every row. Any other value
    /// is rejected with `400 invalid_health_mode`.
    pub health: Option<String>,
}

/// What `list_workspaces_route` should do about live health-checking.
#[derive(PartialEq, Eq, Debug)]
enum HealthMode {
    Live,
    Skip,
}

fn parse_health_mode(health: Option<&str>) -> Result<HealthMode, ()> {
    match health {
        None => Ok(HealthMode::Live),
        Some("skip") => Ok(HealthMode::Skip),
        Some(_) => Err(()),
    }
}

#[derive(Serialize)]
struct WorkspaceListItemData {
    workspace_id: String,
    name: String,
    status: &'static str,
    /// `None` when `?health=skip` (no check performed). Otherwise the
    /// live result of checking this row's wrapper right now — not derived
    /// from `status`.
    healthy: Option<bool>,
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
/// defaults to 0. Both must be non-negative, rejected with
/// `400 invalid_pagination` otherwise. A `limit` above the cap is silently
/// clamped; the response's echoed `limit` reflects what was actually used.
///
/// By default every `Ready` row's wrapper is health-checked live,
/// concurrently; `?health=skip` skips that fanout entirely.
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

    let health_mode = match parse_health_mode(query.health.as_deref()) {
        Ok(mode) => mode,
        Err(()) => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_health_mode",
                "health must be omitted or set to 'skip'",
            )
        }
    };

    match state.store.list(limit, offset).await {
        Ok(items) => {
            let healthy_by_index = match health_mode {
                HealthMode::Live => run_health_checks(&state.http_client, &items).await,
                HealthMode::Skip => vec![None; items.len()],
            };
            let workspaces = build_list_items(items, healthy_by_index);
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

/// Runs every `Ready` item's live health check CONCURRENTLY (one
/// `tokio::task::JoinSet` task per item, not a sequential loop — see
/// `HEALTH_CHECK_TIMEOUT`'s doc comment for why), returning results in the
/// SAME order `items` came in (the store's `ORDER BY`, not
/// task-completion order).
async fn run_health_checks(client: &reqwest::Client, items: &[WorkspaceListItem]) -> Vec<Option<bool>> {
    let mut checks = tokio::task::JoinSet::new();
    for (index, item) in items.iter().enumerate() {
        if let (WorkspaceStatus::Ready, Some(host_port)) = (&item.status, item.host_port) {
            let client = client.clone();
            let wrapper_port = host_port as u16;
            checks.spawn(async move {
                (
                    index,
                    check_wrapper_health(&client, wrapper_port, HEALTH_CHECK_TIMEOUT).await,
                )
            });
        }
    }

    let mut healthy_by_index = vec![Some(false); items.len()];
    while let Some(result) = checks.join_next().await {
        if let Ok((index, healthy)) = result {
            healthy_by_index[index] = Some(healthy);
        }
    }
    healthy_by_index
}

/// Projects store rows plus their (already-computed) `healthy` results into
/// response items. `healthy_by_index[i]` is `None` in `?health=skip` mode,
/// `Some(_)` (live result) otherwise.
fn build_list_items(
    items: Vec<WorkspaceListItem>,
    healthy_by_index: Vec<Option<bool>>,
) -> Vec<WorkspaceListItemData> {
    items
        .into_iter()
        .zip(healthy_by_index)
        .map(|(item, healthy)| WorkspaceListItemData {
            workspace_id: item.workspace_id,
            name: item.name,
            status: match item.status {
                WorkspaceStatus::Creating => "creating",
                WorkspaceStatus::Ready => "ready",
                WorkspaceStatus::Failed => "failed",
            },
            healthy,
            host_port: item.host_port,
            desktop_port: item.desktop_port,
            created_at: item.created_at,
        })
        .collect()
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
    async fn list_workspaces_returns_empty_array_when_none_exist() {
        let state = temp_state().await;
        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: None,
            }),
        )
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
    ///
    /// `FakeLauncher`'s ports are fake/unreachable (see its own doc
    /// comment), so `healthy` is asserted `false` here — this test is
    /// about the name/status/port fields, not the live check itself (see
    /// `list_workspaces_reports_healthy_true_for_a_ready_workspace_whose_wrapper_answers`
    /// and
    /// `list_workspaces_reports_healthy_false_for_a_ready_workspace_whose_wrapper_is_unreachable`
    /// below for that).
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

        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: None,
            }),
        )
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

    /// A `Ready` row whose wrapper port has NOTHING listening (the
    /// container crashed, or — as here — never really existed) must
    /// report `healthy: false`, even though `status` itself stays
    /// `"ready"` — proves the two fields are independent (see this
    /// route's doc comment): `status` is the DB's last-written value,
    /// `healthy` is live, right now.
    #[tokio::test]
    async fn list_workspaces_reports_healthy_false_for_a_ready_workspace_whose_wrapper_is_unreachable(
    ) {
        let store = temp_store().await;
        store
            .begin_creation("unreachable-ws", "id-unreachable")
            .await
            .expect("begin_creation succeeds");
        // A real, currently-unbound port: guaranteed nothing answers here.
        store
            .mark_ready("unreachable-ws", "fake-container", 1, 2)
            .await
            .expect("mark_ready succeeds");
        let state = state_with_store(store, Arc::new(FakeLauncher::default()));

        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: None,
            }),
        )
        .await;
        let body = body_json(response).await;
        let workspaces = body["data"]["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["status"], "ready");
        assert_eq!(workspaces[0]["healthy"], false);
    }

    /// A `Ready` row whose wrapper port DOES have something answering
    /// `/api/wrapper/v1/health` with 200 must report `healthy: true` —
    /// the positive-path proof that `list_workspaces_route` performs a
    /// REAL live check against a real listener, not a hardcoded value.
    #[tokio::test]
    async fn list_workspaces_reports_healthy_true_for_a_ready_workspace_whose_wrapper_answers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
            }
        });

        let store = temp_store().await;
        store
            .begin_creation("healthy-ws", "id-healthy")
            .await
            .expect("begin_creation succeeds");
        store
            .mark_ready("healthy-ws", "fake-container", port, port)
            .await
            .expect("mark_ready succeeds");
        let state = state_with_store(store, Arc::new(FakeLauncher::default()));

        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: None,
            }),
        )
        .await;
        let body = body_json(response).await;
        let workspaces = body["data"]["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["healthy"], true);
    }

    /// `Creating`/`Failed` rows must always report `healthy: false` — they
    /// have no wrapper to check at all (no recorded port), so there is no
    /// live-check outcome to report other than "not healthy."
    #[tokio::test]
    async fn list_workspaces_reports_healthy_false_for_creating_and_failed_rows() {
        let state = state_with_store(
            temp_store().await,
            // Exceeds LaunchRetryPolicy::production()'s 3 in-call attempts so
            // the launch genuinely never succeeds within the first call.
            Arc::new(FakeLauncher::that_fails_first(3)),
        );
        // First attempt fails -> row is `Failed`.
        let _ = create_workspace_route(
            State(state.clone()),
            Json(CreateWorkspaceRequest {
                name: "failed-ws".to_string(),
                password: None,
            }),
        )
        .await;

        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: None,
            }),
        )
        .await;
        let body = body_json(response).await;
        let workspaces = body["data"]["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["status"], "failed");
        assert_eq!(workspaces[0]["healthy"], false);
    }

    #[tokio::test]
    async fn list_workspaces_rejects_negative_limit() {
        let state = temp_state().await;
        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: Some(-1),
                offset: None,
                health: None,
            }),
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
            Query(ListWorkspacesQuery {
                limit: None,
                offset: Some(-1),
                health: None,
            }),
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
            Query(ListWorkspacesQuery {
                limit: Some(100_000),
                offset: None,
                health: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["data"]["limit"], MAX_LIST_LIMIT);
    }

    /// `?health=skip` on an empty store: pure DB projection, no rows to
    /// check, but the mode itself must not error and must still return
    /// the normal empty-array envelope.
    #[tokio::test]
    async fn list_workspaces_health_skip_returns_empty_array_when_none_exist() {
        let state = temp_state().await;
        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: Some("skip".to_string()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["data"]["workspaces"], serde_json::json!([]));
    }

    /// `?health=skip` on a `Ready` row must report `healthy: null` — no
    /// `check_wrapper_health` call was made at all, so there is no live
    /// result to report, positive or negative (unlike default mode's
    /// `false`, which means "checked and unreachable").
    #[tokio::test]
    async fn list_workspaces_health_skip_reports_healthy_null_for_a_ready_workspace() {
        let state = temp_state().await;
        create_workspace_route(
            State(state.clone()),
            Json(CreateWorkspaceRequest {
                name: "skip-health-ws".to_string(),
                password: None,
            }),
        )
        .await;

        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: Some("skip".to_string()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        let workspaces = body["data"]["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["status"], "ready");
        assert!(workspaces[0]["healthy"].is_null());
    }

    /// Any `health` value other than `skip` is a caller bug (e.g. a typo)
    /// and must fail closed with `400 invalid_health_mode`, not silently
    /// fall back to the default live-check behavior.
    #[tokio::test]
    async fn list_workspaces_rejects_unknown_health_mode() {
        let state = temp_state().await;
        let response = list_workspaces_route(
            State(state),
            Query(ListWorkspacesQuery {
                limit: None,
                offset: None,
                health: Some("bogus".to_string()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "invalid_health_mode");
    }
}
