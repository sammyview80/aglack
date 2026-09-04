//! OpenConnector's FULL provider catalog — browse/search (`GET
//! /integrations/catalog`) and api_key-only connect for ANY catalog
//! service (`POST /workspaces/:id/integrations/catalog/:service/connect`).
//!
//! Deliberately separate from `providers.yaml`'s curated allowlist
//! (`route.rs`/`providers.rs`, unchanged by this module): that list is
//! the ONLY path for OAuth-based connect (OAuth needs a real registered
//! client id/secret this catalog cannot supply), and stays small and
//! curated. This module exists so a user can browse/search/connect (via
//! `api_key` only) any of OpenConnector's ~1451 known services without a
//! pre-registered `Provider` entry — earns its own file (mirroring
//! `mcp_proxy.rs`) because it is a distinct concern: an in-memory cache
//! plus a route that deliberately bypasses `IntegrationsState::find_provider`.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::openconnector::CatalogProvider;
use super::route::{audit, finish_connection, workspace_connection_name, ConnectRequest};
use super::IntegrationsState;
use crate::response::{error, success};
use crate::workspaces::resolve::resolve_ready_workspace;

/// How long a fetched catalog is served from memory before the next
/// request triggers a fresh `GET /api/providers` call. Not a
/// `config.rs`/env-var knob (unlike host/port/URL, which AGENTS.md rule 2
/// requires): this is a cache-freshness tuning value, not a network
/// address, and OpenConnector's provider catalog changes rarely (new
/// integrations shipping, not per-minute churn) — a fixed constant keeps
/// this module's behavior simple and predictable rather than adding a
/// deployment knob nobody asked for. Revisit if a real deployment ever
/// needs a shorter/longer window.
const CATALOG_CACHE_TTL: Duration = Duration::from_secs(15 * 60);

/// In-memory cache for `OpenConnectorApi::list_providers_catalog`'s
/// result — avoids hitting OpenConnector's ~6.4MB, unfiltered
/// `/api/providers` response on every browse/search request.
/// `tokio::sync::RwLock` (not `std::sync::Mutex`): the cached value is
/// read far more often than written (every request reads; a write only
/// happens once per `CATALOG_CACHE_TTL` window), and reads must not block
/// each other while a refresh is in flight.
#[derive(Default)]
pub struct CatalogCache {
    data: RwLock<Option<CachedCatalog>>,
}

struct CachedCatalog {
    providers: Vec<CatalogProvider>,
    fetched_at: Instant,
}

/// Outcome of `CatalogCache::get_or_refresh` — distinguishes "used a
/// value fetched just now" from "OpenConnector refresh failed, fell back
/// to a still-present but expired value" so the route can log the
/// degraded case (`tracing::warn!`) without treating it as an error.
enum CatalogFetch {
    Fresh(Vec<CatalogProvider>),
    Stale(Vec<CatalogProvider>),
}

impl CatalogCache {
    /// Returns the cached catalog if fresh; otherwise calls
    /// `list_providers_catalog` once. On refresh failure: serves the
    /// stale value if one exists (graceful degradation — the same
    /// pattern `list_integrations_route` already established for its own
    /// `list_connections` failure, see `route.rs`), or propagates the
    /// error if the cache is empty (nothing to fall back to).
    ///
    /// Double-checked locking against thundering herd: the first
    /// (read-lock) staleness check is cheap and lets the common case
    /// (cache fresh) skip the write lock entirely. When it looks stale,
    /// every concurrent caller then queues on the SAME write lock
    /// (acquired before the fetch, not after) and re-checks staleness
    /// again once it holds that lock — so only the first caller to
    /// actually acquire the write lock still finds it stale and performs
    /// the real `list_providers_catalog()` fetch; every other caller
    /// finds the value another caller just stored and reuses it, never
    /// firing its own redundant upstream call.
    async fn get_or_refresh(
        &self,
        openconnector: &dyn super::OpenConnectorApi,
    ) -> Result<CatalogFetch, super::openconnector::OpenConnectorError> {
        if let Some(cached) = self.data.read().await.as_ref() {
            if cached.fetched_at.elapsed() < CATALOG_CACHE_TTL {
                return Ok(CatalogFetch::Fresh(cached.providers.clone()));
            }
        }

        let mut guard = self.data.write().await;
        if let Some(cached) = guard.as_ref() {
            if cached.fetched_at.elapsed() < CATALOG_CACHE_TTL {
                return Ok(CatalogFetch::Fresh(cached.providers.clone()));
            }
        }

        match openconnector.list_providers_catalog().await {
            Ok(providers) => {
                *guard = Some(CachedCatalog {
                    providers: providers.clone(),
                    fetched_at: Instant::now(),
                });
                Ok(CatalogFetch::Fresh(providers))
            }
            Err(err) => {
                if let Some(cached) = guard.as_ref() {
                    return Ok(CatalogFetch::Stale(cached.providers.clone()));
                }
                Err(err)
            }
        }
    }
}

/// Default page size for `GET /integrations/catalog` when `limit` is
/// omitted — mirrors `workspaces/route/list.rs`'s pagination convention
/// exactly (same default/cap/reject-negative rules).
const DEFAULT_CATALOG_LIMIT: i64 = 50;

/// Upper bound on `limit` regardless of what a caller requests.
const MAX_CATALOG_LIMIT: i64 = 200;

#[derive(Deserialize)]
pub struct CatalogQuery {
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize)]
struct CatalogProviderOut<'a> {
    service: &'a str,
    display_name: &'a str,
    categories: &'a [String],
    auth_types: &'a [String],
    homepage_url: Option<&'a str>,
}

#[derive(Serialize)]
struct CatalogListData<'a> {
    providers: Vec<CatalogProviderOut<'a>>,
    total: usize,
    limit: i64,
    offset: i64,
}

/// `GET /integrations/catalog?search=<q>&limit=<n>&offset=<n>` — NOT
/// workspace-scoped, same reasoning as `GET /integrations/providers`
/// (see that route's own doc comment): the catalog is the same for
/// everyone. Read-only, cached (see `CatalogCache`), paginated, searched
/// in-memory over the cached list — never a per-request OpenConnector
/// call except when the cache itself needs refreshing.
pub async fn catalog_route(
    State(state): State<Arc<IntegrationsState>>,
    Query(query): Query<CatalogQuery>,
) -> Response {
    let offset = query.offset.unwrap_or(0);
    if offset < 0 {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_pagination",
            "offset must not be negative",
        );
    }
    let requested_limit = query.limit.unwrap_or(DEFAULT_CATALOG_LIMIT);
    if requested_limit < 0 {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_pagination",
            "limit must not be negative",
        );
    }
    let limit = requested_limit.min(MAX_CATALOG_LIMIT);

    let fetch = match state
        .catalog_cache
        .get_or_refresh(state.openconnector.as_ref())
        .await
    {
        Ok(fetch) => fetch,
        Err(err) => {
            tracing::warn!(error = %err, "openconnector list_providers_catalog failed with no cached value to fall back to");
            return error(StatusCode::BAD_GATEWAY, err.safe_code(), err.safe_message());
        }
    };

    let providers = match fetch {
        CatalogFetch::Fresh(providers) => providers,
        CatalogFetch::Stale(providers) => {
            tracing::warn!(
                "openconnector list_providers_catalog refresh failed; serving stale cached catalog"
            );
            providers
        }
    };

    let matched: Vec<&CatalogProvider> = match &query.search {
        Some(search) if !search.is_empty() => {
            let needle = search.to_lowercase();
            providers
                .iter()
                .filter(|p| {
                    p.service.to_lowercase().contains(&needle)
                        || p.display_name.to_lowercase().contains(&needle)
                })
                .collect()
        }
        _ => providers.iter().collect(),
    };

    let total = matched.len();
    let page: Vec<CatalogProviderOut> = matched
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|p| CatalogProviderOut {
            service: &p.service,
            display_name: &p.display_name,
            categories: &p.categories,
            auth_types: &p.auth_types,
            homepage_url: p.homepage_url.as_deref(),
        })
        .collect();

    success(
        StatusCode::OK,
        CatalogListData {
            providers: page,
            total,
            limit,
            offset,
        },
    )
}

#[derive(Serialize)]
struct CatalogConnectResponseData {
    provider_id: String,
    status: &'static str,
    account_label: Option<String>,
}

/// `POST /workspaces/:id/integrations/catalog/:service/connect` —
/// `api_key`-only connect for ANY OpenConnector catalog service, bypassing
/// `providers.yaml`'s `Provider` registry entirely (`service` is a raw
/// path param, never looked up against `IntegrationsState::find_provider`
/// — that lookup, and the 404 it produces for an unknown provider, is
/// exactly what this route exists to skip). OAuth connect stays
/// `providers.yaml`-only (OAuth needs a real registered client
/// id/secret this catalog cannot supply) — this route only ever does
/// `api_key`.
///
/// Reuses `route.rs`'s `finish_connection`/token-rotation/workspace-
/// validation logic unchanged: workspace existence/readiness is checked
/// FIRST (same ordering `connect_integration_route` already fixed — see
/// that route's own "Bug 2" comment), and a post-connect failure runs the
/// same delete-connection compensation. The local DB row uses the raw
/// `service` string as `provider_id` (no schema change — that column is
/// just a string key), so it appears in `GET /workspaces/:id/integrations`
/// alongside curated-provider connections, unified.
///
/// No `Provider.allowed_actions` exists for a catalog-only connection —
/// `mcp_proxy.rs`'s `sanitize_request` already handles "no matching
/// provider in the registry" by deferring to OpenConnector's own
/// rejection (see that function's comment); this route needs no
/// corresponding change there.
pub async fn catalog_connect_route(
    State(state): State<Arc<IntegrationsState>>,
    Path((workspace_id, service)): Path<(String, String)>,
    Json(request): Json<ConnectRequest>,
) -> Response {
    if let Err(response) = resolve_ready_workspace(&state.workspace_store, &workspace_id).await {
        return response;
    }

    // `integration_connections` has `UNIQUE (workspace_id, provider_id)`
    // and `upsert_connection` is an `ON CONFLICT ... DO UPDATE` — a
    // genuine UPSERT, not reject-on-conflict. If `:service` happens to
    // match a curated `providers.yaml` entry's `id` (e.g. `github`), an
    // unauthenticated-by-registry catalog-connect would silently
    // overwrite that curated connection's row: different
    // `openconnector_connection_id`, different account, zero warning.
    // Reject BEFORE any OpenConnector call or local DB write — reuses
    // `state.find_provider`, the exact same curated-registry lookup
    // `route.rs` already uses, rather than a second one.
    if state.find_provider(&service).is_some() {
        return error(
            StatusCode::CONFLICT,
            "provider_id_conflicts_with_curated_entry",
            format!(
                "{service:?} is already a curated, hand-verified provider — use \
                 POST /workspaces/:id/integrations/{service}/connect instead of \
                 the catalog-connect path for it, to avoid two different \
                 connection records competing for the same database row."
            ),
        );
    }

    let connection_name = workspace_connection_name(&workspace_id);

    let connection_summary = match state
        .openconnector
        .connect_with_api_key(&service, &connection_name, &request.api_key)
        .await
    {
        Ok(summary) => summary,
        Err(err) => {
            tracing::warn!(workspace_id = %workspace_id, service = %service, error = %err, "openconnector connect_with_api_key failed");
            return error(StatusCode::BAD_GATEWAY, err.safe_code(), err.safe_message());
        }
    };

    match finish_connection(&state, &workspace_id, &service, &connection_summary).await {
        Ok(()) => success(
            StatusCode::OK,
            CatalogConnectResponseData {
                provider_id: service,
                status: "connected",
                account_label: Some(connection_summary.connection_name),
            },
        ),
        Err(response) => {
            let compensation_result = state
                .openconnector
                .delete_connection(&service, &connection_name)
                .await;
            audit(
                &state,
                Some(&workspace_id),
                Some(&service),
                "connect_compensated",
                compensation_result.is_ok(),
                None,
            )
            .await;
            response
        }
    }
}

/// Standalone router for the catalog routes, merged the same way
/// `route::router` is (see `bin/rust_gateway.rs`).
pub fn router(state: Arc<IntegrationsState>) -> Router {
    Router::new()
        .route("/integrations/catalog", get(catalog_route))
        .route(
            "/workspaces/:id/integrations/catalog/:service/connect",
            post(catalog_connect_route),
        )
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::openconnector::fake::FakeOpenConnector;
    use crate::integrations::route::ConnectRequest;
    use crate::integrations::IntegrationStore;
    use crate::workspaces::WorkspaceStore;
    use uuid::Uuid;

    async fn temp_pool() -> sqlx::SqlitePool {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        std::mem::forget(dir);
        crate::db::connect(&db_path)
            .await
            .expect("connect to fresh sqlite db")
    }

    fn test_token_cipher() -> crate::crypto::TokenCipher {
        crate::crypto::TokenCipher::new(&[7u8; 32])
    }

    async fn catalog_state(
        openconnector: Arc<FakeOpenConnector>,
    ) -> (Arc<IntegrationsState>, sqlx::SqlitePool) {
        let pool = temp_pool().await;
        let state = Arc::new(IntegrationsState {
            store: IntegrationStore::new(pool.clone()),
            openconnector,
            providers: Vec::new(),
            workspace_store: WorkspaceStore::new(pool.clone()),
            http_client: reqwest::Client::new(),
            token_cipher: test_token_cipher(),
            mcp_bearer_lockout: Default::default(),
            catalog_cache: CatalogCache::default(),
        });
        (state, pool)
    }

    /// Same as `catalog_state`, but with `providers` seeded — needed by
    /// the curated-provider-collision test, which must exercise a
    /// non-empty `state.find_provider` registry (the collision check has
    /// nothing to collide with against `catalog_state`'s always-empty
    /// `Vec::new()`).
    async fn catalog_state_with_providers(
        openconnector: Arc<FakeOpenConnector>,
        providers: Vec<super::super::Provider>,
    ) -> (Arc<IntegrationsState>, sqlx::SqlitePool) {
        let pool = temp_pool().await;
        let state = Arc::new(IntegrationsState {
            store: IntegrationStore::new(pool.clone()),
            openconnector,
            providers,
            workspace_store: WorkspaceStore::new(pool.clone()),
            http_client: reqwest::Client::new(),
            token_cipher: test_token_cipher(),
            mcp_bearer_lockout: Default::default(),
            catalog_cache: CatalogCache::default(),
        });
        (state, pool)
    }

    /// Same shape as `route.rs`'s own private `test_provider` fixture
    /// (that one is not reachable from this sibling module's test mod),
    /// using `"github"` as the id — the same fixture id `route.rs`'s
    /// existing tests already use as a stand-in curated provider.
    fn test_curated_provider(id: &str) -> super::super::Provider {
        super::super::Provider {
            id: id.to_string(),
            name: id.to_string(),
            icon: None,
            openconnector_service: id.to_string(),
            description: None,
            homepage_url: None,
            oauth_client_env: None,
            allowed_actions: Vec::new(),
        }
    }

    async fn ready_workspace(pool: &sqlx::SqlitePool, workspace_id: &str) -> WorkspaceStore {
        let store = WorkspaceStore::new(pool.clone());
        let idempotency_key = format!("key-{workspace_id}");
        store
            .begin_creation(&idempotency_key, workspace_id)
            .await
            .expect("begin_creation");
        store
            .mark_ready(&idempotency_key, "not-a-real-container", 1, 2, 3)
            .await
            .expect("mark_ready");
        store
    }

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn provider(service: &str, display_name: &str) -> CatalogProvider {
        CatalogProvider {
            service: service.to_string(),
            display_name: display_name.to_string(),
            categories: vec!["productivity".to_string()],
            auth_types: vec!["api_key".to_string()],
            homepage_url: Some(format!("https://{service}.example.com")),
        }
    }

    // ---- Cache avoids a second OpenConnector call within the TTL ----

    #[tokio::test]
    async fn catalog_route_calls_openconnector_once_for_two_requests_within_the_ttl() {
        let fake =
            Arc::new(FakeOpenConnector::default().with_catalog(vec![provider("github", "GitHub")]));
        let (state, _pool) = catalog_state(fake.clone()).await;

        let _ = catalog_route(
            State(state.clone()),
            Query(CatalogQuery {
                search: None,
                limit: None,
                offset: None,
            }),
        )
        .await;
        let _ = catalog_route(
            State(state),
            Query(CatalogQuery {
                search: None,
                limit: None,
                offset: None,
            }),
        )
        .await;

        assert_eq!(
            fake.list_providers_catalog_calls(),
            1,
            "a second request within the TTL window must reuse the cached catalog"
        );
    }

    // ---- Search ----

    #[tokio::test]
    async fn catalog_route_search_matches_case_insensitively_on_service_or_display_name() {
        let fake = Arc::new(FakeOpenConnector::default().with_catalog(vec![
            provider("github", "GitHub"),
            provider("gmail", "Gmail"),
            provider("slack", "Slack"),
        ]));
        let (state, _pool) = catalog_state(fake).await;

        let response = catalog_route(
            State(state),
            Query(CatalogQuery {
                search: Some("GIT".to_string()),
                limit: None,
                offset: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        let providers = body["data"]["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["service"], "github");
        assert_eq!(body["data"]["total"], 1);
    }

    #[tokio::test]
    async fn catalog_route_search_matches_display_name_not_just_service_key() {
        let fake = Arc::new(
            FakeOpenConnector::default().with_catalog(vec![provider("gcal", "Google Calendar")]),
        );
        let (state, _pool) = catalog_state(fake).await;

        let response = catalog_route(
            State(state),
            Query(CatalogQuery {
                search: Some("calendar".to_string()),
                limit: None,
                offset: None,
            }),
        )
        .await;
        let body = body_json(response).await;
        let providers = body["data"]["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["service"], "gcal");
    }

    // ---- Pagination boundaries ----

    #[tokio::test]
    async fn catalog_route_pagination_offset_past_total_returns_zero_results() {
        let fake = Arc::new(
            FakeOpenConnector::default().with_catalog(vec![provider("a", "A"), provider("b", "B")]),
        );
        let (state, _pool) = catalog_state(fake).await;

        let response = catalog_route(
            State(state),
            Query(CatalogQuery {
                search: None,
                limit: None,
                offset: Some(10),
            }),
        )
        .await;
        let body = body_json(response).await;
        assert_eq!(body["data"]["providers"].as_array().unwrap().len(), 0);
        assert_eq!(body["data"]["total"], 2);
    }

    #[tokio::test]
    async fn catalog_route_pagination_returns_last_partial_page() {
        let fake = Arc::new(FakeOpenConnector::default().with_catalog(vec![
            provider("a", "A"),
            provider("b", "B"),
            provider("c", "C"),
        ]));
        let (state, _pool) = catalog_state(fake).await;

        let response = catalog_route(
            State(state),
            Query(CatalogQuery {
                search: None,
                limit: Some(2),
                offset: Some(2),
            }),
        )
        .await;
        let body = body_json(response).await;
        let providers = body["data"]["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["service"], "c");
    }

    #[tokio::test]
    async fn catalog_route_pagination_limit_exceeding_total_returns_all() {
        let fake = Arc::new(
            FakeOpenConnector::default().with_catalog(vec![provider("a", "A"), provider("b", "B")]),
        );
        let (state, _pool) = catalog_state(fake).await;

        let response = catalog_route(
            State(state),
            Query(CatalogQuery {
                search: None,
                limit: Some(1000),
                offset: None,
            }),
        )
        .await;
        let body = body_json(response).await;
        assert_eq!(body["data"]["providers"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn catalog_route_rejects_negative_limit_and_offset() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, _pool) = catalog_state(fake).await;

        let response = catalog_route(
            State(state.clone()),
            Query(CatalogQuery {
                search: None,
                limit: Some(-1),
                offset: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = catalog_route(
            State(state),
            Query(CatalogQuery {
                search: None,
                limit: None,
                offset: Some(-1),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    // ---- Cache empty + OpenConnector fetch fails -> clean 502, no leak ----

    #[tokio::test]
    async fn catalog_route_returns_safe_502_when_cache_empty_and_fetch_fails() {
        let fake = Arc::new(FakeOpenConnector::that_fails_list_providers_catalog());
        let (state, _pool) = catalog_state(fake).await;

        let response = catalog_route(
            State(state),
            Query(CatalogQuery {
                search: None,
                limit: None,
                offset: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = body_json(response).await;
        let raw = body.to_string();
        assert!(
            !raw.contains("simulated list_providers_catalog failure"),
            "the raw upstream error text must never leak into the HTTP response: {raw}"
        );
    }

    // ---- Stale-cache-served-on-refresh-failure ----
    //
    // Chosen design: STALE VALUES ARE SERVED on a refresh failure (not
    // "always fail if refresh fails") — mirrors `list_integrations_route`'s
    // existing best-effort degradation for its own `list_connections`
    // failure (see `route.rs`'s own comment on that call site): a
    // momentary OpenConnector blip should not turn a working browse/search
    // feature into a hard error for every caller until the next successful
    // refresh, when a slightly-stale-but-still-useful list is already in
    // memory. This test drives that path directly against `CatalogCache`
    // (there is no test-only clock to fast-forward past the real 15-minute
    // TTL through the HTTP route itself).
    #[tokio::test]
    async fn catalog_cache_serves_stale_value_when_refresh_fails() {
        let cache = CatalogCache::default();
        {
            let mut guard = cache.data.write().await;
            *guard = Some(CachedCatalog {
                providers: vec![provider("github", "GitHub")],
                // Older than CATALOG_CACHE_TTL, so `get_or_refresh` treats
                // it as due for a refresh.
                fetched_at: Instant::now() - (CATALOG_CACHE_TTL + Duration::from_secs(1)),
            });
        }
        let fake = FakeOpenConnector::that_fails_list_providers_catalog();

        let fetch = cache
            .get_or_refresh(&fake)
            .await
            .expect("stale value is served, not an error");
        match fetch {
            CatalogFetch::Stale(providers) => {
                assert_eq!(providers.len(), 1);
                assert_eq!(providers[0].service, "github");
            }
            CatalogFetch::Fresh(_) => panic!("expected a Stale result when refresh fails"),
        }
    }

    // ---- Endpoint 2: catalog connect ----

    #[tokio::test]
    async fn catalog_connect_creates_a_local_row_for_a_service_with_no_providers_yaml_entry() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = catalog_state(fake).await;
        let workspace_id = "ws-catalog-1";
        ready_workspace(&pool, workspace_id).await;

        let response = catalog_connect_route(
            State(state.clone()),
            Path((
                workspace_id.to_string(),
                "some-unlisted-service".to_string(),
            )),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        // Token delivery always fails in this test process (no real
        // Docker container — see `route.rs`'s `ready_workspace` doc
        // comment for the same limitation), so the HTTP response itself
        // is not OK; what this test proves is the row, per the task's
        // own instruction to assert the DB row and response reflect the
        // real outcome either way.
        let _ = response;
        let row = state
            .store
            .find_connection(workspace_id, "some-unlisted-service")
            .await
            .expect("find_connection succeeds")
            .expect("a row was written for the raw service string, unregistered in providers.yaml");
        assert_eq!(row.provider_id, "some-unlisted-service");
    }

    #[tokio::test]
    async fn catalog_connect_rejects_unknown_workspace_before_any_openconnector_call() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, _pool) = catalog_state(fake.clone()).await;

        let response = catalog_connect_route(
            State(state),
            Path(("does-not-exist".to_string(), "some-service".to_string())),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_found");
        assert!(
            fake.create_runtime_token_calls().is_empty(),
            "an unknown workspace must never reach OpenConnector at all"
        );
    }

    #[tokio::test]
    async fn catalog_connect_rejects_not_ready_workspace_before_any_openconnector_call() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = catalog_state(fake.clone()).await;
        let workspace_id = "ws-catalog-creating";
        let store = WorkspaceStore::new(pool.clone());
        store
            .begin_creation("key-creating", workspace_id)
            .await
            .expect("begin_creation");

        let response = catalog_connect_route(
            State(state),
            Path((workspace_id.to_string(), "some-service".to_string())),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "workspace_not_ready");
        assert!(
            fake.create_runtime_token_calls().is_empty(),
            "a not-ready workspace must never reach OpenConnector at all"
        );
    }

    #[tokio::test]
    async fn catalog_connected_service_appears_in_list_integrations_alongside_curated_providers() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) = catalog_state(fake).await;
        let workspace_id = "ws-catalog-roundtrip";
        ready_workspace(&pool, workspace_id).await;

        // Simulate a successful catalog connect having already written its
        // row (this test process has no Docker-free token-delivery fake,
        // so driving `catalog_connect_route` end to end always fails at
        // delivery — see the module-level tests above); what this test
        // proves is that `list_integrations_route`'s existing machinery
        // does not crash or exclude a `provider_id` outside `providers.yaml`.
        state
            .store
            .upsert_connection(
                &Uuid::new_v4().to_string(),
                workspace_id,
                "some-unlisted-service",
                "ws-ws-catalog-roundtrip",
                Some("conn-1"),
                super::super::store::ConnectionStatus::Connected,
                Some("ws-ws-catalog-roundtrip"),
            )
            .await
            .expect("seed catalog-connected row");

        let response = crate::integrations::route::list_integrations_route(
            State(state),
            Path(workspace_id.to_string()),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        let connections = body["data"].as_array().unwrap();
        assert!(
            connections
                .iter()
                .any(|c| c["provider_id"] == "some-unlisted-service" && c["status"] == "connected"),
            "the catalog-connected service must appear in the unified list: {connections:?}"
        );
    }

    // ---- Fix 1: catalog-connect must reject a curated provider_id ----
    //
    // `integration_connections` has `UNIQUE (workspace_id, provider_id)`
    // and `upsert_connection` is an UPSERT (`ON CONFLICT ... DO UPDATE`),
    // not reject-on-conflict. Before this fix, `POST
    // /workspaces/:id/integrations/catalog/github/connect` would silently
    // overwrite any existing curated GitHub connection's row. This proves
    // the rejection happens BEFORE any OpenConnector call (via the fake's
    // call counts), and that the existing "no providers.yaml entry" path
    // still succeeds unaffected.

    #[tokio::test]
    async fn catalog_connect_rejects_a_service_id_that_collides_with_a_curated_provider() {
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) =
            catalog_state_with_providers(fake.clone(), vec![test_curated_provider("github")]).await;
        let workspace_id = "ws-catalog-collision";
        ready_workspace(&pool, workspace_id).await;

        let response = catalog_connect_route(
            State(state.clone()),
            Path((workspace_id.to_string(), "github".to_string())),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body_json(response).await;
        assert_eq!(
            body["ok"], false,
            "a collision must never look like success: {body:?}"
        );
        assert_eq!(
            body["error"]["code"],
            "provider_id_conflicts_with_curated_entry"
        );

        assert!(
            fake.create_runtime_token_calls().is_empty(),
            "a curated-id collision must never reach OpenConnector's connect_with_api_key/create_runtime_token at all"
        );

        let row = state
            .store
            .find_connection(workspace_id, "github")
            .await
            .expect("find_connection succeeds");
        assert!(
            row.is_none(),
            "a rejected catalog-connect must never write/clobber a local DB row"
        );
    }

    #[tokio::test]
    async fn catalog_connect_still_succeeds_for_a_service_with_no_providers_yaml_entry_when_curated_list_is_non_empty(
    ) {
        // Regression guard: the new check must reject a GENUINE
        // collision only, not every catalog-connect call once
        // `state.providers` is non-empty.
        let fake = Arc::new(FakeOpenConnector::default());
        let (state, pool) =
            catalog_state_with_providers(fake, vec![test_curated_provider("github")]).await;
        let workspace_id = "ws-catalog-no-collision";
        ready_workspace(&pool, workspace_id).await;

        let response = catalog_connect_route(
            State(state.clone()),
            Path((
                workspace_id.to_string(),
                "some-unlisted-service".to_string(),
            )),
            Json(ConnectRequest {
                api_key: "irrelevant".to_string(),
            }),
        )
        .await;

        // Same limitation as the existing "no providers.yaml entry" test:
        // token delivery always fails in this test process (no real
        // Docker container), so the HTTP response itself is not OK. What
        // this test proves is that the collision check did NOT trip:
        // the row for a non-colliding, unlisted service is still written.
        let _ = response;
        let row = state
            .store
            .find_connection(workspace_id, "some-unlisted-service")
            .await
            .expect("find_connection succeeds")
            .expect("a non-colliding service must still reach the normal connect path");
        assert_eq!(row.provider_id, "some-unlisted-service");
    }

    // ---- Fix 2: concurrent stale-cache refreshes collapse into one fetch ----

    #[tokio::test]
    async fn concurrent_get_or_refresh_calls_against_a_stale_cache_fetch_openconnector_exactly_once(
    ) {
        let fake = Arc::new(
            FakeOpenConnector::default()
                .with_catalog(vec![provider("github", "GitHub")])
                .with_catalog_fetch_delay(Duration::from_millis(50)),
        );
        let cache = Arc::new(CatalogCache::default());

        // No pre-seeded value at all (the emptiest possible "stale" case)
        // — every one of these N concurrent callers independently sees
        // "no fresh value" on its first read-lock check and would, prior
        // to the fix, each fire its own `list_providers_catalog` call.
        // `tokio::join!` (not sequential `.await`s) genuinely overlaps
        // them, and the fake's artificial delay widens the race window
        // so the overlap is not a matter of luck.
        let calls: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                let fake = fake.clone();
                tokio::spawn(async move { cache.get_or_refresh(fake.as_ref()).await })
            })
            .collect();

        for handle in calls {
            let fetch = handle
                .await
                .expect("task did not panic")
                .expect("fetch succeeds");
            let providers = match fetch {
                CatalogFetch::Fresh(providers) | CatalogFetch::Stale(providers) => providers,
            };
            assert_eq!(providers.len(), 1);
            assert_eq!(providers[0].service, "github");
        }

        assert_eq!(
            fake.list_providers_catalog_calls(),
            1,
            "N concurrent callers hitting a stale/empty cache must collapse into exactly one real OpenConnector fetch"
        );
    }
}
