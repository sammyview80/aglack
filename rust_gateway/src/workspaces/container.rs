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
#[cfg(test)]
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
///
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
///
/// `pub(crate)` (not just used by `launch` below): `diagnosis.rs`'s heal
/// cycle also waits for a wrapper to come back up after `docker start`,
/// for the exact same reason `launch` waits after `docker create`+`start`
/// — a restarted container's wrapper takes the same real boot time as a
/// freshly created one's.
pub(crate) async fn wait_for_wrapper_ready(
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
///
/// `pub(crate)` — see `wait_for_wrapper_ready`'s doc comment; `diagnosis.rs`
/// reuses this too.
pub(crate) async fn wait_for_desktop_ready(
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

/// Single-attempt (no retry loop) check of whether a workspace's wrapper
/// is answering `/api/wrapper/v1/health` RIGHT NOW — the same endpoint
/// `wait_for_wrapper_ready` polls at launch time, but called once, not in
/// a retry loop: a workspace that already reached `Ready` once is either
/// up or it isn't, there's nothing to "wait for" here. Used by
/// `list_workspaces_route` (see `route.rs` and
/// `../../docs/list-workspaces-plan.md`) to report LIVE health on every
/// `Ready` row, not just the DB's last-written status.
///
/// Takes a reused `reqwest::Client` (the caller's `WorkspacesState`'s
/// `http_client`) rather than constructing a new one per call — unlike
/// `wait_for_wrapper_ready`/`wait_for_desktop_ready` above (called once
/// per container launch, where a fresh client is cheap and inconsequential),
/// this is called once per `Ready` row on EVERY list request, so reusing
/// the client's connection pool actually matters here.
///
/// Returns a plain `bool`, not a `Result` — every failure mode (timeout,
/// connection refused, non-success status) means exactly one thing to a
/// caller of this function: "not healthy right now." There is no
/// separate action to take for a timeout versus a connection error, so
/// there is no error variant worth distinguishing.
pub(crate) async fn check_wrapper_health(
    client: &reqwest::Client,
    wrapper_port: u16,
    timeout: Duration,
) -> bool {
    let health_url = format!("http://127.0.0.1:{wrapper_port}/api/wrapper/v1/health");
    match tokio::time::timeout(timeout, client.get(&health_url).send()).await {
        Ok(Ok(response)) => response.status().is_success(),
        // Either the request itself errored (connection refused, DNS,
        // etc.) or the outer `timeout` elapsed first — both mean "not
        // healthy right now" to this function's caller.
        Ok(Err(_)) | Err(_) => false,
    }
}

/// Same shape and same reasoning as `check_wrapper_health` immediately
/// above, but against the desktop nginx's own root (matching
/// `wait_for_desktop_ready`'s URL) instead of the wrapper's health
/// endpoint. Used by `diagnosis.rs` so a diagnosis report never treats
/// the desktop as a second-class service that "we don't bother"
/// checking live — see `../../docs/diagnose-workspace-plan.md`.
pub(crate) async fn check_desktop_health(
    client: &reqwest::Client,
    desktop_port: u16,
    timeout: Duration,
) -> bool {
    let url = format!("http://127.0.0.1:{desktop_port}/");
    match tokio::time::timeout(timeout, client.get(&url).send()).await {
        Ok(Ok(response)) => response.status().is_success(),
        Ok(Err(_)) | Err(_) => false,
    }
}

#[async_trait]
impl ContainerLauncher for DockerCliLauncher {
    async fn launch(
        &self,
        workspace_id: &str,
    ) -> Result<LaunchedContainer, super::CreateWorkspaceError> {
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

    async fn remove(&self, container_name: &str) -> Result<(), super::CreateWorkspaceError> {
        let output = Command::new("docker")
            .args(["rm", "-f", container_name])
            .output()
            .await
            .map_err(|err| {
                super::CreateWorkspaceError::Container(format!(
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
        Err(super::CreateWorkspaceError::Container(format!(
            "`docker rm -f` failed for container {container_name}: {}",
            detail.trim()
        )))
    }

    async fn inspect(
        &self,
        container_name: &str,
    ) -> Result<ContainerState, super::CreateWorkspaceError> {
        inspect_container_state(container_name).await
    }

    async fn stop(&self, container_name: &str) -> Result<(), super::CreateWorkspaceError> {
        let output = Command::new("docker")
            .args(["stop", container_name])
            .output()
            .await
            .map_err(|err| {
                super::CreateWorkspaceError::Container(format!(
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
        Err(super::CreateWorkspaceError::Container(format!(
            "`docker stop` failed for container {container_name}: {}",
            detail.trim()
        )))
    }

    async fn start_existing(
        &self,
        container_name: &str,
    ) -> Result<(), super::CreateWorkspaceError> {
        run_docker(container_name, &["start", container_name]).await
    }
}

/// Parse `docker inspect --format '{{json .State}}' <container_name>`'s
/// JSON output into a `ContainerState`. A separate free function (not a
/// method) so it can be unit-tested against literal `docker inspect`-shaped
/// JSON strings without needing a real Docker daemon (mirrors this file's
/// existing convention of keeping pure parsing/string-building logic —
/// see `wrapper_boot_script` — separate from the `Command`-running code
/// around it).
async fn inspect_container_state(
    container_name: &str,
) -> Result<ContainerState, super::CreateWorkspaceError> {
    let output = Command::new("docker")
        .args(["inspect", "--format", "{{json .State}}", container_name])
        .output()
        .await
        .map_err(|err| {
            super::CreateWorkspaceError::Container(format!(
                "failed to run `docker inspect` for container {container_name}: {err}"
            ))
        })?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        // A missing container is a real, distinct diagnosis finding (the
        // container was removed entirely, e.g. by something outside this
        // gateway) — not a command failure. `running: false` with no exit
        // code communicates that state; `diagnosis.rs`'s caller decides
        // what to do about it, this function only reports what it saw.
        if detail.contains("No such container") {
            return Ok(ContainerState {
                running: false,
                exit_code: None,
                oom_killed: false,
            });
        }
        return Err(super::CreateWorkspaceError::Container(format!(
            "`docker inspect` failed for container {container_name}: {}",
            detail.trim()
        )));
    }

    parse_container_state_json(&output.stdout, container_name)
}

/// The subset of `docker inspect`'s `.State` object this codebase reads.
/// `#[serde(default)]` on every field: real `docker inspect` output
/// always has all of these, but failing closed (treating a missing field
/// as "not running" / "no exit code" / "not OOM-killed" rather than
/// erroring the whole parse) is safer than a hard parse failure blocking
/// a diagnosis over one unexpected Docker version's field naming.
#[derive(serde::Deserialize)]
struct DockerInspectState {
    #[serde(default, rename = "Running")]
    running: bool,
    #[serde(default, rename = "ExitCode")]
    exit_code: Option<i64>,
    #[serde(default, rename = "OOMKilled")]
    oom_killed: bool,
}

fn parse_container_state_json(
    raw_stdout: &[u8],
    container_name: &str,
) -> Result<ContainerState, super::CreateWorkspaceError> {
    let parsed: DockerInspectState = serde_json::from_slice(raw_stdout).map_err(|err| {
        super::CreateWorkspaceError::Container(format!(
            "failed to parse `docker inspect` output for container {container_name}: {err}"
        ))
    })?;

    Ok(ContainerState {
        running: parsed.running,
        // Docker reports 0 for a container that has never exited (still
        // running) — collapsing that specific case to `None` here, so a
        // real, meaningful non-zero-or-zero exit code is never confused
        // with "hasn't exited yet."
        exit_code: if parsed.running {
            None
        } else {
            parsed.exit_code
        },
        oom_killed: parsed.oom_killed,
    })
}

async fn run_docker(
    container_name: &str,
    args: &[&str],
) -> Result<(), super::CreateWorkspaceError> {
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
#[cfg(test)]
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
}

#[cfg(test)]
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
        }
    }
}

#[cfg(test)]
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
}

#[cfg(test)]
#[async_trait]
impl ContainerLauncher for FakeLauncher {
    async fn launch(
        &self,
        workspace_id: &str,
    ) -> Result<LaunchedContainer, super::CreateWorkspaceError> {
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

    async fn remove(&self, _container_name: &str) -> Result<(), super::CreateWorkspaceError> {
        self.remove_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn inspect(
        &self,
        _container_name: &str,
    ) -> Result<ContainerState, super::CreateWorkspaceError> {
        Ok(*self.inspect_result.lock().unwrap())
    }

    async fn stop(&self, _container_name: &str) -> Result<(), super::CreateWorkspaceError> {
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn start_existing(
        &self,
        _container_name: &str,
    ) -> Result<(), super::CreateWorkspaceError> {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `docker inspect --format '{{json .State}}'` shape for a
    /// currently-running container — `ExitCode` present but must be
    /// ignored (collapsed to `None`) since the container hasn't actually
    /// exited (see `parse_container_state_json`'s doc comment).
    #[test]
    fn parse_container_state_reports_running_with_no_exit_code() {
        let raw = br#"{"Running":true,"ExitCode":0,"OOMKilled":false}"#;
        let state = parse_container_state_json(raw, "some-container").expect("parses");
        assert!(state.running);
        assert_eq!(state.exit_code, None);
        assert!(!state.oom_killed);
    }

    /// A container that exited with a real non-zero code must surface
    /// that exact code — this is the core diagnostic signal a live HTTP
    /// health check alone cannot provide.
    #[test]
    fn parse_container_state_reports_exit_code_for_a_stopped_container() {
        let raw = br#"{"Running":false,"ExitCode":137,"OOMKilled":false}"#;
        let state = parse_container_state_json(raw, "some-container").expect("parses");
        assert!(!state.running);
        assert_eq!(state.exit_code, Some(137));
    }

    #[test]
    fn parse_container_state_reports_oom_killed() {
        let raw = br#"{"Running":false,"ExitCode":137,"OOMKilled":true}"#;
        let state = parse_container_state_json(raw, "some-container").expect("parses");
        assert!(state.oom_killed);
    }

    #[test]
    fn parse_container_state_fails_closed_on_garbage_input() {
        let raw = b"not json at all";
        let result = parse_container_state_json(raw, "some-container");
        assert!(result.is_err());
    }

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

    /// A real (if minimal) HTTP server answering `/api/wrapper/v1/health`
    /// with 200 must be reported healthy — proves the URL construction
    /// and success-status check against a REAL listener, not a mocked
    /// `reqwest::Response`.
    #[tokio::test]
    async fn check_wrapper_health_is_true_when_the_real_endpoint_answers_200() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        tokio::spawn(serve_one_health_ok(listener));

        let client = reqwest::Client::new();
        let healthy = check_wrapper_health(&client, port, Duration::from_secs(2)).await;
        assert!(healthy);
    }

    /// Nothing listening on the port at all (the container crashed, or
    /// was never really there) must be reported unhealthy, not panic or
    /// hang — this is the common real-world case this function exists
    /// to detect.
    #[tokio::test]
    async fn check_wrapper_health_is_false_when_nothing_is_listening() {
        // Bind then immediately drop the listener: frees the OS-assigned
        // port back up while guaranteeing nothing else grabbed it in the
        // meantime for the immediately-following connection attempt.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        drop(listener);

        let client = reqwest::Client::new();
        let healthy = check_wrapper_health(&client, port, Duration::from_secs(2)).await;
        assert!(!healthy);
    }

    /// A listener that accepts the TCP connection but never answers must
    /// be treated as unhealthy once the given timeout elapses — proves
    /// the `tokio::time::timeout` wrapper actually bounds the call, not
    /// just the connect step (a hung/wedged wrapper process would accept
    /// the connection and then never respond, not refuse it outright).
    #[tokio::test]
    async fn check_wrapper_health_is_false_when_the_response_never_comes() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let port = listener.local_addr().expect("read local addr").port();
        tokio::spawn(async move {
            // Accept and hold the connection open without ever writing a
            // response — simulates a hung wrapper process.
            if let Ok((stream, _)) = listener.accept().await {
                std::mem::forget(stream);
            }
        });

        let client = reqwest::Client::new();
        let healthy = check_wrapper_health(&client, port, Duration::from_millis(200)).await;
        assert!(!healthy);
    }

    /// Minimal HTTP/1.1 server: accepts one connection, replies with a
    /// bare `200 OK`, done. Just enough to make `reqwest` see a real
    /// successful HTTP response for the "healthy" test case above —
    /// deliberately not using axum/a real router here, since the only
    /// thing under test is `check_wrapper_health`'s own request/response
    /// handling, not a full HTTP server implementation.
    async fn serve_one_health_ok(listener: TcpListener) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
        }
    }
}
