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

/// Upper bound on `limit`, enforced regardless of what a caller requests —
/// see `../../../docs/list-workspaces-plan.md`: without this, `?limit=100000`
/// could force one query to scan/return the entire table.
const MAX_LIST_LIMIT: i64 = 200;

/// Per-workspace timeout for the live health check `list_workspaces_route`
/// runs against every `Ready` row — see
/// `../../../docs/list-workspaces-plan.md`'s "Live health check" section.
/// Long enough for a genuinely healthy wrapper's ordinary response, short
/// enough that one hung container cannot noticeably stall the whole list
/// request (all rows are checked CONCURRENTLY, so the request's total
/// added latency is bounded by this one constant, not by
/// `rows_checked * timeout`).
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(2);

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
    /// Live result of checking this row's wrapper RIGHT NOW — NOT derived
    /// from `status`. `false` for every `creating`/`failed` row (nothing
    /// to check yet) and for a `ready` row whose live check just failed
    /// (crashed/hung container since it was marked ready). `true` only
    /// when a `ready` row's check just succeeded. See
    /// `../../../docs/list-workspaces-plan.md`.
    healthy: bool,
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
/// One SQL query, but NOT a pure DB projection: every `Ready` row's
/// wrapper is health-checked live, right now, concurrently — see
/// `../../../docs/list-workspaces-plan.md`'s "Live health check" section for
/// why and its cost tradeoffs. `Creating`/`Failed` rows are never
/// checked (no port to check).
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
            let workspaces = check_health_and_build_list_items(&state.http_client, items).await;
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

/// Run every `Ready` item's live health check CONCURRENTLY (one
/// `tokio::task::JoinSet` task per item, not a sequential loop — see
/// `HEALTH_CHECK_TIMEOUT`'s doc comment for why this matters), then
/// assemble the final response items in the SAME order `items` came in
/// (the store's `ORDER BY`, not task-completion order — a caller paging
/// through results must see a stable order regardless of which
/// container happened to answer its health check fastest).
async fn check_health_and_build_list_items(
    client: &reqwest::Client,
    items: Vec<WorkspaceListItem>,
) -> Vec<WorkspaceListItemData> {
    let mut checks = tokio::task::JoinSet::new();
    for (index, item) in items.iter().enumerate() {
        // Every other combination (not `Ready`, or — should be
        // unreachable per `mark_ready`'s invariant, but handled anyway,
        // failing closed — `Ready` with no recorded port) has nothing to
        // check, so no task is spawned for it; it keeps its `false`
        // default in `healthy_by_index` below.
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

    let mut healthy_by_index = vec![false; items.len()];
    while let Some(result) = checks.join_next().await {
        // A task can only fail to join on panic — `check_wrapper_health`
        // has no panicking path, but failing closed (leaving that row
        // `false`) rather than unwrapping is still correct if it ever did.
        if let Ok((index, healthy)) = result {
            healthy_by_index[index] = healthy;
        }
    }

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
            Arc::new(FakeLauncher::that_fails_first(1)),
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
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["data"]["limit"], MAX_LIST_LIMIT);
    }
}
