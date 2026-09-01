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
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::time::sleep;

/// A launched container's identity: the Docker container name (used for
/// later `docker start`/`stop`/`exec`/`cp`) and the two HOST ports it
/// publishes — `wrapper_port` (the wrapper's `/api/wrapper/v1`, container
/// port 8787) and `desktop_port` (the webtop desktop's nginx, container
/// port 3000). Used by the onboarding/hermes-webui/desktop proxy routes
/// (see `resolve.rs`) to forward a request to THIS specific workspace
/// instead of one fixed backend_addr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchedContainer {
    pub container_name: String,
    pub wrapper_port: u16,
    pub desktop_port: u16,
}

#[async_trait]
pub trait ContainerLauncher: Send + Sync {
    /// Start a new container for `workspace_id` and return its identity
    /// ONLY once its wrapper is actually answering health checks — see
    /// `DockerCliLauncher::launch`'s readiness wait. A `Ready` workspace
    /// record must mean "you can really reach this workspace's onboarding
    /// endpoints now", not merely "docker start succeeded".
    async fn launch(&self, workspace_id: &str) -> Result<LaunchedContainer, super::CreateWorkspaceError>;
}

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
/// None of this requires touching `create_workspace` or the HTTP route,
/// since both only depend on the `ContainerLauncher` trait.
pub struct DockerCliLauncher {
    image_tag: String,
}

impl DockerCliLauncher {
    pub fn new(image_tag: String) -> Self {
        Self { image_tag }
    }
}

/// Ask the OS for a free ephemeral port by binding to port 0, reading back
/// whatever it assigned, then dropping the listener immediately so `docker
/// create -p` can bind it instead.
///
/// Known, accepted, small race: something else on the host could claim
/// this exact port in the gap between the listener dropping and `docker
/// start` actually binding it (a launch failure in that rare case is
/// retried like any other launch failure — see `mod.rs`'s
/// `launch_and_record` — not a correctness bug, just a documented
/// TOCTOU window inherent to this technique).
async fn pick_free_port() -> Result<u16, super::CreateWorkspaceError> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|err| {
        super::CreateWorkspaceError::Container(format!("failed to pick a free host port: {err}"))
    })?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| {
            super::CreateWorkspaceError::Container(format!(
                "failed to read back picked host port: {err}"
            ))
        })
}

/// The `/custom-cont-init.d/` hook that starts the wrapper (which runs
/// upstream in-process) inside a freshly created container, run once at
/// boot after webtop's own s6-overlay has remapped `abc` to its final
/// PUID/PGID.
///
/// Mirrors the ORIGINAL reference project's own boot-script pattern for
/// the exact same problem (see
/// `<original-project>/api/install_docker.py`'s
/// `_server_workspace_boot_command`): detached via `setsid`, run as `abc`
/// via `su -s /bin/sh abc -c '...'` (this base image's `/bin/sh` is
/// busybox ash, which has no `disown` builtin — `setsid` is the
/// equivalent that works here, confirmed by that same original project).
///
/// Runs under `/opt/hermes/.venv/bin/python` — the AGENT's venv, NOT a
/// separate wrapper-only venv (that used to exist; see
/// `backend/workspace-image/Dockerfile`'s "Install the wrapper INTO the
/// agent's own venv" comment for the real live bug this fixes: a separate
/// venv can never `from run_agent import AIAgent`, since it never has the
/// agent's own compiled dependencies like pydantic-core — this surfaced
/// live as `AIAgent not available -- check that hermes-agent is on
/// sys.path`). `HERMES_WEBUI_AGENT_DIR=/opt/hermes` tells the wrapper's
/// (upstream's) own agent-discovery exactly where to find `run_agent.py` —
/// auto-discovery alone does not find it, since upstream's own candidate
/// list checks `/opt/hermes-agent`, not the `/opt/hermes` path this image
/// actually uses.
///
/// `git config --global --add safe.directory /opt/hermes-webui/upstream`
/// is REQUIRED, not cosmetic — verified live: without it, `abc` running
/// `bootstrap_upstream()`'s own `git rev-parse HEAD` check fails with
/// "detected dubious ownership" (the upstream checkout is root-owned at
/// build time, `abc` is a different uid), which
/// `hermes_webui_wrapper.upstream._resolve_revision` silently swallows
/// into `"unknown"`, which then fails the wrapper's own fail-closed pin
/// check and crashes uvicorn before it ever binds a port. This one `git
/// config` line is the difference between the wrapper starting and it
/// crash-looping silently with no obvious cause from outside the
/// container. (`/opt/hermes` itself has no `.git` dir at all — confirmed
/// live — so no equivalent line is needed for it.)
fn wrapper_boot_script() -> String {
    // HERMES_FRONTEND_ORIGIN: the wrapper's CORS allow-origin — required
    // at startup (config.py's Settings.from_env fails closed without it),
    // even though this container's wrapper is normally reached SERVER-TO-
    // SERVER through rust_gateway's onboarding proxy route (CORS is a
    // browser-only concept, so it does not gate that path) — a browser
    // could still hit this container's published port directly, and the
    // wrapper must have a valid config to start at all regardless. Same
    // value as rust_gateway's own FRONTEND_ORIGIN (see
    // backend/wrapper/.env.example) — verified live: omitting this line
    // crashes uvicorn before it binds a port, exactly like the missing
    // safe.directory fix did.
    "#!/usr/bin/env sh\n\
     # hermes-webui-wrapper-boot — see DockerCliLauncher::launch\n\
     set -e\n\
     mkdir -p /config/.hermes\n\
     chown -R abc:abc /config/.hermes 2>/dev/null || true\n\
     setsid su -s /bin/sh abc -c '\n\
     export HOME=/config\n\
     export HERMES_HOME=/config/.hermes\n\
     export HERMES_WEBUI_AGENT_DIR=/opt/hermes\n\
     export HERMES_WRAPPER_HOST=0.0.0.0\n\
     export HERMES_WRAPPER_PORT=8787\n\
     export HERMES_FRONTEND_ORIGIN=http://localhost:5173\n\
     git config --global --add safe.directory /opt/hermes-webui/upstream \
       || echo \"hermes-webui-wrapper-boot: safe.directory config failed\" >&2\n\
     cd /opt/hermes-webui/wrapper\n\
     exec /opt/hermes/.venv/bin/hermes-webui-wrapper\n\
     ' >/config/hermes-webui-wrapper.log 2>&1 &\n\
     exit 0\n"
        .to_string()
}

/// Poll `http://127.0.0.1:<port>/api/wrapper/v1/health` until it returns a
/// successful HTTP response, or `timeout` elapses. Short, frequent
/// retries — the wrapper crashing loudly and fast (as it does when
/// `wrapper_boot_script`'s safe.directory step is missing) should fail
/// this wait quickly, not silently wait the full timeout every time.
async fn wait_for_wrapper_ready(
    wrapper_port: u16,
    timeout: Duration,
) -> Result<(), super::CreateWorkspaceError> {
    let health_url = format!("http://127.0.0.1:{wrapper_port}/api/wrapper/v1/health");
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + timeout;
    let poll_interval = Duration::from_millis(500);

    loop {
        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(super::CreateWorkspaceError::Container(format!(
                "wrapper at {health_url} did not become healthy within {timeout:?}"
            )));
        }
        sleep(poll_interval).await;
    }
}

/// Poll `http://127.0.0.1:<port>/` (the desktop nginx's own root — see
/// `desktop_proxy.rs`'s module doc for the confirmed-live nginx config)
/// until it answers or `timeout` elapses. Verified live that the desktop
/// reliably comes up faster than the wrapper (~2s vs ~3.5s), so this is a
/// short timeout — it exists to make `Ready` a real guarantee for the
/// desktop too, not because the desktop is expected to be the slow part.
async fn wait_for_desktop_ready(
    desktop_port: u16,
    timeout: Duration,
) -> Result<(), super::CreateWorkspaceError> {
    let url = format!("http://127.0.0.1:{desktop_port}/");
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + timeout;
    let poll_interval = Duration::from_millis(500);

    loop {
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(super::CreateWorkspaceError::Container(format!(
                "desktop at {url} did not become ready within {timeout:?}"
            )));
        }
        sleep(poll_interval).await;
    }
}

#[async_trait]
impl ContainerLauncher for DockerCliLauncher {
    async fn launch(&self, workspace_id: &str) -> Result<LaunchedContainer, super::CreateWorkspaceError> {
        let container_name = format!("hermes-ws-{workspace_id}");
        let wrapper_port = pick_free_port().await?;
        let desktop_port = pick_free_port().await?;
        let wrapper_publish_arg = format!("{wrapper_port}:8787");
        let desktop_publish_arg = format!("{desktop_port}:3000");

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
                &self.image_tag,
            ],
        )
        .await?;

        deliver_boot_script(&container_name).await?;

        run_docker(&container_name, &["start", &container_name]).await?;

        wait_for_wrapper_ready(wrapper_port, Duration::from_secs(30)).await?;
        wait_for_desktop_ready(desktop_port, Duration::from_secs(15)).await?;

        Ok(LaunchedContainer {
            container_name,
            wrapper_port,
            desktop_port,
        })
    }
}

async fn run_docker(container_name: &str, args: &[&str]) -> Result<(), super::CreateWorkspaceError> {
    let output = Command::new("docker")
        .args(args)
        .output()
        .await
        .map_err(|err| {
            super::CreateWorkspaceError::Container(format!(
                "failed to run `docker {}` for container {container_name}: {err}",
                args.join(" ")
            ))
        })?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(super::CreateWorkspaceError::Container(format!(
            "`docker {}` failed for container {container_name}: {}",
            args.join(" "),
            detail.trim()
        )));
    }

    Ok(())
}

/// Writes `wrapper_boot_script()` to a real temp file and `docker cp`'s it
/// into the (created-but-not-yet-started) container's
/// `/custom-cont-init.d/` — see `DockerCliLauncher`'s own doc comment for
/// why this must happen between `create` and `start`, not after.
async fn deliver_boot_script(container_name: &str) -> Result<(), super::CreateWorkspaceError> {
    let script = wrapper_boot_script();
    let tmp_file = tempfile::Builder::new()
        .prefix("hermes-webui-wrapper-boot-")
        .suffix(".sh")
        .tempfile()
        .map_err(|err| {
            super::CreateWorkspaceError::Container(format!(
                "failed to create temp boot script file: {err}"
            ))
        })?;
    std::fs::write(tmp_file.path(), script).map_err(|err| {
        super::CreateWorkspaceError::Container(format!("failed to write boot script: {err}"))
    })?;

    let dest = format!("{container_name}:/custom-cont-init.d/hermes-webui-wrapper-boot.sh");
    run_docker(
        container_name,
        &["cp", tmp_file.path().to_str().unwrap_or_default(), &dest],
    )
    .await
}

/// Test double used by every test in `mod.rs`. Never touches Docker;
/// returns a deterministic, unique container name + fixed fake ports per
/// call, and counts how many times it was actually invoked, which is how
/// the idempotency tests prove a retried key does NOT launch a second
/// container.
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
    async fn launch(&self, workspace_id: &str) -> Result<LaunchedContainer, super::CreateWorkspaceError> {
        self.call_count.fetch_add(1, Ordering::SeqCst);

        let remaining_failures = self.fail_next_n_calls.load(Ordering::SeqCst);
        if remaining_failures > 0 {
            self.fail_next_n_calls
                .store(remaining_failures - 1, Ordering::SeqCst);
            return Err(super::CreateWorkspaceError::Container(
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pure string-content assertions on the generated boot script — the
    /// real `docker create`/`cp`/`start` sequence + actual container
    /// behavior is verified by a separate manual end-to-end run (see
    /// CHECKPOINT.md), not by an automated test here: this crate's
    /// existing convention (see `FakeLauncher`'s own doc comment) is to
    /// keep unit tests Docker-free, not to spin up real containers in
    /// `cargo test`.
    #[test]
    fn boot_script_sets_safe_directory_before_starting_wrapper() {
        let script = wrapper_boot_script();
        assert!(
            script.contains("git config --global --add safe.directory /opt/hermes-webui/upstream"),
            "missing the safe.directory fix — without it abc's git rev-parse fails with \
             'dubious ownership' and the wrapper crash-loops silently (verified live)"
        );
    }

    #[test]
    fn boot_script_runs_wrapper_as_abc_not_root() {
        let script = wrapper_boot_script();
        assert!(script.contains("su -s /bin/sh abc -c"));
    }

    #[test]
    fn boot_script_sets_required_wrapper_env_vars() {
        let script = wrapper_boot_script();
        assert!(script.contains("export HERMES_HOME=/config/.hermes"));
        assert!(script.contains("export HERMES_WRAPPER_HOST=0.0.0.0"));
        assert!(script.contains("export HERMES_WRAPPER_PORT=8787"));
        assert!(
            script.contains("export HERMES_FRONTEND_ORIGIN="),
            "missing HERMES_FRONTEND_ORIGIN — the wrapper's config.py fails closed at \
             startup without it (verified live), crashing uvicorn before it binds a port"
        );
        assert!(
            script.contains("export HERMES_WEBUI_AGENT_DIR=/opt/hermes"),
            "missing HERMES_WEBUI_AGENT_DIR — without it upstream's agent auto-discovery \
             never finds /opt/hermes (its own candidate list checks /opt/hermes-agent, not \
             this image's actual /opt/hermes path), and every chat request fails with \
             'AIAgent not available' (verified live)"
        );
    }

    #[test]
    fn boot_script_runs_wrapper_under_the_agents_venv_not_a_separate_one() {
        let script = wrapper_boot_script();
        assert!(
            script.contains("exec /opt/hermes/.venv/bin/hermes-webui-wrapper"),
            "the wrapper must run under the AGENT's venv (/opt/hermes/.venv), not a \
             separate wrapper-only venv — a separate venv can never `from run_agent \
             import AIAgent` (it lacks the agent's own compiled deps like pydantic-core), \
             which is the real live bug this fixes"
        );
    }

    #[test]
    fn boot_script_runs_detached_and_exits_zero_quickly() {
        let script = wrapper_boot_script();
        // custom-cont-init.d hooks must exit 0 quickly (they run before
        // s6's long-running services start) — the wrapper is started
        // detached (setsid ... &) rather than this script waiting on it.
        assert!(script.trim_end().ends_with("exit 0"));
        assert!(script.contains("setsid su"));
    }
}
