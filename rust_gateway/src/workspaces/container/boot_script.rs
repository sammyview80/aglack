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
     setsid su -s /bin/sh abc -c '\n\
     export HOME=/config\n\
     export HERMES_HOME=/config/.hermes\n\
     export HERMES_WEBUI_AGENT_DIR=/opt/hermes\n\
     export HERMES_WRAPPER_HOST=0.0.0.0\n\
     export HERMES_WRAPPER_PORT=8787\n\
     export HERMES_FRONTEND_ORIGIN={frontend_origin}\n\
     export HERMES_WEBUI_ALLOWED_ORIGINS={allowed_origins}\n\
     export HERMES_WEBUI_DEFAULT_WORKSPACE={workspace_default_path}\n\
     git config --global --add safe.directory /opt/hermes-webui/upstream \
       || echo \"hermes-webui-wrapper-boot: safe.directory config failed\" >&2\n\
     cd /opt/hermes-webui/wrapper\n\
     exec /opt/hermes/.venv/bin/hermes-webui-wrapper\n\
     ' >/config/hermes-webui-wrapper.log 2>&1 &\n\
     exit 0\n"
    )
}

/// Writes `wrapper_boot_script(allowed_origins, workspace_default_path,
/// frontend_origin)` to a real temp file and `docker cp`'s it into the
/// (created-but-not-yet-started) container's `/custom-cont-init.d/` —
/// see `DockerCliLauncher`'s own doc comment for why this must happen
/// between `create` and `start`, not after.
pub(crate) async fn deliver_boot_script(
    container_name: &str,
    allowed_origins: &str,
    workspace_default_path: &str,
    frontend_origin: &str,
) -> Result<(), super::super::CreateWorkspaceError> {
    let script = wrapper_boot_script(allowed_origins, workspace_default_path, frontend_origin);
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
        super::super::CreateWorkspaceError::Container(format!(
            "failed to write boot script: {err}"
        ))
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
    #[test]
    fn boot_script_sets_safe_directory_before_starting_wrapper() {
        let script = wrapper_boot_script("http://localhost:5173", "/workspace/default", "http://localhost:5173");
        assert!(
            script.contains("git config --global --add safe.directory /opt/hermes-webui/upstream"),
            "missing the safe.directory fix — without it abc's git rev-parse fails with \
             'dubious ownership' and the wrapper crash-loops silently (verified live)"
        );
    }

    #[test]
    fn boot_script_runs_wrapper_as_abc_not_root() {
        let script = wrapper_boot_script("http://localhost:5173", "/workspace/default", "http://localhost:5173");
        assert!(script.contains("su -s /bin/sh abc -c"));
    }

    #[test]
    fn boot_script_sets_required_wrapper_env_vars() {
        let script = wrapper_boot_script("http://localhost:5173", "/workspace/default", "http://localhost:5173");
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
            script.lines().any(|line| line.trim() == "chown -R abc:abc /workspace 2>/dev/null || true"),
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
        );
        assert!(
            script.contains("export HERMES_FRONTEND_ORIGIN=https://app.example.com"),
            "must use the caller-supplied frontend_origin, not a hardcoded \
             http://localhost:5173 — got: {script}"
        );
    }

    #[test]
    fn boot_script_runs_wrapper_under_the_agents_venv_not_a_separate_one() {
        let script = wrapper_boot_script("http://localhost:5173", "/workspace/default", "http://localhost:5173");
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
        let script = wrapper_boot_script("http://localhost:5173", "/workspace/default", "http://localhost:5173");
        // custom-cont-init.d hooks must exit 0 quickly (they run before
        // s6's long-running services start) — the wrapper is started
        // detached (setsid ... &) rather than this script waiting on it.
        assert!(script.trim_end().ends_with("exit 0"));
        assert!(script.contains("setsid su"));
    }
}
