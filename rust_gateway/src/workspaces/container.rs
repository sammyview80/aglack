//! Turning a workspace_id into a real, running Docker container built from
//! `../../../backend/workspace-image/Dockerfile`. See that Dockerfile's
//! "Unique per-container identity" section for the exact per-container
//! values (name, ports, volumes, PUID/PGID) every launch must assign.
//!
//! `ContainerLauncher` is a trait (not a concrete struct called directly)
//! so `workspaces::create_workspace` never depends on Docker being
//! available to be tested — see `FakeLauncher` below, used by every test
//! in `mod.rs`. This mirrors the architecture doc's guidance: "Docker
//! access behind a trait... so swapping 'talk to local Docker' for 'talk
//! to Nomad/Kubernetes' later is an implementation swap, not a rewrite."

use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::process::Command;

#[async_trait]
pub trait ContainerLauncher: Send + Sync {
    /// Start a new container for `workspace_id` and return its unique
    /// container name (the handle used for every later `docker
    /// start`/`stop`/`exec`/`cp` against it).
    async fn launch(&self, workspace_id: &str) -> Result<String, super::CreateWorkspaceError>;
}

/// Real Docker launcher: shells out to the `docker` CLI (matching the
/// pattern the original reference project uses — see
/// `../../../backend/api/install_docker.py`'s `_run_docker` — rather than
/// talking to the Docker socket directly through a crate like `bollard`;
/// revisit that choice if shelling out becomes a real bottleneck).
///
/// FIRST SLICE ONLY — deliberately narrow. What this does NOT yet do (see
/// ../../docs/create-workspace-plan.md's "does not cover yet" list, and
/// the Dockerfile's own "Unique per-container identity" section for the
/// full list of what a complete launcher must assign):
///   - no host port allocation (the wrapper's port 8787 and the desktop
///     port are not published to any host port yet)
///   - no named volumes for HERMES_HOME/`/workspace` (container state does
///     not survive `docker rm`)
///   - no boot script delivery (the wrapper process inside the container
///     is not started — the container runs webtop's own default init only)
///   - no health-check/readiness wait before returning
/// Each of these is a follow-up change to this struct's `launch` method;
/// none of them require touching `create_workspace` or the HTTP route,
/// since both only depend on the `ContainerLauncher` trait.
pub struct DockerCliLauncher {
    image_tag: String,
}

impl DockerCliLauncher {
    pub fn new(image_tag: String) -> Self {
        Self { image_tag }
    }
}

#[async_trait]
impl ContainerLauncher for DockerCliLauncher {
    async fn launch(&self, workspace_id: &str) -> Result<String, super::CreateWorkspaceError> {
        let container_name = format!("hermes-ws-{workspace_id}");

        let output = Command::new("docker")
            .args(["run", "--detach", "--name", &container_name, &self.image_tag])
            .output()
            .await
            .map_err(|err| {
                super::CreateWorkspaceError::Container(format!(
                    "failed to run docker for container {container_name}: {err}"
                ))
            })?;

        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(super::CreateWorkspaceError::Container(format!(
                "docker run failed for container {container_name}: {}",
                detail.trim()
            )));
        }

        Ok(container_name)
    }
}

/// Test double used by every test in `mod.rs`. Never touches Docker;
/// returns a deterministic, unique container name per call and counts how
/// many times it was actually invoked, which is how the idempotency tests
/// prove a retried key does NOT launch a second container.
///
/// `fail_next_n_calls` lets a test simulate the first N launch attempts
/// failing (e.g. a transient Docker error) before succeeding — this is how
/// `create_workspace`'s "a failed attempt must be retriable" guarantee is
/// tested without needing a real, flaky Docker daemon.
pub struct FakeLauncher {
    call_count: AtomicUsize,
    fail_next_n_calls: AtomicUsize,
}

impl Default for FakeLauncher {
    fn default() -> Self {
        Self {
            call_count: AtomicUsize::new(0),
            fail_next_n_calls: AtomicUsize::new(0),
        }
    }
}

impl FakeLauncher {
    pub fn launch_count(&self) -> usize {
        self.call_count.load(Ordering::SeqCst)
    }

    pub fn that_fails_first(n: usize) -> Self {
        Self {
            call_count: AtomicUsize::new(0),
            fail_next_n_calls: AtomicUsize::new(n),
        }
    }
}

#[async_trait]
impl ContainerLauncher for FakeLauncher {
    async fn launch(&self, workspace_id: &str) -> Result<String, super::CreateWorkspaceError> {
        self.call_count.fetch_add(1, Ordering::SeqCst);

        let remaining_failures = self.fail_next_n_calls.load(Ordering::SeqCst);
        if remaining_failures > 0 {
            self.fail_next_n_calls
                .store(remaining_failures - 1, Ordering::SeqCst);
            return Err(super::CreateWorkspaceError::Container(
                "simulated launch failure".to_string(),
            ));
        }

        Ok(format!("hermes-ws-{workspace_id}"))
    }
}
