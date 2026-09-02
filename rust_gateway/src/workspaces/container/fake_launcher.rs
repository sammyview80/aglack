use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::{ContainerLauncher, ContainerState, LaunchedContainer};

/// Test double used by every test in `mod.rs` (and every other
/// `workspaces::*` test module that needs a `ContainerLauncher` without
/// touching Docker). `#[cfg(test)]` on every item here (not just this
/// doc comment) because nothing outside `cargo test` ever constructs one
/// — without it, a release build correctly reports this as dead code.
///
/// Never touches Docker; returns a deterministic, unique container name +
/// fixed fake ports per call, and counts how many times it was actually
/// invoked, which is how the idempotency tests prove a retried key does
/// NOT launch a second container.
///
/// `fail_next_n_calls` lets a test simulate the first N launch attempts
/// failing (e.g. a transient Docker error) before succeeding — this is how
/// `create_workspace`'s "a failed attempt must be retriable" guarantee is
/// tested without needing a real, flaky Docker daemon.
pub(crate) struct FakeLauncher {
    call_count: AtomicUsize,
    fail_next_n_calls: AtomicUsize,
    remove_count: AtomicUsize,
    stop_count: AtomicUsize,
    start_existing_count: AtomicUsize,
    /// What `inspect` returns, and whether it should switch to a
    /// "recovered" state once `start_existing` has actually been called —
    /// see `that_reports` / `that_recovers_after_start` for how tests
    /// configure this. `std::sync::Mutex` (not an atomic) since
    /// `ContainerState` isn't a single scalar; `FakeLauncher` methods are
    /// only ever awaited from single-threaded test code, so blocking
    /// briefly inside an async fn here is not a real contention risk.
    inspect_result: std::sync::Mutex<ContainerState>,
    recovers_after_start: bool,
    /// What `daemon_reachable` reports — see `set_daemon_reachable` for
    /// how a `daemon_watch.rs` test flips this mid-test to simulate a
    /// real down→up Docker Desktop transition without ever running
    /// `docker info`.
    daemon_reachable: AtomicBool,
}

impl Default for FakeLauncher {
    fn default() -> Self {
        Self {
            call_count: AtomicUsize::new(0),
            fail_next_n_calls: AtomicUsize::new(0),
            remove_count: AtomicUsize::new(0),
            stop_count: AtomicUsize::new(0),
            start_existing_count: AtomicUsize::new(0),
            inspect_result: std::sync::Mutex::new(ContainerState {
                running: true,
                exit_code: None,
                oom_killed: false,
            }),
            recovers_after_start: false,
            daemon_reachable: AtomicBool::new(true),
        }
    }
}

impl FakeLauncher {
    pub(crate) fn launch_count(&self) -> usize {
        self.call_count.load(Ordering::SeqCst)
    }

    pub(crate) fn that_fails_first(n: usize) -> Self {
        Self {
            call_count: AtomicUsize::new(0),
            fail_next_n_calls: AtomicUsize::new(n),
            ..Self::default()
        }
    }

    pub(crate) fn remove_count(&self) -> usize {
        self.remove_count.load(Ordering::SeqCst)
    }

    /// Configure what `inspect` reports, for a test that needs a specific
    /// starting container state (e.g. `running: false` to simulate a
    /// crashed container) without ever running real Docker commands.
    pub(crate) fn that_reports(state: ContainerState) -> Self {
        Self {
            inspect_result: std::sync::Mutex::new(state),
            ..Self::default()
        }
    }

    /// Like `that_reports`, but `inspect` reports the given unhealthy
    /// state UNTIL `start_existing` is actually called, after which it
    /// reports healthy (`running: true`, clean exit) — simulates a real
    /// stop/start cycle actually fixing the container, so diagnosis's
    /// "re-check after healing" step has something real to observe.
    pub(crate) fn that_recovers_after_start(unhealthy_state: ContainerState) -> Self {
        Self {
            inspect_result: std::sync::Mutex::new(unhealthy_state),
            recovers_after_start: true,
            ..Self::default()
        }
    }

    pub(crate) fn stop_count(&self) -> usize {
        self.stop_count.load(Ordering::SeqCst)
    }

    pub(crate) fn start_existing_count(&self) -> usize {
        self.start_existing_count.load(Ordering::SeqCst)
    }

    /// Flip what `daemon_reachable` reports — lets a `daemon_watch.rs`
    /// test simulate a real Docker Desktop kill-then-reopen (down→up)
    /// without ever running a real `docker info` command.
    pub(crate) fn set_daemon_reachable(&self, reachable: bool) {
        self.daemon_reachable.store(reachable, Ordering::SeqCst);
    }
}

#[async_trait]
impl ContainerLauncher for FakeLauncher {
    async fn launch(
        &self,
        workspace_id: &str,
    ) -> Result<LaunchedContainer, super::super::CreateWorkspaceError> {
        self.call_count.fetch_add(1, Ordering::SeqCst);

        let remaining_failures = self.fail_next_n_calls.load(Ordering::SeqCst);
        if remaining_failures > 0 {
            self.fail_next_n_calls
                .store(remaining_failures - 1, Ordering::SeqCst);
            return Err(super::super::CreateWorkspaceError::Container(
                "simulated launch failure".to_string(),
            ));
        }

        let call_count = self.call_count.load(Ordering::SeqCst) as u16;
        Ok(LaunchedContainer {
            container_name: format!("hermes-ws-{workspace_id}"),
            // Deterministic fake ports derived from call count so
            // different calls in a test can be distinguished if ever
            // needed; never real, reachable ports.
            wrapper_port: 40000 + call_count,
            desktop_port: 50000 + call_count,
        })
    }

    async fn remove(&self, _container_name: &str) -> Result<(), super::super::CreateWorkspaceError> {
        self.remove_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn inspect(
        &self,
        _container_name: &str,
    ) -> Result<ContainerState, super::super::CreateWorkspaceError> {
        Ok(*self.inspect_result.lock().unwrap())
    }

    async fn stop(&self, _container_name: &str) -> Result<(), super::super::CreateWorkspaceError> {
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn start_existing(
        &self,
        _container_name: &str,
    ) -> Result<(), super::super::CreateWorkspaceError> {
        self.start_existing_count.fetch_add(1, Ordering::SeqCst);
        if self.recovers_after_start {
            *self.inspect_result.lock().unwrap() = ContainerState {
                running: true,
                exit_code: None,
                oom_killed: false,
            };
        }
        Ok(())
    }

    async fn daemon_reachable(&self) -> bool {
        self.daemon_reachable.load(Ordering::SeqCst)
    }
}
