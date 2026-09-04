//! Turning a workspace_id into a real, running Docker container built from
//! `../../../../backend/workspace-image/Dockerfile`. See that Dockerfile's
//! "Unique per-container identity" section for the exact per-container
//! values (name, ports, volumes, PUID/PGID) every launch must assign.
//!
//! `ContainerLauncher` is a trait (not a concrete struct called directly)
//! so `workspaces::create_workspace` never depends on Docker being
//! available to be tested — see `fake_launcher.rs`, used by every test
//! in `mod.rs` (the parent `workspaces` module). This mirrors the
//! architecture doc's guidance: "Docker access behind a trait... so
//! swapping 'talk to local Docker' for 'talk to Nomad/Kubernetes' later
//! is an implementation swap, not a rewrite."
//!
//! Submodules, by responsibility:
//! - `docker_launcher` — `DockerCliLauncher`, the real `ContainerLauncher`
//!   impl that shells out to the `docker` CLI.
//! - `boot_script` — builds and delivers the `/custom-cont-init.d/` hook
//!   that starts the wrapper inside a freshly created container.
//! - `desktop` — the desktop's subpath/`SUBFOLDER` value, shared between
//!   the boot script, launch, and health checks.
//! - `health` — polling/one-shot HTTP health checks for the wrapper and
//!   desktop, reused by both launch and `diagnosis.rs`.
//! - `inspect` — parses `docker inspect` output into `ContainerState`.
//! - `docker_cli` — the two smallest shared `docker` CLI primitives
//!   (`run_docker`, `pick_free_port`).
//! - `fake_launcher` — `FakeLauncher`, the Docker-free test double.

use async_trait::async_trait;

mod boot_script;
mod desktop;
mod docker_cli;
mod docker_launcher;
#[cfg(test)]
mod fake_launcher;
mod health;
mod inspect;

pub use docker_launcher::DockerCliLauncher;
#[cfg(test)]
pub(crate) use fake_launcher::FakeLauncher;
pub(crate) use health::{
    check_desktop_health_at, check_wrapper_health_at,
    wait_for_desktop_ready, wait_for_wrapper_ready,
};

/// A launched container's identity: the Docker container name (used for
/// later `docker start`/`stop`/`exec`/`cp`) and the three HOST ports it
/// publishes — `wrapper_port` (the wrapper's `/api/wrapper/v1`, container
/// port 8787), `desktop_port` (the webtop desktop's nginx, container port
/// 3000), and `browser_port` (the browser-manager daemon, see
/// `backend/workspace-image/browser_manager.py`, container port 9400).
/// Used by the onboarding/hermes-webui/desktop/browser proxy routes (see
/// `resolve.rs`) to forward a request to THIS specific workspace instead
/// of one fixed backend_addr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchedContainer {
    pub container_name: String,
    pub wrapper_port: u16,
    pub desktop_port: u16,
    pub browser_port: u16,
}

/// Real, live Docker container state — see `ContainerLauncher::inspect`.
/// Every field here is read from `docker inspect`, never inferred or
/// defaulted, except `running` when a container does not exist at all
/// (see that method's doc comment for that one case).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerState {
    pub running: bool,
    /// `None` while the container has never exited (still running, or —
    /// same as Docker's own `docker inspect` — has no exit code recorded
    /// yet). `Some(0)` is a clean exit; a diagnosis caller treats ANY
    /// non-running state as unhealthy regardless of the exact code, but
    /// the real code is still surfaced for a human reading the report.
    pub exit_code: Option<i64>,
    pub oom_killed: bool,
}

#[async_trait]
pub trait ContainerLauncher: Send + Sync {
    /// Start a new container for `workspace_id` and return its identity
    /// ONLY once its wrapper is actually answering health checks — see
    /// `DockerCliLauncher::launch`'s readiness wait. A `Ready` workspace
    /// record must mean "you can really reach this workspace's onboarding
    /// endpoints now", not merely "docker start succeeded".
    async fn launch(
        &self,
        workspace_id: &str,
    ) -> Result<LaunchedContainer, super::CreateWorkspaceError>;

    /// Stop and remove a previously launched container. A missing
    /// container is success (already gone) — delete must still be able to
    /// drop the store row.
    async fn remove(&self, container_name: &str) -> Result<(), super::CreateWorkspaceError>;

    /// Real, live Docker state for an EXISTING container — see
    /// `../../docs/diagnose-workspace-plan.md`'s "real diagnosis" section
    /// for why this (not just an HTTP health check) is needed: it is the
    /// only way to distinguish "the container process itself is gone"
    /// from "the container is up but the wrapper inside hung."
    async fn inspect(
        &self,
        container_name: &str,
    ) -> Result<ContainerState, super::CreateWorkspaceError>;

    /// Stop (not remove) a running container — the container and its
    /// data survive; only the process inside is signaled to exit. Used by
    /// diagnosis's stop-then-start recovery cycle, never by `delete`
    /// (which calls `remove` instead). A container that is already
    /// stopped is success, matching `remove`'s "missing = already done"
    /// convention.
    async fn stop(&self, container_name: &str) -> Result<(), super::CreateWorkspaceError>;

    /// Start an EXISTING, already-created container — distinct from
    /// `launch`, which `docker create`s a brand new one. Used by
    /// diagnosis's recovery cycle after `stop`; the container keeps its
    /// original name and published ports (Docker does not reassign `-p`
    /// mappings across a stop/start cycle).
    async fn start_existing(&self, container_name: &str)
        -> Result<(), super::CreateWorkspaceError>;

    /// Cheap, real liveness check for the Docker daemon itself (not any
    /// one container) — used by `daemon_watch.rs` to detect a down→up
    /// transition (e.g. Docker Desktop was killed, then reopened) and
    /// trigger starting workspace containers back up. On the trait (not a
    /// free function) so `FakeLauncher` can simulate a daemon outage in
    /// tests without ever running a real `docker` command.
    async fn daemon_reachable(&self) -> bool;
}
