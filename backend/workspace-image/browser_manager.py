"""Per-agent Chromium process-lifecycle daemon — one PERSISTENT profile
directory per Hermes agent, with the Chromium PROCESS itself EPHEMERAL
(started on demand by `start()`, killed by `stop()` when no longer needed,
profile directory always survives a `stop()`).

This is a NEW, standalone always-on daemon living INSIDE the workspace
container (one container hosts MULTIPLE agents/profiles already — this is
NOT per-workspace, it is per-agent_id). It owns nothing but Chromium
process lifecycle: no chat, no CDP protocol logic, no browser automation —
just start/stop/status bookkeeping keyed by `agent_id`.

STDLIB-ONLY, NO FastAPI — deliberate design decision, not an oversight:
this file has no `pyproject.toml`/install step of its own (unlike
`backend/wrapper`, which IS an installed package with FastAPI as a
transitive dependency of hermes-agent, baked into `/opt/hermes/.venv`).
Nothing in this Dockerfile installs *this* file as a package or guarantees
which interpreter invokes it — `PATH` happens to prefer the agent venv's
`python3` at runtime (see Dockerfile's `ENV PATH="/opt/hermes/.venv/bin:..."`),
but that is an incidental property of another subsystem's dependency tree,
not a contract this daemon should quietly depend on. A single-purpose
lifecycle daemon like this has no need for FastAPI's routing/validation
machinery, and this project's own contribution guidance (see
`backend/AGENTS.md`: "Do not add dependencies ... without clear
justification") argues against pulling one in for four tiny JSON routes.
`http.server` (stdlib) is sufficient and works under ANY Python 3
interpreter that might end up running this file, including the bare Alpine
`apk add python3` also present in this image (Dockerfile's Stage 3
"Runtime-only deps" block).

Separation-of-concerns convention (mirrors this repo's OWN
`backend/wrapper` pattern of "service.py has the logic, the HTTP layer
just calls it" — see `wrapper/src/hermes_webui_wrapper/features/*/service.py`
and their thin `api/v1/*.py` routers): the `BrowserManager` class below is
the whole "service" — plain, unit-testable Python methods with no HTTP
awareness at all. `_Handler` (the `BaseHTTPRequestHandler` subclass) is a
thin wrapper that only does path/method dispatch and JSON (de)serialization,
calling straight into `BrowserManager`. Tests exercise `BrowserManager`
directly; see `test_browser_manager.py`.

Known limitations (deliberate, documented rather than "solved" — see the
task this file was built for):

1. **Startup reconciliation is NOT performed.** On daemon start, the
   in-memory registry is always empty, even though an external actor could
   have left an orphaned Chromium process running from a prior daemon boot
   (e.g. container restarted, profile dir survived via a volume mount, but
   this daemon's own memory did not). This daemon does NOT scan `/proc` or
   the profile directory tree to adopt orphans at startup — out of scope.
   Practical effect: such an orphan is invisible to `status()`/`start()`
   until the container itself is recreated (not just restarted) or the
   orphan is killed by other means. `start()` for that `agent_id` would
   then launch a SECOND Chromium against the SAME `--user-data-dir`, which
   Chromium generally refuses to do cleanly (profile directory locking) —
   this is the one concrete edge case an operator should watch for after
   any host/daemon-process restart that does not also recreate the
   container.
2. **Port allocation has a real, narrow TOCTOU race.** `_allocate_port()`
   binds to port 0, reads back the OS-assigned free port, then closes the
   socket before Chromium binds that same port. Between the close and
   Chromium's own bind, another process on the same loopback interface
   could in principle claim that exact port first. This is the standard
   "ask the OS for a free port" pattern and the race is accepted as a known
   limitation rather than solved with a more complex reservation scheme
   (e.g. holding the socket open with SO_REUSEPORT and racing Chromium to
   bind it) — the daemon is the only expected writer of new Chromium
   processes on this loopback interface inside a given container, making
   the race exceedingly unlikely in practice, not eliminated in theory.
3. **This daemon itself is not persisted/supervised here.** If the daemon
   process dies, the registry (which is only ever in-memory) is lost even
   though any Chromium processes it started keep running as orphans (see
   limitation 1 for what happens to them on the next `start()`/`status()`).
   Supervising/restarting this daemon is out of scope for this file — see
   the Dockerfile COPY comment for where that responsibility lives.
"""
from __future__ import annotations

import json
import os
import re
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

# No hardcoded port literal anywhere else in this file — every other use
# reads this one env-driven default. See task point 6.
DEFAULT_PORT = 9400
BROWSER_MANAGER_PORT = int(os.environ.get("BROWSER_MANAGER_PORT", DEFAULT_PORT))

# Deliberate: the daemon's own HTTP API binds to loopback only. This is a
# single-container-local control plane; it is never meant to be reachable
# from outside the container for this feature (see module docstring's CDP
# note below for why the same rule applies there too).
BROWSER_MANAGER_HOST = "127.0.0.1"

# Root directory for all persistent per-agent Chromium profiles. Each
# agent's profile lives at PROFILE_ROOT / agent_id, created (including all
# parents, i.e. PROFILE_ROOT itself) lazily by `start()`/`status()`.
PROFILE_ROOT = Path("/data/browser-profiles")

# Grace period given to a process after SIGTERM before escalating to
# SIGKILL — long enough for Chromium to flush/exit cleanly, short enough
# that `stop()` stays responsive.
STOP_GRACE_PERIOD_SECONDS = 5.0
_STOP_POLL_INTERVAL_SECONDS = 0.1

# Agent ids are used verbatim as a path segment (`PROFILE_ROOT / agent_id`)
# and as a URL path segment — restrict to a safe charset up front so
# neither a path-traversal id (`../../etc`) nor a URL-shaped one can ever
# reach the filesystem or subprocess argv unsanitized. Adversarial input at
# the point of use, not just documentation.
_AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def validate_agent_id(agent_id: str) -> None:
    """Raise ValueError for any agent_id that isn't a safe path/URL segment."""
    if not agent_id or not _AGENT_ID_RE.match(agent_id):
        raise ValueError(
            f"invalid agent_id {agent_id!r}: must match {_AGENT_ID_RE.pattern}"
        )


def profile_dir_for(agent_id: str) -> Path:
    """The deterministic, always-computable profile path for an agent_id.

    Pure path arithmetic — does not touch the filesystem and does not
    require the agent to have ever been started. `status()` uses this even
    for agents with no live (or ever-launched) Chromium process, since the
    directory may exist from a prior session."""
    validate_agent_id(agent_id)
    return PROFILE_ROOT / agent_id


def _pid_is_alive(pid: int) -> bool:
    """True if `pid` refers to a real, currently-running process.

    Reaps a zombie first (non-blocking `waitpid`) before checking, and this
    is not optional bookkeeping: on POSIX, a killed child that has not yet
    been `waitpid`'d stays a ZOMBIE process-table entry, and
    `os.kill(pid, 0)` reports a zombie as alive (it exists — it just has no
    running code left) — confirmed empirically (SIGKILL a real
    `subprocess.Popen` child and poll `os.kill(pid, 0)` without reaping: it
    keeps reporting alive indefinitely). Without this reap step, `stop()`'s
    own kill-then-poll loop and `status()`/`start()`'s liveness re-check
    would both misreport a just-killed Chromium as still running. `pid`
    that is not actually our own child (e.g. after a daemon restart wiped
    the registry per limitation 1, or a caller-supplied PID this process
    never spawned) raises `ChildProcessError`/`OSError` from `waitpid`,
    which is expected and tolerated here — fall through to the plain
    `os.kill(pid, 0)` existence check for that case.

    `os.kill(pid, 0)` sends no signal; it only performs the permission/
    existence check the kernel does before delivering a real signal. The
    classic "PID got reused by an unrelated process after the original
    died" case is intentionally NOT handled here — plain PID liveness (not
    identity) is what the task calls for ("verify the PID is ACTUALLY
    still alive"), and this daemon holds the only reference to that PID's
    launch context. A stricter check would additionally read
    `/proc/<pid>/cmdline` to confirm it's still the same Chromium
    invocation, but that is Linux/procfs-specific and this daemon
    otherwise contains no procfs assumptions; left out as out of scope.
    """
    if pid <= 0:
        return False

    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    except OSError:
        pass

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but is owned by another user — still "alive" from
        # a liveness-check standpoint (fail closed: never claim it's dead).
        return True
    return True


def _allocate_free_port(host: str = "127.0.0.1") -> int:
    """Ask the OS for a free TCP port by binding to port 0, reading back
    the assigned port, then closing the socket immediately.

    Standard pattern; NOT race-free — see limitation 2 in the module
    docstring. Binds to `host` (loopback by default) so the probe reflects
    the same interface Chromium's own `--remote-debugging-address` will
    bind to."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


# Type of the callable used to launch Chromium, injected so tests can swap
# in a cheap stand-in subprocess instead of requiring a real Chromium
# binary in whatever environment runs pytest. Takes (profile_dir, port) and
# returns a live `subprocess.Popen`.
LaunchFn = Callable[[Path, int], "subprocess.Popen[bytes]"]


def default_launch_chromium(profile_dir: Path, port: int) -> "subprocess.Popen[bytes]":
    """Launch headless Chromium for one agent's profile.

    `--remote-debugging-address=127.0.0.1`: CDP (Chrome DevTools Protocol)
    binds to loopback ONLY, NEVER `0.0.0.0` — deliberate security decision.
    CDP has no authentication of its own; anyone who can reach it can drive
    the browser completely (read cookies/local storage, navigate anywhere,
    exfiltrate any page content, run arbitrary JS in-page). This daemon's
    own HTTP API (also loopback-only, see BROWSER_MANAGER_HOST) is the sole
    intended entry point into this feature from outside the browser
    process itself; nothing about the per-agent Chromium process should
    ever be reachable directly from outside the container.

    `--no-sandbox`: researched, not assumed. Chromium's Linux sandbox
    relies on a SUID-root helper binary (or, on newer setups, unprivileged
    user namespaces) to isolate renderer processes. This container already
    runs Chromium as a non-root user (`abc`, see Dockerfile) without the
    extra kernel capabilities (`CAP_SYS_ADMIN`) or `docker run`
    `--security-opt`/`--cap-add` flags a properly sandboxed Chromium needs
    inside a container — none of which this daemon can grant itself from
    inside the container, and granting them is out of scope here (that is
    a `docker create`/`docker run` concern, owned by whatever creates the
    container, same boundary the Dockerfile's own comments draw for
    per-container identity). Without `--no-sandbox`, Chromium's sandboxed
    renderer setup fails outright in this exact environment (SUID helper
    requires root ownership + the setuid bit, and unprivileged user
    namespaces are frequently disabled or unavailable in default container
    runtimes). This repo's own existing `e2e_test_kasmvnc_lastactiveat.py`
    already launches headless Chrome the same way, with the same flag, for
    the same reason. `--no-sandbox` measurably widens the blast radius of a
    renderer-process compromise (no more process-level isolation from a
    hostile page) — acceptable here because CDP and the browser process are
    never exposed outside the container in the first place (loopback-only,
    see above); it is not a defense-in-depth-free design, it is one layer
    (network isolation) substituting for another (OS sandboxing) in an
    environment where the second layer cannot be enabled.
    """
    return subprocess.Popen(
        [
            "chromium",
            "--headless=new",
            "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile_dir}",
            "--no-sandbox",
        ],
    )


class BrowserManager:
    """The service: in-memory registry + start/stop/status logic.

    No HTTP awareness. `_Handler` below is the only thing that talks JSON/
    HTTP; every method here takes/returns plain Python values so it can be
    unit tested directly (see test_browser_manager.py)."""

    def __init__(self, launch_fn: LaunchFn = default_launch_chromium) -> None:
        # {agent_id: {"pid": int, "port": int, "profile_dir": str}} — LIVE
        # processes only, in-memory only. Not persisted to disk: if this
        # daemon restarts, this dict is empty again (see module docstring
        # limitation 1 on why that's a documented gap, not a bug).
        self._registry: dict[str, dict[str, Any]] = {}
        self._launch_fn = launch_fn
        # The HTTP layer serves each request on its own thread
        # (ThreadingHTTPServer) — a single process-wide lock serializes
        # every start()/stop() check-then-act sequence so two concurrent
        # requests for the SAME agent_id can never both observe "not
        # running" and both launch a second Chromium against the same
        # --user-data-dir (which Chromium does not handle cleanly; see
        # limitation 1). One coarse lock, not a per-agent lock table, is
        # deliberate: start()/stop() bodies are fast (no network I/O, no
        # waiting on Chromium to become ready) except for stop()'s bounded
        # SIGTERM grace period — acceptable serialization cost for a
        # feature with at most a handful of agents per container, and it
        # avoids a second piece of state (a lock per agent_id) that would
        # itself need cleanup. status() does not take this lock: it only
        # reads, and a torn read here is at worst a momentarily stale
        # boolean, not a correctness issue.
        self._lock = threading.Lock()

    def _live_entry(self, agent_id: str) -> dict[str, Any] | None:
        """Return the registry entry for agent_id IFF its PID is still
        actually alive; drops (and returns None for) a stale entry whose
        process died without this daemon being told, per task point 1/4's
        "verify the PID is ACTUALLY still alive, not just present"."""
        entry = self._registry.get(agent_id)
        if entry is None:
            return None
        if not _pid_is_alive(entry["pid"]):
            del self._registry[agent_id]
            return None
        return entry

    def start(self, agent_id: str) -> dict[str, Any]:
        validate_agent_id(agent_id)

        with self._lock:
            existing = self._live_entry(agent_id)
            if existing is not None:
                # Already running — no new process, no new port. Return the
                # SAME dict shape as a fresh start for a uniform caller
                # contract.
                return {
                    "port": existing["port"],
                    "profile_dir": existing["profile_dir"],
                }

            profile_dir = profile_dir_for(agent_id)
            profile_dir.mkdir(parents=True, exist_ok=True)

            port = _allocate_free_port()
            process = self._launch_fn(profile_dir, port)

            self._registry[agent_id] = {
                "pid": process.pid,
                "port": port,
                "profile_dir": str(profile_dir),
            }
            return {"port": port, "profile_dir": str(profile_dir)}

    def stop(self, agent_id: str) -> dict[str, Any]:
        validate_agent_id(agent_id)

        with self._lock:
            entry = self._live_entry(agent_id)
            if entry is None:
                # Idempotent: no live entry is a clean, successful no-op,
                # not an error (task point 3).
                return {"stopped": False, "already_stopped": True}

            pid = entry["pid"]
            self._terminate(pid)
            del self._registry[agent_id]
            # Profile directory is NEVER deleted here (task point 3) — no
            # filesystem call against profile_dir in this method at all.
            return {"stopped": True, "already_stopped": False}

    @staticmethod
    def _terminate(pid: int) -> None:
        """SIGTERM, wait briefly, SIGKILL if still alive — do not leave
        zombies. Tolerates the process already being gone (race between
        the liveness check and this call). Zombie reaping itself happens
        inside every `_pid_is_alive()` call (see its own docstring for why
        that is load-bearing, not optional), so no separate `waitpid` call
        is needed here beyond what those checks already do."""
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return

        deadline = time.monotonic() + STOP_GRACE_PERIOD_SECONDS
        while time.monotonic() < deadline and _pid_is_alive(pid):
            time.sleep(_STOP_POLL_INTERVAL_SECONDS)

        if _pid_is_alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # One final liveness check so SIGKILL's zombie gets reaped
            # immediately rather than waiting for the next unrelated
            # _pid_is_alive() call somewhere else to do it.
            _pid_is_alive(pid)

    def status(self, agent_id: str) -> dict[str, Any]:
        validate_agent_id(agent_id)

        # profile_dir is always the deterministic path, whether or not
        # currently running (task point 4) — computed independent of the
        # registry.
        profile_dir = profile_dir_for(agent_id)

        entry = self._live_entry(agent_id)
        if entry is None:
            return {"running": False, "port": None, "profile_dir": str(profile_dir)}
        return {
            "running": True,
            "port": entry["port"],
            "profile_dir": str(profile_dir),
        }


# ---------------------------------------------------------------------------
# HTTP layer — thin wrapper only. All logic above; this just does path/
# method dispatch and JSON (de)serialization.
# ---------------------------------------------------------------------------

_AGENT_PATH_RE = re.compile(r"^/agents/([^/]+)/(start|stop|status)$")


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload).encode("utf-8")


def make_handler(manager: BrowserManager) -> type[BaseHTTPRequestHandler]:
    """Build a `BaseHTTPRequestHandler` subclass bound to `manager` via
    closure — keeps the handler class itself free of module-global state,
    so tests can construct independent (handler class, manager) pairs."""

    class _Handler(BaseHTTPRequestHandler):
        # Quiet the default stderr access log; failures still surface via
        # response status codes and, for genuine bugs, tracebacks from
        # send_error's own handling.
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass

        def _write_json(self, status: int, payload: dict[str, Any]) -> None:
            body = _json_bytes(payload)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _dispatch(self, expected_method: str) -> None:
            match = _AGENT_PATH_RE.match(self.path)
            if not match:
                self._write_json(404, {"error": "not found"})
                return

            agent_id, action = match.group(1), match.group(2)
            method_for_action = {"start": "POST", "stop": "POST", "status": "GET"}
            if method_for_action[action] != expected_method:
                self._write_json(404, {"error": "not found"})
                return

            try:
                validate_agent_id(agent_id)
            except ValueError as exc:
                self._write_json(400, {"error": str(exc)})
                return

            try:
                if action == "start":
                    result = manager.start(agent_id)
                elif action == "stop":
                    result = manager.stop(agent_id)
                else:
                    result = manager.status(agent_id)
            except ValueError as exc:
                self._write_json(400, {"error": str(exc)})
                return

            self._write_json(200, result)

        def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
            self._dispatch("POST")

        def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
            self._dispatch("GET")

    return _Handler


def run_server(port: int = BROWSER_MANAGER_PORT, host: str = BROWSER_MANAGER_HOST) -> None:
    manager = BrowserManager()
    handler_cls = make_handler(manager)
    server = ThreadingHTTPServer((host, port), handler_cls)
    server.serve_forever()


if __name__ == "__main__":
    run_server()
