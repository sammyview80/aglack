use std::path::Path;

use super::docker_cli::run_docker;

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
///
/// HERMES_FRONTEND_ORIGIN: the wrapper's CORS allow-origin — required
/// at startup (config.py's Settings.from_env fails closed without it),
/// even though this container's wrapper is normally reached SERVER-TO-
/// SERVER through rust_gateway's onboarding proxy route (CORS is a
/// browser-only concept, so it does not gate that path) — a browser
/// could still hit this container's published port directly, and the
/// wrapper must have a valid config to start at all regardless. Takes
/// the value as a parameter (AGENTS.md rule #2: no hardcoded URL here) —
/// built by the caller from `GatewayConfig::frontend_origin`, the SAME
/// value rust_gateway's own CORS layer uses (see
/// `DockerCliLauncher::frontend_origin`'s doc comment) — verified live:
/// omitting this line crashes uvicorn before it binds a port, exactly
/// like the missing safe.directory fix did.
///
/// HERMES_WEBUI_ALLOWED_ORIGINS: a DIFFERENT var from the CORS one
/// above — read by transport/handler.py's align_loopback_proxy_host()
/// to decide whether to rewrite an inbound Host header to match a
/// loopback browser Origin before upstream's CSRF check runs. Real bug
/// found live: rust_gateway's forward_to() strips Host (correctly —
/// reqwest sets the real target) but forwards Origin unchanged, so the
/// wrapper sees the BROWSER's real Origin against a Host that names
/// this container's own published port — upstream's
/// api/routes.py:_check_same_origin_browser_request treats that as a
/// cross-origin request and rejects onboarding setup/complete/settings
/// POSTs with 403 "Cross-origin mismatch - check reverse proxy
/// headers", even for a legitimate same-machine browser session.
/// align_loopback_proxy_host() exists specifically to fix this, but
/// was permanently inert without this var ever being set. Takes the
/// FULL set of legitimate browser origins as a parameter (comma-
/// separated, passed straight through) rather than hardcoding one —
/// real bug found live a SECOND time: hardcoding only the Vite
/// dev-server origin here missed a browser hitting the gateway's own
/// published address directly (confirmed live via a captured real
/// request with `Origin: http://127.0.0.1:8080`, the gateway's own
/// listen address). See `DockerCliLauncher::allowed_origins`'s doc
/// comment for how the caller builds this value.
///
/// HERMES_WEBUI_DEFAULT_WORKSPACE: upstream's own env var
/// (api/config.py's `_discover_default_workspace()`) for the default
/// agent's workspace directory. Never set here before — upstream's own
/// fallback chain then resolved to `~/workspace` under this script's
/// `HOME=/config`, i.e. `/config/workspace`, which is why the onboarding
/// UI showed `/config/workspace` as the default workspace. Takes the
/// value as a parameter (AGENTS.md rule #2: no hardcoded path here) —
/// built by the caller from `GatewayConfig::workspace_default_path`, see
/// `DockerCliLauncher::workspace_default_path`'s doc comment.
///
/// `mkdir -p <workspace_default_path> && chown -R abc:abc
/// <parent-of-workspace_default_path>` runs as ROOT, before the
/// `su -s /bin/sh abc -c '...'` block, for the same reason
/// `/config/.hermes` does — verified live: `/` is not writable by `abc`
/// (uid 911) in this base image, so `abc` itself cannot create a
/// top-level directory like `/workspace`; only a pre-created, chowned
/// directory is usable inside the `abc`-run block. `mkdir -p` creates
/// every missing parent as root, so this works regardless of how deep
/// the configured path is.
///
/// Chowns the PARENT of `workspace_default_path` (e.g. `/workspace`, not
/// just `/workspace/default`), not merely the leaf directory itself —
/// real bug found live via an actual end-to-end apply-mode call:
/// `features/agent_seeder/service.py`'s `_ensure_agent_workspace` needs
/// to `mkdir` a SIBLING directory per seeded agent (`/workspace/pm`,
/// `/workspace/writer`, ...) at runtime, as `abc`; chowning only the leaf
/// `default` directory left `/workspace` itself root-owned
/// (`drwxr-xr-x root root`), so every such `mkdir` failed with
/// `PermissionError: [Errno 13] Permission denied`. A test asserting
/// `script.contains("chown -R abc:abc /workspace")` had passed the whole
/// time WITHOUT catching this — that substring is also a prefix of
/// `chown -R abc:abc /workspace/default`, so it never actually proved the
/// PARENT got chowned; see this file's own tests for the exact-match fix.
/// Falls back to chowning `workspace_default_path` itself (not its
/// parent) only if that parent computes to the filesystem root `/` —
/// chowning `/` itself would be both wrong and dangerous.
///
/// Upstream's own `_ensure_workspace_dir()` also calls
/// `mkdir(parents=True, exist_ok=True)` on every start, so the `mkdir -p`
/// here is belt-and-suspenders for the FIRST boot specifically, not a
/// duplicate of logic upstream is missing.
/// The directory the boot script should `chown -R abc:abc` so that `abc`
/// can create SIBLING directories of `workspace_default_path` at runtime
/// (see `wrapper_boot_script`'s own doc comment for the real bug this
/// fixes) — the parent of `workspace_default_path`, unless that parent
/// would be the filesystem root `/`, in which case `workspace_default_path`
/// itself is returned instead (never chown `/`).
fn workspace_chown_target(workspace_default_path: &str) -> String {
    let parent = Path::new(workspace_default_path).parent();
    match parent {
        Some(p) if p != Path::new("/") && !p.as_os_str().is_empty() => {
            p.to_string_lossy().into_owned()
        }
        _ => workspace_default_path.to_string(),
    }
}

pub(crate) fn wrapper_boot_script(
    allowed_origins: &str,
    workspace_default_path: &str,
    frontend_origin: &str,
    workspace_id: &str,
    gateway_internal_url: &str,
    browser_idle_timeout_minutes: &str,
) -> String {
    let workspace_chown_target = workspace_chown_target(workspace_default_path);
    format!(
        "#!/usr/bin/env sh\n\
     # hermes-webui-wrapper-boot — see DockerCliLauncher::launch\n\
     set -e\n\
     mkdir -p /config/.hermes\n\
     chown -R abc:abc /config/.hermes 2>/dev/null || true\n\
     mkdir -p {workspace_default_path}\n\
     chown -R abc:abc {workspace_chown_target} 2>/dev/null || true\n\
     mkdir -p /run/hermes\n\
     chown -R abc:abc /run/hermes 2>/dev/null || true\n\
     setsid su -s /bin/sh abc -c '\n\
     export HOME=/config\n\
     export HERMES_HOME=/config/.hermes\n\
     export HERMES_WEBUI_AGENT_DIR=/opt/hermes\n\
     export HERMES_WRAPPER_HOST=0.0.0.0\n\
     export HERMES_WRAPPER_PORT=8787\n\
     export HERMES_FRONTEND_ORIGIN={frontend_origin}\n\
     export HERMES_WEBUI_ALLOWED_ORIGINS={allowed_origins}\n\
     export HERMES_WEBUI_DEFAULT_WORKSPACE={workspace_default_path}\n\
     export INTEGRATIONS_WORKSPACE_ID={workspace_id}\n\
     export GATEWAY_INTERNAL_URL={gateway_internal_url}\n\
     git config --global --add safe.directory /opt/hermes-webui/upstream \
       || echo \"hermes-webui-wrapper-boot: safe.directory config failed\" >&2\n\
     cd /opt/hermes-webui/wrapper\n\
     exec /opt/hermes/.venv/bin/hermes-webui-wrapper\n\
     ' >/config/hermes-webui-wrapper.log 2>&1 &\n\
     {browser_manager_launch_line}\
     {desktop_terminal_launch_line}\
     exit 0\n",
        browser_manager_launch_line = browser_manager_launch_line(browser_idle_timeout_minutes),
        desktop_terminal_launch_line = desktop_terminal_launch_line(),
    )
}

/// The `setsid su -s /bin/sh abc -c '...'` block that starts ONE visible
/// `xterm` on the workspace's KasmVNC desktop (`DISPLAY=:1`) at boot.
///
/// Real usability regression found live: `patch_kasmvnc_hide_control_bar.py`
/// and `patch_kasmvnc_hide_lsbar.py` deliberately hide every KasmVNC/LSIO
/// bar, and IceWM in this image auto-starts nothing — so a fresh workspace
/// desktop showed ONLY the wallpaper (Xvnc + IceWM confirmed running via
/// `docker exec`, no client windows at all) with no UI path left for a user
/// to open a terminal. A manual `xterm` as `abc` on `:1` was confirmed to
/// produce a visible terminal; this block does exactly that at boot.
///
/// `/custom-cont-init.d/` hooks run BEFORE s6's long-running services (the
/// Xvnc server included), so the block polls for the `:1` X socket
/// (`/tmp/.X11-unix/X1`) before `exec`ing — an immediate `xterm` would die
/// with "can't open display" and never come back. The poll is bounded
/// (`sleep 1`, up to 60 tries) so a broken Xvnc never leaves a process
/// spinning forever. Same detached `setsid`/as-`abc`/own-logfile shape as
/// the wrapper and browser-manager blocks above.
fn desktop_terminal_launch_line() -> String {
    "setsid su -s /bin/sh abc -c '\n\
     export HOME=/config\n\
     export DISPLAY=:1\n\
     i=0\n\
     while [ ! -S /tmp/.X11-unix/X1 ] && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done\n\
     exec xterm\n\
     ' >/config/hermes-desktop-terminal.log 2>&1 &\n"
        .to_string()
}

/// The `setsid su -s /bin/sh abc -c '...'` block that starts
/// `browser_manager.py` (see `backend/workspace-image/browser_manager.py`)
/// detached, inside the same boot script as the wrapper above — mirrors
/// that exact backgrounding shape (`setsid`, run as `abc` not root, output
/// redirected to its own log file rather than the wrapper's) so this
/// daemon survives the same way the wrapper does.
///
/// No `BROWSER_MANAGER_PORT` env var is set here: the daemon's own default
/// (9400, see that file's `DEFAULT_PORT`) never needs to differ — the
/// container-internal port is fixed by the image and only ever reached
/// via the separately published `browser_port` host mapping (see
/// `DockerCliLauncher::launch`'s `browser_publish_arg`); no other process
/// inside this container is expected to also want port 9400, so there is
/// no collision to avoid by overriding it.
///
/// Invoked as a bare `python3` — this file is DELIBERATELY stdlib-only
/// (see its own module docstring: "no `pyproject.toml`/install step of
/// its own... nothing in this Dockerfile installs this file as a package
/// or guarantees which interpreter invokes it"), unlike the wrapper above
/// which runs a specific installed console-script
/// (`/opt/hermes/.venv/bin/hermes-webui-wrapper`) from its own installed
/// package. Using a bare `python3` (resolved via `PATH`, which this image
/// sets to prefer `/opt/hermes/.venv/bin` first) matches that file's own
/// stated design rather than hardcoding one specific interpreter path
/// this daemon's own docstring says not to depend on.
/// `browser_idle_timeout_minutes` becomes `BROWSER_IDLE_TIMEOUT_MINUTES`
/// in the daemon's own environment — see
/// `config::WorkspacesConfig::workspace_browser_idle_timeout_minutes`'s
/// own doc comment for the real request this exists to satisfy
/// ("configure it for lifetime or after 4 min or anything") and
/// `backend/workspace-image/browser_manager.py`'s own module-level
/// `BROWSER_IDLE_TIMEOUT_MINUTES` doc comment for how the daemon
/// consumes it (a plain `float(...)` parse, `<= 0` meaning "never idle-
/// kill"). Passed through VERBATIM — this function does no numeric
/// validation of its own, matching `WorkspacesConfig`'s own "parsed by
/// the real consumer, not duplicated here" contract for
/// `workspace_memory_limit`/`workspace_shm_size`.
fn browser_manager_launch_line(browser_idle_timeout_minutes: &str) -> String {
    format!(
        "setsid su -s /bin/sh abc -c '\n\
     export DISPLAY=:1\n\
     export BROWSER_IDLE_TIMEOUT_MINUTES={browser_idle_timeout_minutes}\n\
     exec python3 /opt/hermes-browser-manager/browser_manager.py\n\
     ' >/config/hermes-browser-manager.log 2>&1 &\n"
    )
}

/// Writes `wrapper_boot_script(allowed_origins, workspace_default_path,
/// frontend_origin, workspace_id, gateway_internal_url)` to a real temp
/// file and `docker cp`'s it into the (created-but-not-yet-started)
/// container's `/custom-cont-init.d/` — see `DockerCliLauncher`'s own doc
/// comment for why this must happen between `create` and `start`, not
/// after.
///
/// `workspace_id`/`gateway_internal_url` exist so the container's own
/// wrapper process can resolve `INTEGRATIONS_WORKSPACE_ID`/
/// `GATEWAY_INTERNAL_URL` (see `backend/wrapper/src/hermes_webui_wrapper/config.py`'s
/// `resolve_integrations_workspace_id`/`resolve_gateway_internal_url`) —
/// without these, nothing inside the container can call the gateway's
/// `/workspaces/:id/mcp` tenancy proxy for itself, since a container has
/// no other way to learn its own workspace id (see
/// `docs/integrations-plan.md`, task #4).
///
/// This creates `/run/hermes` (owned by `abc`) at boot so the integrations
/// token file (`docs/integrations-poc-findings.md`'s security model,
/// delivered separately, AFTER boot, by
/// `crate::integrations::token_delivery::deliver_token_file` — connecting
/// an integration happens long after container creation, not at boot
/// time) has somewhere writable to land.
pub(crate) async fn deliver_boot_script(
    container_name: &str,
    allowed_origins: &str,
    workspace_default_path: &str,
    frontend_origin: &str,
    workspace_id: &str,
    gateway_internal_url: &str,
    browser_idle_timeout_minutes: &str,
) -> Result<(), super::super::CreateWorkspaceError> {
    let script = wrapper_boot_script(
        allowed_origins,
        workspace_default_path,
        frontend_origin,
        workspace_id,
        gateway_internal_url,
        browser_idle_timeout_minutes,
    );
    let tmp_file = tempfile::Builder::new()
        .prefix("hermes-webui-wrapper-boot-")
        .suffix(".sh")
        .tempfile()
        .map_err(|err| {
            super::super::CreateWorkspaceError::Container(format!(
                "failed to create temp boot script file: {err}"
            ))
        })?;
    std::fs::write(tmp_file.path(), script).map_err(|err| {
        super::super::CreateWorkspaceError::Container(format!("failed to write boot script: {err}"))
    })?;

    let dest = format!("{container_name}:/custom-cont-init.d/hermes-webui-wrapper-boot.sh");
    run_docker(
        container_name,
        &["cp", tmp_file.path().to_str().unwrap_or_default(), &dest],
    )
    .await
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
    /// See `docs/integrations-plan.md`, task #4: without these two, the
    /// wrapper's `resolve_integrations_workspace_id`/
    /// `resolve_gateway_internal_url` (`backend/wrapper/src/hermes_webui_wrapper/config.py`)
    /// fail closed and nothing inside the container can call this
    /// gateway's `/workspaces/:id/mcp` tenancy proxy for itself.
    #[test]
    fn boot_script_sets_integrations_env_vars_from_caller_supplied_values() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-abc123",
            "http://host.docker.internal:8080",
            "4",
        );
        assert!(
            script.contains("export INTEGRATIONS_WORKSPACE_ID=ws-abc123"),
            "missing INTEGRATIONS_WORKSPACE_ID, or not using the caller-supplied workspace_id"
        );
        assert!(
            script.contains("export GATEWAY_INTERNAL_URL=http://host.docker.internal:8080"),
            "missing GATEWAY_INTERNAL_URL, or not using the caller-supplied value"
        );
    }

    /// `/run/hermes` must exist and be `abc`-owned before the integrations
    /// token file can ever be `docker cp`'d in post-boot (see
    /// `crate::integrations::token_delivery::deliver_token_file`) — a
    /// container whose boot script never created this directory would
    /// reject that `docker cp` outright.
    #[test]
    fn boot_script_creates_and_chowns_run_hermes_for_the_integrations_token_file() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        assert!(script.contains("mkdir -p /run/hermes"));
        assert!(script
            .lines()
            .any(|line| line.trim() == "chown -R abc:abc /run/hermes 2>/dev/null || true"),);
    }

    #[test]
    fn boot_script_sets_safe_directory_before_starting_wrapper() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        assert!(
            script.contains("git config --global --add safe.directory /opt/hermes-webui/upstream"),
            "missing the safe.directory fix — without it abc's git rev-parse fails with \
             'dubious ownership' and the wrapper crash-loops silently (verified live)"
        );
    }

    #[test]
    fn boot_script_runs_wrapper_as_abc_not_root() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        assert!(script.contains("su -s /bin/sh abc -c"));
    }

    /// The browser-manager daemon (see
    /// `backend/workspace-image/browser_manager.py`, copied into the
    /// image at `/opt/hermes-browser-manager/browser_manager.py`) must
    /// also be launched by this boot script — mirrors
    /// `boot_script_runs_wrapper_as_abc_not_root`'s exact style: before
    /// this, NOTHING started it, so `DockerCliLauncher::launch` published
    /// a `browser_port` that nothing inside the container was ever
    /// listening on.
    #[test]
    fn boot_script_launches_the_browser_manager_daemon_as_abc_not_root() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        assert!(
            script.contains("python3 /opt/hermes-browser-manager/browser_manager.py"),
            "missing the browser-manager daemon launch line, or using the wrong path — must \
             match the Dockerfile's own COPY destination exactly: got {script}"
        );
        assert!(
            script.matches("su -s /bin/sh abc -c").count() >= 2,
            "the browser-manager daemon must be started the SAME way the wrapper is — as \
             `abc`, not root — not merely present somewhere in the script"
        );
    }

    /// Real bug found live: without this, `browser_manager.py`'s spawned
    /// Chromium child processes had no `DISPLAY` to render onto at all —
    /// `default_launch_chromium` deliberately runs a VISIBLE (not
    /// `--headless`) Chromium onto this container's own KasmVNC virtual
    /// desktop (`DISPLAY=:1`), but that value is a real, s6-overlay-
    /// exposed container env var, never automatically inherited by a
    /// `su -s /bin/sh abc -c '...'`-spawned shell (the exact same
    /// isolation gap `GATEWAY_INTERNAL_URL`/`INTEGRATIONS_WORKSPACE_ID`/
    /// `HERMES_HOME` already needed explicit `export` lines for, in the
    /// WRAPPER's own boot block, for the identical reason).
    #[test]
    fn boot_script_exports_display_before_launching_browser_manager() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        let browser_manager_block_start = script
            .find("python3 /opt/hermes-browser-manager/browser_manager.py")
            .expect("browser-manager launch line must exist — see the sibling test");
        let display_export_idx = script
            .find("export DISPLAY=:1")
            .expect("missing `export DISPLAY=:1` — Chromium has no target to render onto \
                     without it, and this daemon's own `su -c` shell does not inherit it");
        assert!(
            display_export_idx < browser_manager_block_start,
            "DISPLAY must be exported BEFORE the browser-manager daemon starts, in the SAME \
             `su -c` block — a value set after the daemon's own `exec` line, or in a \
             different block entirely, never reaches Chromium's own eventual subprocess env"
        );
    }

    /// Real, requested configurability: `WORKSPACE_BROWSER_IDLE_TIMEOUT_MINUTES`
    /// must actually reach `browser_manager.py`'s own environment as
    /// `BROWSER_IDLE_TIMEOUT_MINUTES` — see
    /// `config::WorkspacesConfig::workspace_browser_idle_timeout_minutes`'s
    /// own doc comment for the real user request this satisfies.
    #[test]
    fn boot_script_exports_the_caller_supplied_browser_idle_timeout() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "17",
        );
        let browser_manager_block_start = script
            .find("python3 /opt/hermes-browser-manager/browser_manager.py")
            .expect("browser-manager launch line must exist — see the sibling test");
        let idle_timeout_export_idx = script
            .find("export BROWSER_IDLE_TIMEOUT_MINUTES=17")
            .expect(
                "missing `export BROWSER_IDLE_TIMEOUT_MINUTES=<caller-supplied value>` — \
                 without it, browser_manager.py falls back to its own hardcoded default \
                 instead of the value this gateway was actually configured with",
            );
        assert!(
            idle_timeout_export_idx < browser_manager_block_start,
            "BROWSER_IDLE_TIMEOUT_MINUTES must be exported BEFORE the browser-manager \
             daemon starts, in the SAME `su -c` block — same requirement as DISPLAY above"
        );
    }

    /// `0` (the real "lifetime"/"never idle-kill" opt-out) must pass
    /// through verbatim, not be treated as "unset" or rejected — this
    /// function does no numeric validation of its own by design (see its
    /// own doc comment).
    #[test]
    fn boot_script_passes_through_a_zero_idle_timeout_verbatim() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "0",
        );
        assert!(script.contains("export BROWSER_IDLE_TIMEOUT_MINUTES=0"));
    }

    /// Real usability regression found live: after the KasmVNC control bar
    /// (`patch_kasmvnc_hide_control_bar.py`) and the LSIO app bar
    /// (`patch_kasmvnc_hide_lsbar.py`) were deliberately hidden, a fresh
    /// workspace desktop showed ONLY the wallpaper — Xvnc and IceWM were
    /// running fine, but nothing ever started a terminal, and the hidden
    /// bars removed every UI path a user had to launch one. Every new
    /// workspace must boot with one visible `xterm` for the desktop user.
    #[test]
    fn boot_script_launches_one_visible_xterm_for_the_desktop_user() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        let xterm_idx = script
            .find("exec xterm")
            .expect("missing the xterm launch line — a fresh desktop shows only wallpaper without it");
        let block_start = script[..xterm_idx]
            .rfind("su -s /bin/sh abc -c")
            .expect("xterm must run inside its own `su -s /bin/sh abc -c` block, as abc not root");
        let display_export_idx = script[block_start..xterm_idx]
            .find("export DISPLAY=:1")
            .expect("DISPLAY must be exported inside the xterm block, before xterm starts");
        assert!(display_export_idx < xterm_idx - block_start);
        assert!(
            script.matches("exec xterm").count() == 1,
            "exactly ONE terminal per workspace, not one per boot block"
        );
    }

    /// `/custom-cont-init.d/` hooks run BEFORE s6's long-running services
    /// (including Xvnc) start, so an `xterm` launched immediately would fail
    /// with "can't open display" and never come back. The xterm block must
    /// wait for the `:1` X socket to appear before exec'ing, and must be
    /// bounded so a broken Xvnc never leaves a stuck process behind.
    #[test]
    fn boot_script_waits_for_the_x_display_socket_before_launching_xterm() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        let xterm_idx = script.find("exec xterm").expect("see sibling test");
        let block_start = script[..xterm_idx]
            .rfind("su -s /bin/sh abc -c")
            .expect("see sibling test");
        let block = &script[block_start..xterm_idx];
        assert!(
            block.contains("/tmp/.X11-unix/X1"),
            "xterm block must wait on the :1 X socket before exec — got {block}"
        );
        assert!(
            block.contains("sleep"),
            "the wait must poll (sleep) rather than spin — got {block}"
        );
    }

    #[test]
    fn boot_script_sets_required_wrapper_env_vars() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
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
        assert!(
            script.contains("export HERMES_WEBUI_ALLOWED_ORIGINS="),
            "missing HERMES_WEBUI_ALLOWED_ORIGINS — without it, transport/handler.py's \
             align_loopback_proxy_host() never rewrites Host to match a loopback browser \
             Origin, so upstream's CSRF check rejects onboarding setup/complete with 403 \
             'Cross-origin mismatch - check reverse proxy headers' (verified live)"
        );
        assert!(
            script.contains("export HERMES_WEBUI_DEFAULT_WORKSPACE=/workspace/default"),
            "missing HERMES_WEBUI_DEFAULT_WORKSPACE — without it upstream falls back to \
             ~/workspace under this script's HOME=/config, i.e. /config/workspace, which is \
             the wrong default (verified live: this was the exact path shown on the \
             onboarding finish screen before this fix)"
        );
        assert!(
            script.contains("mkdir -p /workspace/default"),
            "the /workspace/default directory must be created (as root, before the abc-run \
             block) — verified live: / is not writable by abc (uid 911) in this base image, \
             so abc itself cannot create /workspace"
        );
        assert!(
            script
                .lines()
                .any(|line| line.trim() == "chown -R abc:abc /workspace 2>/dev/null || true"),
            "without chowning /workspace (the PARENT of /workspace/default) to abc, agent-seeder \
             cannot mkdir a per-agent sibling directory like /workspace/pm at runtime as abc — \
             verified live via a real end-to-end apply-mode call: PermissionError: [Errno 13] \
             Permission denied: '/workspace/pm'. Exact line match, NOT .contains(\"chown -R \
             abc:abc /workspace\") — that substring is also a prefix of \
             'chown -R abc:abc /workspace/default' and would pass even if only the LEAF got \
             chowned, which is exactly the bug that shipped and was caught live, not by this \
             test, the first time"
        );
    }

    /// Real bug found live a SECOND time (after the first
    /// HERMES_WEBUI_ALLOWED_ORIGINS fix): a real browser session captured
    /// hitting the gateway's own published address directly
    /// (`Origin: http://127.0.0.1:8080`) still got the same 403 — that
    /// origin was never in the allowlist because it was hardcoded to only
    /// the Vite dev-server origin. `wrapper_boot_script` must actually
    /// use the CALLER-SUPPLIED value, not a baked-in constant, so every
    /// legitimate origin (Vite dev server AND the gateway's own real
    /// listen address) can be threaded through from `GatewayConfig` (see
    /// `bin/rust_gateway.rs`).
    #[test]
    fn boot_script_uses_the_caller_supplied_allowed_origins_value_verbatim() {
        let script = wrapper_boot_script(
            "http://localhost:5173,http://127.0.0.1:8080",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        assert!(
            script.contains(
                "export HERMES_WEBUI_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:8080"
            ),
            "wrapper_boot_script must pass its allowed_origins parameter straight through, \
             not silently fall back to a hardcoded single origin — a hardcoded single origin \
             is the exact live bug this parameterization fixes (a browser hitting the \
             gateway's own address directly was rejected because that origin was never in \
             the old hardcoded list)"
        );
    }

    /// `HERMES_WEBUI_DEFAULT_WORKSPACE` and the `mkdir`/`chown` targets
    /// must come from the caller-supplied parameter, not a baked-in
    /// `/workspace/default` constant (AGENTS.md rule #2: no hardcoded
    /// path) — an operator configuring a different `WORKSPACE_DEFAULT_PATH`
    /// must see that exact value take effect everywhere the boot script
    /// references it, not just in the exported env var.
    #[test]
    fn boot_script_uses_the_caller_supplied_workspace_default_path_verbatim() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/data/agent-workspaces/main",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        assert!(
            script.contains("export HERMES_WEBUI_DEFAULT_WORKSPACE=/data/agent-workspaces/main"),
            "must use the caller-supplied workspace_default_path, not a hardcoded default"
        );
        assert!(
            script.contains("mkdir -p /data/agent-workspaces/main"),
            "the mkdir target must match the configured path exactly"
        );
        assert!(
            script.lines().any(|line| {
                line.trim() == "chown -R abc:abc /data/agent-workspaces 2>/dev/null || true"
            }),
            "the chown target must be the PARENT of the configured workspace_default_path \
             (/data/agent-workspaces, not /data/agent-workspaces/main) — see \
             workspace_chown_target's own doc comment for why: agent-seeder needs to mkdir \
             per-agent SIBLING directories under this parent at runtime, as abc"
        );
        assert!(
            !script.contains("/workspace/default"),
            "no trace of the old hardcoded default should remain when a different path is \
             configured"
        );
    }

    #[test]
    fn workspace_chown_target_never_resolves_to_filesystem_root() {
        // A pathologically shallow WORKSPACE_DEFAULT_PATH (e.g. "/workspace",
        // one level deep) must never make this fall back to chowning "/" —
        // that would be both wrong (way too broad) and dangerous.
        assert_eq!(workspace_chown_target("/workspace"), "/workspace");
    }

    #[test]
    fn workspace_chown_target_is_the_parent_for_a_normal_nested_path() {
        assert_eq!(workspace_chown_target("/workspace/default"), "/workspace");
        assert_eq!(
            workspace_chown_target("/data/agent-workspaces/main"),
            "/data/agent-workspaces"
        );
    }

    /// `HERMES_FRONTEND_ORIGIN` must come from the caller-supplied
    /// parameter, not a baked-in `http://localhost:5173` constant
    /// (AGENTS.md rule #2: no hardcoded URL) — same class of bug already
    /// fixed for `allowed_origins` and `workspace_default_path` above; a
    /// deployment with a different configured `FRONTEND_ORIGIN` must see
    /// that exact value reach the container, not a stale local-dev
    /// default.
    #[test]
    fn boot_script_uses_the_caller_supplied_frontend_origin_verbatim() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "https://app.example.com",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        assert!(
            script.contains("export HERMES_FRONTEND_ORIGIN=https://app.example.com"),
            "must use the caller-supplied frontend_origin, not a hardcoded \
             http://localhost:5173 — got: {script}"
        );
    }

    #[test]
    fn boot_script_runs_wrapper_under_the_agents_venv_not_a_separate_one() {
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
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
        let script = wrapper_boot_script(
            "http://localhost:5173",
            "/workspace/default",
            "http://localhost:5173",
            "ws-test",
            "http://gateway-internal:8080",
            "4",
        );
        // custom-cont-init.d hooks must exit 0 quickly (they run before
        // s6's long-running services start) — the wrapper is started
        // detached (setsid ... &) rather than this script waiting on it.
        assert!(script.trim_end().ends_with("exit 0"));
        assert!(script.contains("setsid su"));
    }
}
