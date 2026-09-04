use async_trait::async_trait;
use std::time::Duration;
use tokio::process::Command;

use super::boot_script::deliver_boot_script;
use super::desktop::desktop_subfolder_env_arg;
use super::docker_cli::{docker_daemon_reachable, pick_free_port, run_docker};
use super::health::{wait_for_desktop_ready_at, wait_for_wrapper_ready_at};
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
    /// This gateway's own address, as reachable FROM INSIDE a workspace
    /// container — passed straight into the container's
    /// `GATEWAY_INTERNAL_URL` (see `boot_script.rs`'s doc comment and
    /// `docs/integrations-plan.md`'s infra section). NOT the same value
    /// as `GatewayConfig::listen_addr()` in general — a container-side
    /// `127.0.0.1`/`localhost` would resolve to the CONTAINER itself, not
    /// the host, so this is a required, separately-configured value
    /// (AGENTS.md rule #2: no hardcoded/guessed host here), typically
    /// `http://host.docker.internal:<port>` on macOS/Windows or the
    /// host's real LAN/bridge address on Linux.
    gateway_internal_url: String,
    /// `docker create --memory <value>` — see
    /// `config::WorkspacesConfig::workspace_memory_limit`'s own doc
    /// comment for the real bug/request this exists for. Configured, not
    /// hardcoded (AGENTS.md rule #2) — set via `WORKSPACE_MEMORY_LIMIT`
    /// in `.env`, defaults to `4g` if unset.
    memory_limit: String,
    /// `docker create --shm-size <value>` — see
    /// `config::WorkspacesConfig::workspace_shm_size`'s own doc comment.
    /// Configured via `WORKSPACE_SHM_SIZE` in `.env`, defaults to `1g`.
    shm_size: String,
    /// `BROWSER_IDLE_TIMEOUT_MINUTES` injected into the container's
    /// `browser_manager.py` daemon via its own boot-script block — see
    /// `config::WorkspacesConfig::workspace_browser_idle_timeout_minutes`'s
    /// own doc comment. Configured via
    /// `WORKSPACE_BROWSER_IDLE_TIMEOUT_MINUTES` in `.env`, defaults to
    /// `4` (minutes); `0` means "never idle-kill".
    browser_idle_timeout_minutes: String,
}

impl DockerCliLauncher {
    pub fn new(
        image_tag: String,
        allowed_origins: String,
        workspace_default_path: String,
        frontend_origin: String,
        gateway_internal_url: String,
        memory_limit: String,
        shm_size: String,
        browser_idle_timeout_minutes: String,
    ) -> Self {
        Self {
            image_tag,
            allowed_origins,
            workspace_default_path,
            frontend_origin,
            gateway_internal_url,
            memory_limit,
            shm_size,
            browser_idle_timeout_minutes,
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
        // A previous failed launch can leave the named container behind
        // (for example after the gateway died between `docker create` and
        // cleanup). This launcher is only called for a non-ready workspace,
        // so the name is stale by definition: remove it before retrying.
        // Ignore "No such container"; that is the normal fresh-launch case.
        let _ = Command::new("docker")
            .args(["rm", "-f", &container_name])
            .output()
            .await;
        let wrapper_port = pick_free_port().await?;
        let desktop_port = pick_free_port().await?;
        let browser_port = pick_free_port().await?;
        let wrapper_publish_arg = format!("{wrapper_port}:8787");
        let desktop_publish_arg = format!("{desktop_port}:3000");
        // `9400` is the browser-manager daemon's OWN container-internal
        // default port (see `backend/workspace-image/browser_manager.py`'s
        // `DEFAULT_PORT`/`BROWSER_MANAGER_PORT`) — inline literal here,
        // matching this file's existing convention for the other two
        // fixed container-side ports (`:8787`, `:3000` above), neither of
        // which is a named const either. Not read from `config.rs`: this
        // is not a network address this gateway process itself connects
        // to directly by that literal (AGENTS.md rule #2 targets
        // host/port/URL VALUES a caller could need to change per
        // deployment); it is the OTHER side of a `docker create -p`
        // mapping whose host-side port is always the freshly-picked
        // `browser_port` above — the container-internal port is fixed by
        // the image itself, exactly like `:8787`/`:3000` already are.
        //
        // `127.0.0.1:{browser_port}:9400` — EXPLICIT host-side bind
        // address, unlike `wrapper_publish_arg`/`desktop_publish_arg`
        // above (which publish to Docker's default `0.0.0.0`, reachable
        // from any network interface on this machine). This is
        // deliberate, not an inconsistency to "fix" to match the other
        // two: `browser_manager.py`'s daemon has no auth of its own
        // (unlike the wrapper, which sits behind this gateway's own
        // session/bearer checks) — it is a raw control plane that can
        // start/stop a real Chromium process and read any agent's
        // persistent profile directory by id. The daemon itself binds
        // `0.0.0.0` INSIDE the container (real bug found live: a
        // loopback-only bind there is unreachable through ANY Docker
        // publish mapping from outside the container, including from
        // this gateway itself, which runs as a bare host process, not
        // inside a container — see `browser_manager.py`'s own
        // `BROWSER_MANAGER_HOST` doc comment for the full story). The
        // "never reachable from outside this machine" property that
        // loopback bind was originally meant to provide is enforced HERE
        // instead, on the host side of the publish, where it actually
        // works: `127.0.0.1:<port>` is reachable from this machine (where
        // the gateway runs) but never from another machine on the
        // network.
        let browser_publish_arg = format!("127.0.0.1:{browser_port}:9400");
        let subfolder_env_arg = desktop_subfolder_env_arg(workspace_id);

        // `--shm-size`/`--memory` — REAL BUG found live (a real Chromium
        // crash reproduced inside a real running container, `chrome://
        // crashes`-style "Aw, Snap!" / Error code 5): Docker's default
        // `/dev/shm` is a fixed 64MB tmpfs, far too small for a real,
        // VISIBLE (not `--headless`) Chromium with a GPU process —
        // confirmed live via `docker exec <container> df -h /dev/shm`
        // showing exactly 64M total on a crashing container. Chromium
        // (and most Chromium-family browsers generally) use `/dev/shm`
        // heavily for inter-process shared memory between the browser/
        // GPU/renderer processes; once it fills, renderer/GPU processes
        // crash outright rather than degrading gracefully. The default
        // (`1g`, configurable via `WORKSPACE_SHM_SIZE` — see
        // `self.shm_size`'s own doc comment on the struct above) RAISES
        // the maximum tmpfs CAPACITY, it does not eagerly allocate/
        // consume that much real memory up front (tmpfs is demand-paged)
        // — confirmed real, not a guessed tradeoff. Ruled out other real
        // candidate causes first, on the same live container, before
        // concluding `/dev/shm` was the actual fix: not OOM-killed
        // (`docker inspect --format '{{.State.OOMKilled}}'` was `false`),
        // not a same-profile double-launch race (every Chromium
        // subprocess's own `--user-data-dir` pointed at the SAME single
        // profile — the daemon's process-wide lock, see
        // `browser_manager.py`'s own `BrowserManager` doc comment,
        // correctly prevented two live processes for one agent).
        //
        // `--memory` (default `4g`, configurable via
        // `WORKSPACE_MEMORY_LIMIT`): a real, explicit per-container cap —
        // previously ABSENT entirely (every workspace container could use
        // up to the WHOLE Docker Desktop VM's memory, unbounded), added
        // alongside `--shm-size` for the same real reason (a visible
        // Chromium + GPU process is genuinely heavier than this image's
        // other workloads) and because an unbounded container is its own
        // real operational risk once several workspaces run browsers at
        // once (one runaway container could starve every other
        // workspace on the same host).
        run_docker(
            &container_name,
            &[
                "create",
                "--name",
                &container_name,
                "--memory",
                &self.memory_limit,
                "--shm-size",
                &self.shm_size,
                "-p",
                &wrapper_publish_arg,
                "-p",
                &desktop_publish_arg,
                "-p",
                &browser_publish_arg,
                "-e",
                &subfolder_env_arg,
                &self.image_tag,
            ],
        )
        .await?;

        let launch_result = async {
            deliver_boot_script(
                &container_name,
                &self.allowed_origins,
                &self.workspace_default_path,
                &self.frontend_origin,
                workspace_id,
                &self.gateway_internal_url,
                &self.browser_idle_timeout_minutes,
            )
            .await?;

            run_docker(&container_name, &["start", &container_name]).await?;

            let health_host = reqwest::Url::parse(&self.gateway_internal_url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| "127.0.0.1".to_string());
            wait_for_wrapper_ready_at(&health_host, wrapper_port, Duration::from_secs(30)).await?;
            wait_for_desktop_ready_at(&health_host, workspace_id, desktop_port, Duration::from_secs(15)).await?;
            Ok::<_, super::super::CreateWorkspaceError>(())
        }
        .await;

        if let Err(err) = launch_result {
            // A health/readiness failure happens after `docker create`; remove
            // the failed attempt before the retry reuses this deterministic
            // workspace name.
            let _ = self.remove(&container_name).await;
            return Err(err);
        }

        // Deliberately NO readiness wait for `browser_port`, unlike the
        // wrapper/desktop waits directly above — two reasons, together:
        //   1. Unlike the wrapper/desktop, a slow-to-start browser-manager
        //      daemon does not need to gate the whole workspace's `Ready`
        //      status: nothing else inside the container depends on it
        //      being up (the wrapper and desktop are core to "is this
        //      workspace usable at all"; the browser-manager daemon is
        //      only needed by the narrow, separately-opt-in browser
        //      feature — see `workspaces/proxy/browser_proxy.rs`).
        //   2. It has no dedicated health endpoint to poll (its own
        //      `_AGENT_PATH_RE` only ever matches `/agents/<id>/<action>`
        //      — there is no bare `/health`), so a real check here could
        //      only be a plain TCP connect, which proves the daemon's
        //      `ThreadingHTTPServer` has bound the port, not that it can
        //      actually service a request — a materially weaker guarantee
        //      than `wait_for_wrapper_ready`'s real HTTP health check.
        //      Given (1), that weaker guarantee is not worth the extra
        //      launch latency and complexity; `browser_proxy.rs`'s own
        //      `forward_to` already surfaces a clear 502 "backend
        //      unreachable" if a caller reaches it before the daemon has
        //      bound its port, which is an acceptable, self-explanatory
        //      failure mode for a feature this narrow.
        Ok(LaunchedContainer {
            container_name,
            wrapper_port,
            desktop_port,
            browser_port,
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

    async fn daemon_reachable(&self) -> bool {
        docker_daemon_reachable().await
    }
}
