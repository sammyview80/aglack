//! Create-workspace feature: the idempotency record and the route handlers.
//! See `../../docs/create-workspace-plan.md` before changing anything here.
//!
//! `store` owns the SQLite-backed idempotency record (safe to call
//! repeatedly with the same key; never creates a duplicate). `container/`
//! owns turning a workspace record into a real Docker container (its own
//! submodules split by responsibility — see its `mod.rs`). `route/` holds
//! one HTTP handler per submodule (create/list/delete/diagnose), each
//! translating a request into a call to this file's `create_workspace`/
//! `delete_workspace` or `diagnosis::diagnose_workspace`. `mod.rs` (this
//! file) wires store + container together behind the public
//! `create_workspace` entry point the HTTP route calls.

mod agent_history_proxy;
mod agent_seeder_proxy;
mod chat_proxy;
pub(crate) mod container;
mod desktop_proxy;
pub(crate) mod diagnosis;
mod hermes_webui_proxy;
mod onboarding_proxy;
pub(crate) mod resolve;
pub(crate) mod route;
mod store;
#[cfg(test)]
pub(crate) mod test_support;
mod wrapper_prefix_proxy;

pub use agent_history_proxy::{agent_history_proxy_route_root, agent_history_proxy_route_with_path};
pub use agent_seeder_proxy::{agent_seeder_proxy_route_root, agent_seeder_proxy_route_with_path};
pub use chat_proxy::{chat_proxy_route_root, chat_proxy_route_with_path};
pub use container::{ContainerLauncher, DockerCliLauncher, LaunchedContainer};
pub use desktop_proxy::{desktop_proxy_route_root, desktop_proxy_route_with_path};
pub use hermes_webui_proxy::{hermes_webui_proxy_route_root, hermes_webui_proxy_route_with_path};
pub use onboarding_proxy::{onboarding_proxy_route_root, onboarding_proxy_route_with_path};
pub use route::{
    create_workspace_route, delete_workspace_route, diagnose_workspace_route,
    list_workspaces_route, WorkspacesState,
};
pub use store::{WorkspaceRecord, WorkspaceStatus, WorkspaceStore};

/// One request to create a workspace, and the one place that decides
/// whether to actually create a container or return an existing result.
///
/// This is intentionally the ONLY function that may call both
/// `WorkspaceStore` and `ContainerLauncher` — see AGENTS.md's "optimize
/// for the reader" rule: the idempotency decision lives in exactly one
/// place, not duplicated at every call site that might create a workspace.
pub async fn create_workspace(
    store: &WorkspaceStore,
    launcher: &dyn ContainerLauncher,
    idempotency_key: &str,
) -> Result<WorkspaceRecord, CreateWorkspaceError> {
    if let Some(existing) = store.find(idempotency_key).await? {
        // `Ready` means a previous call already finished successfully —
        // return it as-is, never launch again. `Creating` or `Failed` mean
        // no container exists yet for this key (still in progress, or the
        // last attempt errored out) — those must be retried with the SAME
        // workspace_id, not treated as done. Without this distinction, one
        // failed launch would permanently strand the key: every retry
        // would just return the incomplete row forever instead of trying
        // again.
        if existing.status == WorkspaceStatus::Ready {
            return Ok(existing);
        }
        return launch_and_record(store, launcher, idempotency_key, &existing.workspace_id).await;
    }

    let workspace_id = uuid::Uuid::new_v4().to_string();
    let record = store.begin_creation(idempotency_key, &workspace_id).await?;

    // A second caller racing in between `find` returning None and
    // `begin_creation` committing would hit this same path — `begin_creation`
    // itself must be the race-safe chokepoint (see store.rs), not this
    // function. If `begin_creation` reports the key already existed (lost
    // the race), fall back to the same not-yet-ready handling above rather
    // than assuming the winner of the race already finished.
    if record.container_name.is_some() {
        return Ok(record);
    }

    launch_and_record(store, launcher, idempotency_key, &record.workspace_id).await
}

/// Stop the workspace's container (if one was launched) and drop its
/// store row. `None` means no such workspace — the HTTP layer turns that
/// into `404 workspace_not_found`. Container remove runs before the row
/// delete: a Docker failure leaves the row so the caller can retry.
pub async fn delete_workspace(
    store: &WorkspaceStore,
    launcher: &dyn ContainerLauncher,
    workspace_id: &str,
) -> Result<Option<WorkspaceRecord>, CreateWorkspaceError> {
    let Some(record) = store.find_by_workspace_id(workspace_id).await? else {
        return Ok(None);
    };
    if let Some(container_name) = &record.container_name {
        launcher.remove(container_name).await?;
    }
    store.delete_by_workspace_id(workspace_id).await?;
    Ok(Some(record))
}

/// Actually launch a container for an already-claimed `workspace_id` and
/// record the outcome. On failure, the row is marked `Failed` (not left at
/// `Creating`) so the NEXT call with this same key knows to retry rather
/// than treat the row as still-in-progress-forever.
async fn launch_and_record(
    store: &WorkspaceStore,
    launcher: &dyn ContainerLauncher,
    idempotency_key: &str,
    workspace_id: &str,
) -> Result<WorkspaceRecord, CreateWorkspaceError> {
    match launcher.launch(workspace_id).await {
        Ok(launched) => Ok(store
            .mark_ready(
                idempotency_key,
                &launched.container_name,
                launched.wrapper_port,
                launched.desktop_port,
            )
            .await?),
        Err(launch_err) => {
            // Best-effort: if marking the failure itself fails, the row
            // stays at `Creating` and a future retry will attempt the
            // launch again anyway (safe, if slightly redundant) — the
            // original launch error is what the caller sees either way.
            let _ = store.mark_failed(idempotency_key).await;
            Err(launch_err)
        }
    }
}

#[derive(Debug)]
pub enum CreateWorkspaceError {
    Store(sqlx::Error),
    Container(String),
}

impl From<sqlx::Error> for CreateWorkspaceError {
    fn from(err: sqlx::Error) -> Self {
        CreateWorkspaceError::Store(err)
    }
}

impl std::fmt::Display for CreateWorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CreateWorkspaceError::Store(err) => write!(f, "workspace store error: {err}"),
            CreateWorkspaceError::Container(msg) => write!(f, "container launch error: {msg}"),
        }
    }
}

impl std::error::Error for CreateWorkspaceError {}

#[cfg(test)]
mod tests {
    use super::test_support::temp_store;
    use super::*;
    use container::FakeLauncher;

    #[tokio::test]
    async fn same_key_twice_returns_same_workspace_and_launches_once() {
        let store = temp_store().await;
        let launcher = FakeLauncher::default();

        let first = create_workspace(&store, &launcher, "key-a")
            .await
            .expect("first create succeeds");
        let second = create_workspace(&store, &launcher, "key-a")
            .await
            .expect("second create (retry) succeeds");

        assert_eq!(first.workspace_id, second.workspace_id);
        assert_eq!(first.container_name, second.container_name);
        assert_eq!(
            launcher.launch_count(),
            1,
            "a retried key must not launch a second container"
        );
    }

    #[tokio::test]
    async fn different_keys_create_separate_workspaces() {
        let store = temp_store().await;
        let launcher = FakeLauncher::default();

        let first = create_workspace(&store, &launcher, "key-a")
            .await
            .expect("first create succeeds");
        let second = create_workspace(&store, &launcher, "key-b")
            .await
            .expect("second create succeeds");

        assert_ne!(first.workspace_id, second.workspace_id);
        assert_eq!(launcher.launch_count(), 2);
    }

    #[tokio::test]
    async fn a_key_whose_launch_failed_is_retried_on_the_next_call_with_the_same_key() {
        let store = temp_store().await;
        // First call's launch fails (simulating a transient Docker error);
        // the second call must retry the SAME workspace_id, not return the
        // permanently-stuck "creating" row from the first attempt.
        let launcher = FakeLauncher::that_fails_first(1);

        let first_attempt = create_workspace(&store, &launcher, "key-a").await;
        assert!(
            first_attempt.is_err(),
            "first attempt should fail (simulated launch failure)"
        );

        let retry = create_workspace(&store, &launcher, "key-a")
            .await
            .expect("retry after a failed launch must succeed");

        assert!(
            retry.container_name.is_some(),
            "a retried key must actually attempt the launch again, not return a stuck \
             'creating' record with no container"
        );
        assert_eq!(
            launcher.launch_count(),
            2,
            "the retry must call launch() again — the first call's failure must not \
             be treated as a completed idempotent result"
        );
    }

    #[tokio::test]
    async fn database_file_is_created_automatically_when_missing() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("nested").join("does-not-exist-yet.db");
        assert!(!db_path.exists());

        crate::db::connect(&db_path)
            .await
            .expect("connect creates the database file and its parent dir");

        assert!(db_path.exists());
    }

    #[tokio::test]
    async fn delete_unknown_workspace_returns_none_and_does_not_remove_a_container() {
        let store = temp_store().await;
        let launcher = FakeLauncher::default();

        let result = delete_workspace(&store, &launcher, "does-not-exist")
            .await
            .expect("delete of unknown id is not an error");

        assert!(result.is_none());
        assert_eq!(launcher.remove_count(), 0);
    }

    #[tokio::test]
    async fn delete_ready_workspace_removes_the_container_and_the_row() {
        let store = temp_store().await;
        let launcher = FakeLauncher::default();
        let created = create_workspace(&store, &launcher, "to-delete")
            .await
            .expect("create succeeds");

        let deleted = delete_workspace(&store, &launcher, &created.workspace_id)
            .await
            .expect("delete succeeds")
            .expect("workspace existed");

        assert_eq!(deleted.workspace_id, created.workspace_id);
        assert_eq!(launcher.remove_count(), 1);
        assert!(store
            .find_by_workspace_id(&created.workspace_id)
            .await
            .expect("lookup succeeds")
            .is_none());
        assert!(store.list(50, 0).await.expect("list succeeds").is_empty());
    }

    #[tokio::test]
    async fn delete_failed_workspace_with_no_container_skips_remove() {
        let store = temp_store().await;
        let launcher = FakeLauncher::that_fails_first(1);
        let _ = create_workspace(&store, &launcher, "failed-key").await;
        let failed = store
            .find("failed-key")
            .await
            .expect("lookup succeeds")
            .expect("row exists after failed launch");

        let deleted = delete_workspace(&store, &launcher, &failed.workspace_id)
            .await
            .expect("delete succeeds")
            .expect("workspace existed");

        assert_eq!(deleted.workspace_id, failed.workspace_id);
        assert_eq!(
            launcher.remove_count(),
            0,
            "no container was launched, so remove must not be called"
        );
        assert!(store
            .find_by_workspace_id(&failed.workspace_id)
            .await
            .expect("lookup succeeds")
            .is_none());
    }
}
