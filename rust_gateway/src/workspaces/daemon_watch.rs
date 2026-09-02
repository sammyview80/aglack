//! Background watcher: notices when the Docker daemon itself goes down
//! (e.g. Docker Desktop killed) and comes back up (reopened), and on that
//! exact down→up transition, makes sure every workspace the store
//! believes is `Ready` actually has a running container again.
//!
//! This is deliberately narrow — it does NOT run the diagnose/heal cycle
//! continuously or on every poll tick (that would be a much heavier,
//! different feature: continuous self-healing of individual container
//! crashes unrelated to the daemon itself). It only reacts to the daemon
//! itself having been unreachable and then becoming reachable again,
//! which is the one moment EVERY workspace's container is guaranteed to
//! have been stopped (Docker Desktop being killed stops the whole VM, not
//! just the daemon process) — see `../../docs/diagnose-workspace-plan.md`
//! for the per-container, on-demand diagnosis this reuses for the actual
//! "is it healthy, and if not, stop+start it" work.
//!
//! `poll_interval` and the reachability check are both parameters (not
//! hardcoded), matching `DiagnosisTimeouts`'s own "production() vs a
//! test's short values" convention — a test drives this loop with a fake
//! clock-free sleep and a `FakeLauncher` whose `daemon_reachable` it
//! flips directly, never a real 30-second wait.

use std::sync::Arc;
use std::time::Duration;

use super::diagnosis::{diagnose_workspace, DiagnosisTimeouts};
use super::route::WorkspacesState;
use super::{ContainerLauncher, WorkspaceStore};

/// How often to poll the Docker daemon's reachability. 30s: frequent
/// enough that a reopened Docker Desktop's containers come back within a
/// bounded, human-reasonable time, infrequent enough that `docker info`
/// (a real subprocess spawn) is not a meaningful load on the host.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Runs forever (intended for `tokio::spawn`, never awaited to
/// completion in production). Polls `launcher.daemon_reachable()` every
/// `poll_interval`; the FIRST time reachability flips from `false` to
/// `true` after having been observed `false`, every `Ready` workspace
/// with a recorded container is re-diagnosed (which starts it back up if
/// it isn't running — see `diagnose_workspace`).
///
/// Deliberately does NOT treat "never yet observed the daemon as down" as
/// a transition — a freshly started gateway whose very first poll finds
/// the daemon already up must not immediately re-diagnose every
/// workspace; there was no outage to recover from.
///
/// Takes the whole `Arc<WorkspacesState>` (the same state the HTTP routes
/// share) rather than separate `store`/`launcher`/`http_client`
/// parameters — this is the identical real store and launcher every
/// route already uses, not a second independent copy; cloning the `Arc`
/// (cheap, a refcount bump) is enough for this to run as its own
/// long-lived task without ever blocking or being blocked by request
/// handling.
pub async fn run(state: Arc<WorkspacesState>, poll_interval: Duration) {
    // `None` = not yet observed; `Some(bool)` = the last observed
    // reachability. Starting at `None` (not `Some(true)`) is what makes
    // "daemon already up on the very first poll" correctly NOT count as
    // a recovery — see the doc comment above.
    let mut last_reachable: Option<bool> = None;

    loop {
        let reachable = state.launcher.daemon_reachable().await;

        let recovered = matches!(last_reachable, Some(false)) && reachable;
        if recovered {
            println!(
                "rust_gateway: Docker daemon back up after being unreachable — \
                 re-checking all Ready workspaces"
            );
            heal_all_ready_workspaces(&state.store, state.launcher.as_ref(), &state.http_client)
                .await;
        }
        if last_reachable == Some(true) && !reachable {
            eprintln!(
                "rust_gateway: Docker daemon unreachable (docker info failed) — \
                 will re-check workspace containers once it comes back"
            );
        }

        last_reachable = Some(reachable);
        tokio::time::sleep(poll_interval).await;
    }
}

/// Re-diagnose (and, if needed, heal) every workspace the store currently
/// believes is `Ready`. Best-effort per workspace: one workspace's
/// diagnosis erroring must not stop the others from being checked — a
/// single bad row should not mean every other genuinely-recoverable
/// workspace is left down.
async fn heal_all_ready_workspaces(
    store: &WorkspaceStore,
    launcher: &dyn ContainerLauncher,
    http_client: &reqwest::Client,
) {
    let ready = match store.list_ready_with_container().await {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!(
                "rust_gateway: daemon_watch failed to list Ready workspaces after \
                 daemon recovery: {err}"
            );
            return;
        }
    };

    for record in ready {
        let result = diagnose_workspace(
            store,
            launcher,
            http_client,
            &record.workspace_id,
            DiagnosisTimeouts::production(),
        )
        .await;

        match result {
            Ok(report) => {
                if !matches!(
                    report.action,
                    super::diagnosis::DiagnosisAction::None
                ) {
                    println!(
                        "rust_gateway: daemon_watch re-checked workspace {:?} after daemon \
                         recovery — action: {:?}",
                        record.workspace_id, report.action
                    );
                }
            }
            Err(err) => {
                eprintln!(
                    "rust_gateway: daemon_watch failed to diagnose workspace {:?} after \
                     daemon recovery: {err:?}",
                    record.workspace_id
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::container::{ContainerState, FakeLauncher};
    use crate::workspaces::create_workspace;
    use crate::workspaces::test_support::temp_store;

    /// End-to-end proof of the actual feature the user asked for: a
    /// workspace whose container is NOT running (simulating "Docker
    /// Desktop was killed, taking every container down with it") is
    /// started back up once the watcher observes the daemon go
    /// false→true, using a real `store.list_ready_with_container` +
    /// `diagnose_workspace` heal cycle — not a mocked assertion of "the
    /// function was called."
    #[tokio::test]
    async fn a_ready_workspace_with_a_stopped_container_is_started_after_daemon_recovers() {
        let store = temp_store().await;
        // Kept as a concrete `Arc<FakeLauncher>` (not just the trait
        // object) so the test can reach `FakeLauncher`'s own
        // test-control methods (`set_daemon_reachable`,
        // `start_existing_count`) directly — `ContainerLauncher` itself
        // deliberately does not expose test-only inspection methods.
        let fake_launcher = Arc::new(FakeLauncher::that_recovers_after_start(ContainerState {
            running: false,
            exit_code: Some(137),
            oom_killed: false,
        }));
        let launcher: Arc<dyn ContainerLauncher> = fake_launcher.clone();

        // Real Ready workspace, container recorded — but `inspect` will
        // report `running: false` until `start_existing` is actually
        // called (see `that_recovers_after_start`), simulating the
        // daemon having taken every container down with it.
        create_workspace(&store, launcher.as_ref(), "ws-a")
            .await
            .expect("create succeeds");

        let state = Arc::new(WorkspacesState {
            store,
            launcher,
            http_client: reqwest::Client::new(),
        });

        // Daemon starts unreachable, then becomes reachable — the exact
        // down→up transition the watcher must react to.
        fake_launcher.set_daemon_reachable(false);

        let watch_handle = {
            let state = state.clone();
            tokio::spawn(async move {
                run(state, Duration::from_millis(10)).await;
            })
        };

        // Give the watcher time to observe the "down" state at least
        // once before flipping to "up" — otherwise the very first poll
        // could already see `true` and correctly treat it as "never was
        // down", which would NOT be testing the recovery path.
        tokio::time::sleep(Duration::from_millis(30)).await;
        fake_launcher.set_daemon_reachable(true);

        // Wait for the watcher to observe the recovery and run the heal
        // cycle. Polling the real, observable outcome (container started)
        // rather than a fixed sleep-then-hope.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if fake_launcher.start_existing_count() > 0 {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!(
                    "daemon_watch did not start the stopped container within the deadline \
                     (start_existing_count = {})",
                    fake_launcher.start_existing_count()
                );
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        watch_handle.abort();

        assert_eq!(
            fake_launcher.start_existing_count(),
            1,
            "the stopped container must be started exactly once after daemon recovery"
        );

        let record = state
            .store
            .find("ws-a")
            .await
            .expect("lookup succeeds")
            .expect("row exists");
        assert_eq!(
            record.status,
            crate::workspaces::WorkspaceStatus::Ready,
            "after the heal cycle actually recovers the container, the store must \
             reflect Ready again, not stay stuck at Failed"
        );
    }

    /// A daemon that is already reachable on the very FIRST poll (no
    /// prior observed outage) must NOT trigger the heal cycle — there is
    /// nothing to recover from, and re-diagnosing every workspace on
    /// every gateway boot would be wasteful and could spuriously restart
    /// perfectly healthy containers.
    #[tokio::test]
    async fn a_daemon_already_up_on_first_poll_does_not_trigger_a_heal_cycle() {
        let store = temp_store().await;
        let fake_launcher = Arc::new(FakeLauncher::default());
        let launcher: Arc<dyn ContainerLauncher> = fake_launcher.clone();
        create_workspace(&store, launcher.as_ref(), "ws-a")
            .await
            .expect("create succeeds");
        // Default FakeLauncher already reports daemon_reachable() = true.

        let state = Arc::new(WorkspacesState {
            store,
            launcher,
            http_client: reqwest::Client::new(),
        });

        let watch_handle = {
            let state = state.clone();
            tokio::spawn(async move {
                run(state, Duration::from_millis(10)).await;
            })
        };

        // Let several poll ticks pass with the daemon staying reachable
        // the whole time.
        tokio::time::sleep(Duration::from_millis(60)).await;
        watch_handle.abort();

        assert_eq!(
            fake_launcher.start_existing_count(),
            0,
            "no daemon outage ever happened, so no container should have been \
             (re)started"
        );
    }
}
