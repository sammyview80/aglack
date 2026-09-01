use async_trait::async_trait;
use std::time::Duration;
use tokio::process::Command;

use super::boot_script::deliver_boot_script;
use super::desktop::desktop_subfolder_env_arg;
use super::docker_cli::{pick_free_port, run_docker};
use super::health::{wait_for_desktop_ready, wait_for_wrapper_ready};
use super::inspect::inspect_container_state;
use super::{ContainerLauncher, ContainerState, LaunchedContainer};

/// Real Docker launcher: shells out to the `docker` CLI (matching the
/// pattern the original reference project uses — see
/// `../../../backend/api/install_docker.py`'s `_run_docker` — rather than
/// talking to the Docker socket directly through a crate like `bollard`;
/// revisit that choice if shelling out becomes a real bottleneck).
///
/// `launch` does four things, in order:
///   1. `docker create` (not `run`) — publishes BOTH the wrapper's port
///      8787 and the desktop nginx's port 3000 to two HOST ports this
///      launcher picks itself (`pick_free_port`, called twice), but does
///      NOT start the container yet.
///   2. `docker cp`s a generated boot script into the (not-yet-started)
///      container's `/custom-cont-init.d/` — this exact sequence (create,
///      then cp, then start) is REQUIRED: `docker cp` onto an already-
///      running container races s6-overlay's own boot-time creation of
///      that directory, and the Dockerfile bakes in an empty
///      `/custom-cont-init.d/` specifically so a created-not-started
///      container has somewhere to receive this. Verified live (real
///      `docker create`+`cp`+`start`, not assumed from the Dockerfile's
///      own comment) that a hook copied in at this stage really does run
///      at boot.
///   3. `docker start`.
///   4. Polls the wrapper's published port's `/api/wrapper/v1/health`
///      until it answers or a timeout elapses — see
///      `wait_for_wrapper_ready`. This is what makes `Ready` a real
///      guarantee instead of an optimistic guess made the instant `docker
///      start` returns (uvicorn takes a few real seconds to come up
///      inside the container). The desktop (webtop's own default init,
///      not our boot script) reliably comes up faster than the wrapper
///      (confirmed live: ~2s vs the wrapper's ~3.5s) — waiting on the
///      wrapper alone is sufficient in practice, but a light desktop
///      check runs too (see `wait_for_desktop_ready`), so `Ready` never
///      lies about the desktop being reachable either.
///
/// STILL NOT YET DONE — see ../../docs/create-workspace-plan.md's "does
/// not cover yet" list, and the Dockerfile's own "Unique per-container
/// identity" section for the full remaining list:
///   - no named volumes for HERMES_HOME/`/workspace` (container state does
///     not survive `docker rm`)
///
/// None of this requires touching `create_workspace` or the HTTP route,
/// since both only depend on the `ContainerLauncher` trait.
pub struct DockerCliLauncher {
    image_tag: String,
    /// Comma-separated origins a browser may legitimately present when
    /// talking to a workspace's wrapper THROUGH this gateway — passed
    /// straight into the container's `HERMES_WEBUI_ALLOWED_ORIGINS` (see
    /// `boot_script.rs`'s doc comment for why this exists at all).
    /// Real bug found live: hardcoding only the Vite dev-server origin
    /// here missed the equally real "browser hits the gateway's own
    /// published address directly" deployment shape (confirmed live via
    /// a captured real browser request with `Origin:
    /// http://127.0.0.1:8080` — the gateway's own listen address, not
    /// Vite's) — every 403 for that shape happened because that address
    /// was never in the allowlist. Built by the caller (see
    /// `bin/rust_gateway.rs`) from `GatewayConfig::frontend_origin` +
    /// `http://{GatewayConfig::listen_addr()}`, so both shapes are
    /// covered without a second hardcoded guess added here.
    allowed_origins: String,
    /// The default agent's workspace directory INSIDE a workspace
    /// container, e.g. `/workspace/default` — passed straight into the
    /// container's `HERMES_WEBUI_DEFAULT_WORKSPACE` (see
    /// `boot_script.rs`'s doc comment). Built by the caller from
    /// `GatewayConfig::workspace_default_path` (AGENTS.md rule #2: no
    /// hardcoded path here or in the boot script itself).
    workspace_default_path: String,
    /// The frontend origin (Vite dev server / deployed frontend), passed
    /// straight into the container's `HERMES_FRONTEND_ORIGIN` — the
    /// wrapper's own CORS allow-origin, required at startup (see
    /// `boot_script.rs`'s doc comment). Same value as
    /// `GatewayConfig::frontend_origin` — was hardcoded directly in the
    /// boot script until this field existed, the same class of bug
    /// `allowed_origins` and `workspace_default_path` above were already
    /// fixed for (AGENTS.md rule #2: no hardcoded path/URL anywhere
    /// outside `config.rs`).
    frontend_origin: String,
}

impl DockerCliLauncher {
    pub fn new(
        image_tag: String,
        allowed_origins: String,
        workspace_default_path: String,
        frontend_origin: String,
    ) -> Self {
        Self {
            image_tag,
            allowed_origins,
            workspace_default_path,
            frontend_origin,
        }
    }
}

#[async_trait]
impl ContainerLauncher for DockerCliLauncher {
    async fn launch(
        &self,
        workspace_id: &str,
    ) -> Result<LaunchedContainer, super::super::CreateWorkspaceError> {
        let container_name = format!("hermes-ws-{workspace_id}");
        let wrapper_port = pick_free_port().await?;
        let desktop_port = pick_free_port().await?;
        let wrapper_publish_arg = format!("{wrapper_port}:8787");
        let desktop_publish_arg = format!("{desktop_port}:3000");
        let subfolder_env_arg = desktop_subfolder_env_arg(workspace_id);

        run_docker(
            &container_name,
            &[
                "create",
                "--name",
                &container_name,
                "-p",
                &wrapper_publish_arg,
                "-p",
                &desktop_publish_arg,
                "-e",
                &subfolder_env_arg,
                &self.image_tag,
            ],
        )
        .await?;

        deliver_boot_script(
            &container_name,
            &self.allowed_origins,
            &self.workspace_default_path,
            &self.frontend_origin,
        )
        .await?;

        run_docker(&container_name, &["start", &container_name]).await?;

        wait_for_wrapper_ready(wrapper_port, Duration::from_secs(30)).await?;
        wait_for_desktop_ready(workspace_id, desktop_port, Duration::from_secs(15)).await?;

        Ok(LaunchedContainer {
            container_name,
            wrapper_port,
            desktop_port,
        })
    }

    async fn remove(&self, container_name: &str) -> Result<(), super::super::CreateWorkspaceError> {
        let output = Command::new("docker")
            .args(["rm", "-f", container_name])
            .output()
            .await
            .map_err(|err| {
                super::super::CreateWorkspaceError::Container(format!(
                    "failed to run `docker rm -f` for container {container_name}: {err}"
                ))
            })?;
        if output.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        if detail.contains("No such container") {
            return Ok(());
        }
        Err(super::super::CreateWorkspaceError::Container(format!(
            "`docker rm -f` failed for container {container_name}: {}",
            detail.trim()
        )))
    }

    async fn inspect(
        &self,
        container_name: &str,
    ) -> Result<ContainerState, super::super::CreateWorkspaceError> {
        inspect_container_state(container_name).await
    }

    async fn stop(&self, container_name: &str) -> Result<(), super::super::CreateWorkspaceError> {
        let output = Command::new("docker")
            .args(["stop", container_name])
            .output()
            .await
            .map_err(|err| {
                super::super::CreateWorkspaceError::Container(format!(
                    "failed to run `docker stop` for container {container_name}: {err}"
                ))
            })?;
        if output.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        // Matches `remove`'s "missing/already-gone is success" convention
        // — a container already stopped (or already removed) has nothing
        // left for `stop` to do.
        if detail.contains("No such container") {
            return Ok(());
        }
        Err(super::super::CreateWorkspaceError::Container(format!(
            "`docker stop` failed for container {container_name}: {}",
            detail.trim()
        )))
    }

    async fn start_existing(
        &self,
        container_name: &str,
    ) -> Result<(), super::super::CreateWorkspaceError> {
        run_docker(container_name, &["start", container_name]).await
    }
}
