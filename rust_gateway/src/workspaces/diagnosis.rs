//! `diagnose_workspace`: the one function that composes a real container
//! diagnosis (Docker state + live wrapper/desktop health) and, if
//! unhealthy, a stop-then-start recovery cycle. See
//! `../../docs/diagnose-workspace-plan.md` for the full "why" before
//! changing anything here.
//!
//! Mirrors `mod.rs`'s separation: this file owns the orchestration
//! (store + `ContainerLauncher` + live HTTP checks, all three), the HTTP
//! route (`route.rs`) only translates this function's result into a
//! response.

use std::time::Duration;

use super::container::{
    check_desktop_health, check_wrapper_health, wait_for_desktop_ready, wait_for_wrapper_ready,
    ContainerState,
};
use super::store::WorkspaceRecord;
use super::{ContainerLauncher, CreateWorkspaceError, WorkspaceStore};

/// Every timeout `diagnose_workspace` needs, gathered into one struct and
/// passed as a parameter rather than hardcoded module constants — the
/// SAME reason `container.rs`'s `wait_for_wrapper_ready` takes `timeout`
/// as an argument instead of a constant: a real Docker daemon's boot time
/// and a test's `FakeLauncher` (never actually listening on the port it
/// reports) need very different values, and `production()` vs a test
/// picking its own short values keeps that difference explicit at every
/// call site instead of a `#[cfg(test)]`-gated constant swap.
#[derive(Debug, Clone, Copy)]
pub struct DiagnosisTimeouts {
    /// Bound on the initial `before` snapshot's wrapper/desktop checks —
    /// same value `list_workspaces_route` uses for its own live health
    /// checks (see `route.rs`'s `HEALTH_CHECK_TIMEOUT`): a diagnosis is
    /// exactly as time-bounded a caller as a list request, for the same
    /// reason (one hung service must not stall the whole diagnosis).
    pub health_check: Duration,
    /// How long to wait for the wrapper to come back up after a
    /// stop+start cycle — matches `DockerCliLauncher::launch`'s own
    /// wrapper readiness wait: a restarted container's wrapper takes the
    /// same real boot time a freshly created one's does, so a bare
    /// single-attempt check immediately after `start_existing` returns
    /// would almost always misreport a still-booting container as a
    /// failed recovery.
    pub post_restart_wrapper: Duration,
    /// Same idea as `post_restart_wrapper`, for the desktop — matches
    /// `DockerCliLauncher::launch`'s desktop readiness wait.
    pub post_restart_desktop: Duration,
}

impl DiagnosisTimeouts {
    /// The real values used by the actual HTTP route
    /// (`diagnose_workspace_route`) against real Docker/real containers.
    pub fn production() -> Self {
        Self {
            health_check: Duration::from_secs(2),
            post_restart_wrapper: Duration::from_secs(30),
            post_restart_desktop: Duration::from_secs(15),
        }
    }
}

/// One snapshot of everything a diagnosis can observe about a workspace's
/// container at a point in time — the `before`/`after` shape in the HTTP
/// response (see `route.rs`). Never partially filled: either every field
/// reflects something actually checked, or (for `container_running`
/// etc.) `inspect`'s own "no such container" case, which is itself a
/// real, meaningful finding (see `container.rs::inspect_container_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiagnosisSnapshot {
    pub container_running: bool,
    pub container_exit_code: Option<i64>,
    pub container_oom_killed: bool,
    pub wrapper_healthy: bool,
    pub desktop_healthy: bool,
}

impl DiagnosisSnapshot {
    /// The single question the recovery cycle exists to answer: is there
    /// anything wrong here at all? Any one signal failing is enough — see
    /// `../../docs/diagnose-workspace-plan.md`'s "what counts as
    /// unhealthy" section for why a `Running: true` container with a hung
    /// wrapper is exactly as broken as one that isn't running at all.
    fn is_unhealthy(&self) -> bool {
        !self.container_running || !self.wrapper_healthy || !self.desktop_healthy
    }
}

/// What `diagnose_workspace` actually did about an unhealthy finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosisAction {
    /// The workspace was already healthy — no stop/start was attempted.
    None,
    /// A stop+start cycle ran; `after` in `DiagnosisReport` reflects the
    /// real post-restart state (which may still be unhealthy — that is a
    /// legitimate finding, not folded into this variant).
    Restarted,
    /// The stop or start command itself failed (a real Docker error, not
    /// "restarted but still unhealthy") — `after` is `None` in this case,
    /// since no meaningful post-action state was ever reached.
    RestartFailed,
}

#[derive(Debug, Clone)]
pub struct DiagnosisReport {
    pub before: DiagnosisSnapshot,
    pub action: DiagnosisAction,
    pub after: Option<DiagnosisSnapshot>,
}

/// Errors specific to diagnosis's own preconditions — distinct from
/// `CreateWorkspaceError` (store/container failures), which this still
/// wraps via `From` for the cases where a real store or Docker error
/// happens mid-diagnosis.
#[derive(Debug)]
pub enum DiagnoseWorkspaceError {
    /// No such `workspace_id` at all.
    NotFound,
    /// The workspace exists but has never had a container (still
    /// `Creating` with no `container_name` yet, or `Failed` before any
    /// container was ever created) — nothing for a diagnosis to inspect.
    NoContainer,
    Other(CreateWorkspaceError),
}

impl From<CreateWorkspaceError> for DiagnoseWorkspaceError {
    fn from(err: CreateWorkspaceError) -> Self {
        DiagnoseWorkspaceError::Other(err)
    }
}

impl From<sqlx::Error> for DiagnoseWorkspaceError {
    fn from(err: sqlx::Error) -> Self {
        DiagnoseWorkspaceError::Other(CreateWorkspaceError::Store(err))
    }
}

/// Diagnose `workspace_id`'s container, healing it (stop then start) if
/// the diagnosis finds it unhealthy. See the module doc and
/// `../../docs/diagnose-workspace-plan.md` for the full behavior; this is
/// the one function allowed to call both `WorkspaceStore` and
/// `ContainerLauncher` for this feature, mirroring `mod.rs`'s
/// `create_workspace`/`delete_workspace` convention.
pub async fn diagnose_workspace(
    store: &WorkspaceStore,
    launcher: &dyn ContainerLauncher,
    http_client: &reqwest::Client,
    workspace_id: &str,
    timeouts: DiagnosisTimeouts,
) -> Result<DiagnosisReport, DiagnoseWorkspaceError> {
    let record: WorkspaceRecord = store
        .find_by_workspace_id(workspace_id)
        .await?
        .ok_or(DiagnoseWorkspaceError::NotFound)?;

    let Some(container_name) = record.container_name.clone() else {
        return Err(DiagnoseWorkspaceError::NoContainer);
    };

    let before = snapshot(
        launcher,
        http_client,
        &container_name,
        &record,
        timeouts.health_check,
    )
    .await?;

    if !before.is_unhealthy() {
        return Ok(DiagnosisReport {
            before,
            action: DiagnosisAction::None,
            after: None,
        });
    }

    // Real infrastructure mutation starts here — only ever reached when
    // `before` already proved something is actually wrong. A stop/start
    // failure is reported as `RestartFailed`, not propagated as a hard
    // `Err`: the diagnosis itself (the `before` snapshot) already
    // succeeded and is real, useful information even if the heal attempt
    // that followed did not go well — the caller should still see it.
    if let Err(err) = heal(launcher, &container_name).await {
        eprintln!(
            "rust_gateway: diagnose_workspace heal cycle failed for {workspace_id:?} \
             (container {container_name:?}): {err}"
        );
        return Ok(DiagnosisReport {
            before,
            action: DiagnosisAction::RestartFailed,
            after: None,
        });
    }

    // A restarted container's wrapper/desktop take the same real boot
    // time a freshly created one's do (see the module doc's "auto-heal
    // cycle" section) — poll for readiness with the SAME longer timeouts
    // `DockerCliLauncher::launch` itself uses, not a bare single-attempt
    // check that would almost always misreport a still-booting container
    // as a failed recovery. A timed-out wait is not propagated as an
    // `Err` — it is a real, legitimate "still not healthy" finding for
    // `after`'s `wrapper_healthy`/`desktop_healthy` fields, not a failure
    // of the diagnosis mechanism itself.
    let (wrapper_healthy, desktop_healthy) =
        if let (Some(wrapper_port), Some(desktop_port)) = (record.host_port, record.desktop_port) {
            tokio::join!(
                wait_readiness(wait_for_wrapper_ready(
                    wrapper_port as u16,
                    timeouts.post_restart_wrapper
                )),
                wait_readiness(wait_for_desktop_ready(
                    desktop_port as u16,
                    timeouts.post_restart_desktop
                )),
            )
        } else {
            (false, false)
        };

    let container_state = launcher.inspect(&container_name).await?;
    let after = DiagnosisSnapshot {
        container_running: container_state.running,
        container_exit_code: container_state.exit_code,
        container_oom_killed: container_state.oom_killed,
        wrapper_healthy,
        desktop_healthy,
    };

    // The store's `status`/ports must reflect the real post-heal outcome:
    // a caller re-listing workspaces (GET /workspaces) right after a
    // diagnosis must not see a stale `failed` row for a container that
    // diagnosis just fixed, nor a stale `ready` row for one that is still
    // broken after the heal attempt. Best-effort (`let _ =`): a store
    // write failure here does not change what already happened to the
    // container, and the real, just-observed `after` snapshot is still
    // returned to the caller regardless — matches `mod.rs`'s
    // `launch_and_record`'s own "best-effort store update" stance.
    if after.is_unhealthy() {
        let _ = store.mark_failed_by_workspace_id(workspace_id).await;
    } else if let (Some(wrapper_port), Some(desktop_port)) = (record.host_port, record.desktop_port)
    {
        let _ = store
            .mark_ready_by_workspace_id(
                workspace_id,
                &container_name,
                wrapper_port as u16,
                desktop_port as u16,
            )
            .await;
    }

    Ok(DiagnosisReport {
        before,
        action: DiagnosisAction::Restarted,
        after: Some(after),
    })
}

/// One real, live look at a workspace's container: Docker state (always
/// checked) plus wrapper/desktop health (only attempted if the container
/// is actually running — no point sending an HTTP request at a port with
/// nothing behind it; a not-running container is unhealthy on that
/// signal alone regardless of what an HTTP check would say).
async fn snapshot(
    launcher: &dyn ContainerLauncher,
    http_client: &reqwest::Client,
    container_name: &str,
    record: &WorkspaceRecord,
    health_check_timeout: Duration,
) -> Result<DiagnosisSnapshot, CreateWorkspaceError> {
    let ContainerState {
        running,
        exit_code,
        oom_killed,
    } = launcher.inspect(container_name).await?;

    let (wrapper_healthy, desktop_healthy) = if running {
        check_both_services(http_client, record, health_check_timeout).await
    } else {
        (false, false)
    };

    Ok(DiagnosisSnapshot {
        container_running: running,
        container_exit_code: exit_code,
        container_oom_killed: oom_killed,
        wrapper_healthy,
        desktop_healthy,
    })
}

/// Wrapper and desktop checks run concurrently (`tokio::join!`), not
/// sequentially — matches `route.rs`'s `check_health_and_build_list_items`
/// concurrency discipline for the same reason: two independent bounded
/// checks should cost one timeout, not two back to back. Only called
/// when the record actually has recorded ports; a workspace whose record
/// is missing a port (should be unreachable per `mark_ready`'s
/// invariant — see `resolve.rs`) fails closed as unhealthy on both.
async fn check_both_services(
    http_client: &reqwest::Client,
    record: &WorkspaceRecord,
    timeout: Duration,
) -> (bool, bool) {
    let (Some(wrapper_port), Some(desktop_port)) = (record.host_port, record.desktop_port) else {
        return (false, false);
    };
    tokio::join!(
        check_wrapper_health(http_client, wrapper_port as u16, timeout),
        check_desktop_health(http_client, desktop_port as u16, timeout),
    )
}

/// Collapse `wait_for_wrapper_ready`/`wait_for_desktop_ready`'s
/// `Result<(), Error>` (their real return type — see `container.rs`,
/// used at launch time where a timeout genuinely means "launch failed")
/// to a plain `bool` for `diagnose_workspace`'s use: here, a timed-out
/// wait is not an error condition to propagate — it is exactly what
/// `after.wrapper_healthy`/`after.desktop_healthy` being `false` already
/// means, matching `check_wrapper_health`'s own "no error variant worth
/// distinguishing" convention.
async fn wait_readiness(
    wait: impl std::future::Future<Output = Result<(), CreateWorkspaceError>>,
) -> bool {
    wait.await.is_ok()
}

/// The recovery cycle itself: `stop` then `start_existing`, then wait for
/// both services to actually come back up (see the module-level timeout
/// constants' doc comments for why a bare re-check is not enough here).
/// Returns early on the first failing step — a `stop` failure means
/// `start_existing` was never even attempted.
async fn heal(
    launcher: &dyn ContainerLauncher,
    container_name: &str,
) -> Result<(), CreateWorkspaceError> {
    launcher.stop(container_name).await?;
    launcher.start_existing(container_name).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::container::{ContainerState, FakeLauncher};
    use super::super::store::WorkspaceStatus;
    use super::super::test_support::temp_store;
    use super::*;

    fn unhealthy_state() -> ContainerState {
        ContainerState {
            running: false,
            exit_code: Some(137),
            oom_killed: false,
        }
    }

    /// Short timeouts for every test that reaches the post-restart wait —
    /// `FakeLauncher`'s ports are never real listeners unless a test
    /// stands one up itself, so waiting the real `DiagnosisTimeouts::
    /// production()` values (30s/15s) against nothing would make the test
    /// suite itself take tens of seconds for no real coverage benefit —
    /// same reasoning `container.rs`'s tests already apply to
    /// `check_wrapper_health`'s own timeout parameter.
    fn test_timeouts() -> DiagnosisTimeouts {
        DiagnosisTimeouts {
            health_check: Duration::from_millis(200),
            post_restart_wrapper: Duration::from_millis(200),
            post_restart_desktop: Duration::from_millis(200),
        }
    }

    #[tokio::test]
    async fn unknown_workspace_id_returns_not_found() {
        let store = temp_store().await;
        let launcher = FakeLauncher::default();
        let client = reqwest::Client::new();

        let result = diagnose_workspace(
            &store,
            &launcher,
            &client,
            "does-not-exist",
            test_timeouts(),
        )
        .await;
        assert!(matches!(result, Err(DiagnoseWorkspaceError::NotFound)));
    }

    #[tokio::test]
    async fn workspace_with_no_container_yet_returns_no_container() {
        let store = temp_store().await;
        let launcher = FakeLauncher::that_fails_first(1);
        let client = reqwest::Client::new();

        // First launch attempt fails -> row exists (Failed) but
        // container_name stays None (see mod.rs's launch_and_record).
        let _ = super::super::create_workspace(&store, &launcher, "never-launched").await;
        let record = store
            .find("never-launched")
            .await
            .expect("lookup succeeds")
            .expect("row exists");
        assert!(record.container_name.is_none());

        let result = diagnose_workspace(
            &store,
            &launcher,
            &client,
            &record.workspace_id,
            test_timeouts(),
        )
        .await;
        assert!(matches!(result, Err(DiagnoseWorkspaceError::NoContainer)));
    }

    /// A container that IS running, with both services actually
    /// answering, must be reported healthy with `action: None` — no
    /// stop/start call may ever happen against a genuinely working
    /// workspace.
    #[tokio::test]
    async fn healthy_workspace_is_not_touched() {
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
            .unwrap();
        store
            .mark_ready("healthy-ws", "container-1", wrapper_port, desktop_port)
            .await
            .unwrap();

        let launcher = FakeLauncher::that_reports(ContainerState {
            running: true,
            exit_code: None,
            oom_killed: false,
        });
        let client = reqwest::Client::new();

        let report = diagnose_workspace(&store, &launcher, &client, "id-healthy", test_timeouts())
            .await
            .expect("diagnosis succeeds");

        assert!(report.before.container_running);
        assert!(report.before.wrapper_healthy);
        assert!(report.before.desktop_healthy);
        assert_eq!(report.action, DiagnosisAction::None);
        assert!(report.after.is_none());
        assert_eq!(launcher.stop_count(), 0);
        assert_eq!(launcher.start_existing_count(), 0);
    }

    /// A container that IS unhealthy, and stays unhealthy after the
    /// stop+start cycle, must report `action: Restarted` with a real
    /// `after` snapshot proving it's still broken — not silently upgraded
    /// to "fixed" just because a restart was attempted.
    #[tokio::test]
    async fn unhealthy_workspace_that_stays_unhealthy_is_reported_honestly() {
        let store = temp_store().await;
        store
            .begin_creation("still-broken", "id-broken")
            .await
            .unwrap();
        store
            .mark_ready("still-broken", "container-1", 1, 2)
            .await
            .unwrap();

        let launcher = FakeLauncher::that_reports(unhealthy_state());
        let client = reqwest::Client::new();

        let report = diagnose_workspace(&store, &launcher, &client, "id-broken", test_timeouts())
            .await
            .expect("diagnosis succeeds");

        assert!(!report.before.container_running);
        assert_eq!(report.action, DiagnosisAction::Restarted);
        let after = report.after.expect("after snapshot present");
        assert!(
            !after.container_running,
            "FakeLauncher was not configured to recover — after must still be unhealthy"
        );
        assert_eq!(launcher.stop_count(), 1);
        assert_eq!(launcher.start_existing_count(), 1);

        // The store row must reflect the real (still-broken) outcome.
        let record = store
            .find_by_workspace_id("id-broken")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.status, WorkspaceStatus::Failed);
    }

    /// The real end-to-end success path: unhealthy -> stop+start ->
    /// actually recovers (both the fake Docker state AND real HTTP
    /// listeners on the recorded ports) -> reported as such, and the
    /// store row is updated back to `Ready`. Real listeners are used
    /// (not just `FakeLauncher`'s inspect result) because `after`'s
    /// `wrapper_healthy`/`desktop_healthy` fields come from a REAL HTTP
    /// request against `record.host_port`/`desktop_port` — the container
    /// mock alone cannot make those pass.
    #[tokio::test]
    async fn unhealthy_workspace_that_recovers_is_reported_and_marked_ready_again() {
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
            .begin_creation("recovers", "id-recovers")
            .await
            .unwrap();
        store
            .mark_ready("recovers", "container-1", wrapper_port, desktop_port)
            .await
            .unwrap();

        let launcher = FakeLauncher::that_recovers_after_start(unhealthy_state());
        let client = reqwest::Client::new();

        let report = diagnose_workspace(&store, &launcher, &client, "id-recovers", test_timeouts())
            .await
            .expect("diagnosis succeeds");

        assert!(!report.before.container_running);
        assert_eq!(report.action, DiagnosisAction::Restarted);
        let after = report.after.expect("after snapshot present");
        assert!(after.container_running);
        assert!(after.wrapper_healthy);
        assert!(after.desktop_healthy);
        assert_eq!(launcher.stop_count(), 1);
        assert_eq!(launcher.start_existing_count(), 1);

        let record = store
            .find_by_workspace_id("id-recovers")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.status, WorkspaceStatus::Ready);
    }
}
