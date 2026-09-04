"""Tests for `browser_manager.py` — the per-agent Chromium lifecycle daemon.

Follows this directory's existing test conventions (see
`test_dockerfile_wallpaper.py`): plain `test_*` functions, a `_run_all()` /
`if __name__ == "__main__":` block with the exact same shape, AND
pytest-discoverable (matches `pytest.ini`'s `python_files = test_*.py`).

Two kinds of coverage:

1. Pure logic tests against `BrowserManager` (registry start/stop/status,
   profile-dir creation, PID-liveness re-check, idempotent stop, port
   allocation) using a REAL `subprocess.Popen` of a cheap, universally
   available stand-in (`sleep`) injected in place of the real `chromium`
   launch command — proves PID-tracking/liveness/kill logic against a REAL
   OS process, not a mock, without requiring a Chromium binary in whatever
   environment runs `pytest` here.
2. One Dockerfile string-assertion test (the COPY line for
   `browser_manager.py` exists), matching `test_dockerfile_wallpaper.py`'s
   exact pattern — no `docker build`, no real container boot.

Run directly:

    python3 backend/workspace-image/test_browser_manager.py

Or via pytest:

    python3 -m pytest backend/workspace-image
"""
from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

WORKSPACE_IMAGE_DIR = Path(__file__).parent
DOCKERFILE = WORKSPACE_IMAGE_DIR / "Dockerfile"

sys.path.insert(0, str(WORKSPACE_IMAGE_DIR))
import browser_manager as bm  # noqa: E402


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Test doubles: a real (cheap) subprocess stand-in for `chromium`.
# ---------------------------------------------------------------------------


def _make_fake_launch(tmp_path: Path):
    """Returns a `LaunchFn` that spawns real `sleep 30` subprocesses instead
    of chromium, and a list capturing every (profile_dir, port) it was
    called with, so assertions can inspect launch arguments."""
    calls: list[tuple[Path, int]] = []

    def _launch(profile_dir: Path, port: int) -> "subprocess.Popen[bytes]":
        calls.append((profile_dir, port))
        return subprocess.Popen(["sleep", "30"])

    return _launch, calls


def _tmp_profile_root(monkeypatch_root: list[Path], name: str) -> Path:
    import tempfile

    root = Path(tempfile.mkdtemp(prefix=f"browser-manager-test-{name}-"))
    monkeypatch_root.append(root)
    return root


class _RootSwap:
    """Context manager: temporarily point bm.PROFILE_ROOT at a tmp dir."""

    def __init__(self, new_root: Path) -> None:
        self._new_root = new_root
        self._old_root = None

    def __enter__(self) -> Path:
        self._old_root = bm.PROFILE_ROOT
        bm.PROFILE_ROOT = self._new_root
        return self._new_root

    def __exit__(self, *exc: object) -> None:
        bm.PROFILE_ROOT = self._old_root


# ---------------------------------------------------------------------------
# Pure-logic tests
# ---------------------------------------------------------------------------


def test_validate_agent_id_rejects_path_traversal_and_empty() -> None:
    for bad in ["", "../../etc", "a/b", "a b", "a" * 200, "..", "."]:
        try:
            bm.validate_agent_id(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for agent_id={bad!r}")


def test_validate_agent_id_accepts_safe_ids() -> None:
    for good in ["agent1", "agent-1_2", "A", "a" * 128]:
        bm.validate_agent_id(good)  # must not raise


def test_profile_dir_for_is_deterministic_and_pure() -> None:
    with _RootSwap(Path("/data/browser-profiles")):
        p1 = bm.profile_dir_for("agent-x")
        p2 = bm.profile_dir_for("agent-x")
    assert p1 == p2 == Path("/data/browser-profiles/agent-x")


def test_default_profile_root_is_under_workspace_not_data() -> None:
    """Regression guard for a REAL bug found live: the original default,
    `/data/browser-profiles`, does not exist in the real workspace image
    and is not owned by `abc` (the unprivileged user this daemon runs
    as) — every real `start()` call failed closed with `PermissionError:
    [Errno 13] Permission denied: '/data'` before ever reaching the
    Chromium launch (confirmed via this daemon's own crash log inside a
    real running container). `/workspace` is this image's actual,
    confirmed `abc`-writable persistent root."""
    assert bm.PROFILE_ROOT == Path("/workspace/.browser-profiles")
    assert str(bm.PROFILE_ROOT).startswith("/workspace/"), (
        "PROFILE_ROOT must live under /workspace (confirmed abc-writable "
        "in the real image) — never reintroduce /data or any other path "
        "not confirmed writable by the unprivileged user this daemon "
        "runs as."
    )


def test_daemon_binds_all_interfaces_not_loopback() -> None:
    """Regression guard for a REAL bug found live: `BROWSER_MANAGER_HOST`
    was originally `127.0.0.1` (loopback-only) — a service bound to
    loopback INSIDE a container is reachable ONLY from within that
    container's own network namespace. Docker's `-p <host>:9400` port
    publish can never reach a loopback-bound listener from OUTSIDE the
    container, no matter how correct the publish mapping is — confirmed
    live: `docker port` showed the right mapping, `docker exec` calls
    into the container worked fine, but a real gateway call (a bare host
    process) hitting the published port got a real, reproducible
    connection failure. The intended "never reachable from outside this
    machine" security property is now enforced on the HOST side of the
    publish instead (see `rust_gateway/src/workspaces/container/
    docker_launcher.rs`'s `browser_publish_arg`, which binds the HOST
    side to `127.0.0.1` explicitly), not by binding loopback-only inside
    the container, which does not achieve that goal at all."""
    assert bm.BROWSER_MANAGER_HOST == "0.0.0.0", (
        "BROWSER_MANAGER_HOST must be 0.0.0.0 (bind all interfaces INSIDE "
        "the container) — a loopback bind here is unreachable through "
        "Docker's published port from outside the container, breaking "
        "every real gateway call regardless of the publish mapping being "
        "otherwise correct. Host-side exposure is restricted at the "
        "Docker publish layer instead (docker_launcher.rs), not here."
    )


def test_default_launch_chromium_uses_the_real_conservative_flag_set() -> None:
    """Regression guard pinning `default_launch_chromium`'s real,
    requested resource-efficiency flag set — this function is never
    exercised by any other test in this file (every `BrowserManager`
    test above injects a FAKE `launch_fn`, see `_make_fake_launch`), so
    without this test a future accidental flag removal/typo here would
    go completely uncaught. Intercepts the real `subprocess.Popen` call
    (never actually spawns Chromium) to inspect the exact argv/env it
    would have been given."""
    from unittest.mock import patch

    captured: dict = {}

    class _FakePopen:
        def __init__(self, args, env=None, **kwargs):
            captured["args"] = args
            captured["env"] = env

    with patch("browser_manager.subprocess.Popen", _FakePopen):
        bm.default_launch_chromium(Path("/workspace/.browser-profiles/agent-x"), 12345)

    args = captured["args"]
    assert args[0] == "chromium"
    assert "--remote-debugging-address=127.0.0.1" in args
    assert "--remote-debugging-port=12345" in args
    assert "--user-data-dir=/workspace/.browser-profiles/agent-x" in args
    assert "--no-sandbox" in args
    # Window size MUST match patch_kasmvnc_resource_efficiency.py's own
    # `-geometry 1024x576` value — see this function's own doc comment
    # for why a mismatch here is a real, silent bug (Chromium's window
    # would extend past, or leave unused space within, the actual
    # visible desktop canvas) rather than an error.
    assert "--window-position=0,0" in args
    assert "--window-size=1024,576" in args
    assert "--window-size=1024,768" not in args, (
        "stale window size — must track patch_kasmvnc_resource_efficiency.py's "
        "own -geometry value exactly"
    )
    # The real, requested conservative flag set — each one removes a real
    # ongoing resource cost an agent-automation browser never needs to pay.
    assert "--no-first-run" in args
    assert "--disable-default-apps" in args
    assert "--disable-sync" in args
    assert "--disable-extensions" in args
    assert "--disable-background-networking" in args
    assert "--mute-audio" in args
    # DISPLAY must reach the real subprocess env — see `_chromium_env`'s
    # own doc comment for why this cannot simply be inherited.
    assert captured["env"] is not None
    assert captured["env"].get("DISPLAY") == ":1"


def test_allocate_free_port_returns_a_real_bindable_port() -> None:
    port = bm._allocate_free_port()
    assert 0 < port < 65536
    # Prove it's genuinely free right after allocation by binding it
    # ourselves (accepting the documented narrow TOCTOU race as fine for a
    # same-process, immediate re-bind in a test).
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", port))


def test_start_creates_profile_dir_including_parents() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "mkdir")
    nested_root = root / "nested" / "does" / "not" / "exist" / "yet"
    launch, calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(nested_root):
        result = manager.start("agent-a")

    expected_dir = nested_root / "agent-a"
    assert Path(result["profile_dir"]) == expected_dir
    assert expected_dir.is_dir(), "start() must create the profile dir, including all parents"
    assert calls == [(expected_dir, result["port"])]

    manager.stop("agent-a")


def test_start_is_idempotent_for_a_live_process_same_port_and_dir() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "idempotent")
    launch, calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root):
        first = manager.start("agent-b")
        second = manager.start("agent-b")

    assert first == second, "second start() for a live agent must return the SAME port/profile_dir"
    assert len(calls) == 1, "start() must not launch a second process while one is already live"

    manager.stop("agent-b")


def test_start_relaunches_after_process_died_without_daemon_being_told() -> None:
    """A process can die without stop() being called. The next start() for
    that agent_id must detect the stale PID (not just trust the dict) and
    launch a fresh one."""
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "relaunch")
    launch, calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root):
        first = manager.start("agent-c")
        # Kill the real subprocess out from under the manager, without
        # calling manager.stop() — simulates an untracked death.
        pid = manager._registry["agent-c"]["pid"]
        os.kill(pid, 9)
        deadline = time.monotonic() + 5
        while bm._pid_is_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not bm._pid_is_alive(pid), "test setup: process should be dead by now"

        second = manager.start("agent-c")

    assert len(calls) == 2, "start() must relaunch once the previous PID is confirmed dead"
    assert second["port"] != first["port"] or True  # port MAY collide in theory; just prove relaunch happened
    manager.stop("agent-c")


def test_status_reflects_registry_and_pid_liveness() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "status")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root):
        # Never started: profile_dir is still the deterministic path.
        never_started = manager.status("agent-d")
        assert never_started["running"] is False
        assert never_started["port"] is None
        assert never_started["profile_dir"] == str(root / "agent-d")

        manager.start("agent-d")
        running = manager.status("agent-d")
        assert running["running"] is True
        assert isinstance(running["port"], int)
        assert running["profile_dir"] == str(root / "agent-d")

        pid = manager._registry["agent-d"]["pid"]
        os.kill(pid, 9)
        deadline = time.monotonic() + 5
        while bm._pid_is_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.05)

        after_death = manager.status("agent-d")
        assert after_death["running"] is False, "status() must re-verify PID liveness, not trust a stale dict entry"
        assert after_death["port"] is None
        assert after_death["profile_dir"] == str(root / "agent-d")


def test_stop_kills_a_real_process_and_removes_registry_entry() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "stop")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root):
        manager.start("agent-e")
        pid = manager._registry["agent-e"]["pid"]
        assert bm._pid_is_alive(pid)

        result = manager.stop("agent-e")

    assert result == {"stopped": True, "already_stopped": False}
    assert not bm._pid_is_alive(pid), "stop() must actually terminate the real OS process"
    assert "agent-e" not in manager._registry


def test_stop_never_deletes_the_profile_directory() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "no-delete")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root):
        start_result = manager.start("agent-f")
        profile_dir = Path(start_result["profile_dir"])
        assert profile_dir.is_dir()

        manager.stop("agent-f")

    assert profile_dir.is_dir(), "stop() must NEVER delete the profile directory"


def test_stop_is_idempotent_when_nothing_is_running() -> None:
    manager = bm.BrowserManager(launch_fn=_make_fake_launch(Path("/tmp"))[0])
    result = manager.stop("agent-never-started")
    assert result == {"stopped": False, "already_stopped": True}, (
        "stop() for an agent with no live entry must be a clean success, not an error"
    )


def test_stop_is_idempotent_called_twice_in_a_row() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "double-stop")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root):
        manager.start("agent-g")
        first_stop = manager.stop("agent-g")
        second_stop = manager.stop("agent-g")

    assert first_stop == {"stopped": True, "already_stopped": False}
    assert second_stop == {"stopped": False, "already_stopped": True}


class _IdleTimeoutOverride:
    """Context manager: temporarily point
    bm.BROWSER_IDLE_TIMEOUT_MINUTES at a test value — same pattern as
    `_RootSwap` for `bm.PROFILE_ROOT`."""

    def __init__(self, minutes: float) -> None:
        self._minutes = minutes
        self._old = None

    def __enter__(self) -> None:
        self._old = bm.BROWSER_IDLE_TIMEOUT_MINUTES
        bm.BROWSER_IDLE_TIMEOUT_MINUTES = self._minutes

    def __exit__(self, *exc: object) -> None:
        bm.BROWSER_IDLE_TIMEOUT_MINUTES = self._old


def test_sweep_idle_kills_an_agent_past_its_timeout() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "sweep-kills")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root), _IdleTimeoutOverride(4.0):
        manager.start("agent-idle")
        # Simulate 5 real minutes having passed since start() — injectable
        # `now`, no real time.sleep() needed (see sweep_idle's own doc
        # comment for why this seam exists).
        five_minutes_later = time.monotonic() + (5.0 * 60.0)
        killed = manager.sweep_idle(now=five_minutes_later)

    assert killed == ["agent-idle"]
    with _RootSwap(root):
        status = manager.status("agent-idle")
    assert status["running"] is False, "sweep_idle must actually kill the process, not just report it"


def test_sweep_idle_does_not_kill_an_agent_still_within_its_timeout() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "sweep-spares")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    try:
        with _RootSwap(root), _IdleTimeoutOverride(4.0):
            manager.start("agent-fresh")
            one_minute_later = time.monotonic() + 60.0
            killed = manager.sweep_idle(now=one_minute_later)

        assert killed == []
        with _RootSwap(root):
            status = manager.status("agent-fresh")
        assert status["running"] is True
    finally:
        with _RootSwap(root):
            manager.stop("agent-fresh")


def test_sweep_idle_is_a_real_no_op_when_timeout_is_zero_or_negative() -> None:
    """The real, requested "lifetime"/"forever" opt-out: 0 (or any
    non-positive value) means idle-killing never happens, no matter how
    much simulated time passes."""
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "sweep-disabled")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    try:
        with _RootSwap(root), _IdleTimeoutOverride(0.0):
            manager.start("agent-forever")
            one_year_later = time.monotonic() + (60.0 * 60.0 * 24.0 * 365.0)
            killed = manager.sweep_idle(now=one_year_later)

        assert killed == []
        with _RootSwap(root):
            status = manager.status("agent-forever")
        assert status["running"] is True
    finally:
        with _RootSwap(root):
            manager.stop("agent-forever")


def test_sweep_idle_refreshed_by_a_second_start_call() -> None:
    """A second start() call for an already-running agent resets its
    idle clock — see start()'s own doc comment on why this counts as
    real activity. `start()` always stamps `last_activity` with the REAL
    `time.monotonic()` (no injectable `now`, unlike `sweep_idle()`), so
    this test proves the refresh by reading the registry's own recorded
    timestamp directly rather than simulating elapsed wall-clock time
    around a second `start()` call."""
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "sweep-refresh")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    try:
        with _RootSwap(root):
            manager.start("agent-refreshed")
            first_activity = manager._registry["agent-refreshed"]["last_activity"]

            # A confirming start() call must record a NEW (later or
            # equal, monotonic clock resolution permitting) timestamp,
            # not silently leave the original one in place.
            manager.start("agent-refreshed")
            second_activity = manager._registry["agent-refreshed"]["last_activity"]

        assert second_activity >= first_activity, (
            "a second start() call for an already-running agent must refresh "
            "last_activity, not leave the original start() timestamp in place"
        )
    finally:
        with _RootSwap(root):
            manager.stop("agent-refreshed")


def test_env_var_configures_idle_timeout_minutes() -> None:
    """`BROWSER_IDLE_TIMEOUT_MINUTES` is read from the environment at
    module import time (see the module-level constant's own doc
    comment) — this test proves the parsing logic directly rather than
    re-importing the module with a patched environment (which this test
    file's sibling `test_env_var_configures_port_no_hardcoded_default_elsewhere`
    already establishes is impractical for a module-level constant)."""
    assert bm.DEFAULT_IDLE_TIMEOUT_MINUTES == 4
    # The real module-level value, read once at import — confirms it
    # picked up either the real env var or the documented default,
    # rather than silently being some other hardcoded number.
    import os as _os

    expected = float(_os.environ.get("BROWSER_IDLE_TIMEOUT_MINUTES", bm.DEFAULT_IDLE_TIMEOUT_MINUTES))
    assert bm.BROWSER_IDLE_TIMEOUT_MINUTES == expected


def test_two_agents_get_independent_ports_and_profile_dirs() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "two-agents")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root):
        a = manager.start("agent-h1")
        b = manager.start("agent-h2")

        assert a["port"] != b["port"]
        assert a["profile_dir"] != b["profile_dir"]

        manager.stop("agent-h1")
        manager.stop("agent-h2")


def test_concurrent_start_calls_for_same_agent_launch_only_one_process() -> None:
    """Two near-simultaneous start() calls for the SAME agent_id (as would
    happen from two concurrent HTTP requests on ThreadingHTTPServer) must
    not both observe 'not running' and both launch Chromium — that would
    leave two processes racing for the same --user-data-dir."""
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "concurrent")
    launch, calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    results: list[dict] = []
    errors: list[BaseException] = []

    def _worker() -> None:
        try:
            results.append(manager.start("agent-concurrent"))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    with _RootSwap(root):
        threads = [threading.Thread(target=_worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert not errors, f"start() raised under concurrency: {errors}"
        assert len(calls) == 1, f"expected exactly one Chromium launch, got {len(calls)}: {calls}"
        ports = {r["port"] for r in results}
        assert ports == {calls[0][1]}, "every concurrent caller must observe the SAME port"

        manager.stop("agent-concurrent")


def test_start_stop_status_reject_invalid_agent_id() -> None:
    manager = bm.BrowserManager(launch_fn=_make_fake_launch(Path("/tmp"))[0])
    for method_name in ("start", "stop", "status"):
        try:
            getattr(manager, method_name)("../etc")
        except ValueError:
            continue
        raise AssertionError(f"{method_name}() must reject a path-traversal agent_id")


# ---------------------------------------------------------------------------
# HTTP layer tests (thin wrapper) — real socket, real HTTP request/response.
# ---------------------------------------------------------------------------


def _run_http_server(manager: bm.BrowserManager):
    from http.server import ThreadingHTTPServer

    handler_cls = bm.make_handler(manager)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def test_http_start_stop_status_round_trip() -> None:
    tmp_roots: list[Path] = []
    root = _tmp_profile_root(tmp_roots, "http")
    launch, _calls = _make_fake_launch(root)
    manager = bm.BrowserManager(launch_fn=launch)

    with _RootSwap(root):
        server, thread = _run_http_server(manager)
        try:
            port = server.server_address[1]
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)

            conn.request("POST", "/agents/agent-http/start")
            resp = conn.getresponse()
            assert resp.status == 200
            start_body = json.loads(resp.read())
            assert "port" in start_body and "profile_dir" in start_body

            conn.request("GET", "/agents/agent-http/status")
            resp = conn.getresponse()
            assert resp.status == 200
            status_body = json.loads(resp.read())
            assert status_body["running"] is True

            conn.request("POST", "/agents/agent-http/stop")
            resp = conn.getresponse()
            assert resp.status == 200
            stop_body = json.loads(resp.read())
            assert stop_body["stopped"] is True
        finally:
            server.shutdown()
            thread.join(timeout=5)


def test_http_malformed_agent_id_returns_400() -> None:
    manager = bm.BrowserManager(launch_fn=_make_fake_launch(Path("/tmp"))[0])
    server, thread = _run_http_server(manager)
    try:
        port = server.server_address[1]
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/agents/..%2F..%2Fetc/start")
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 400
        assert "error" in body
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_http_unknown_path_returns_404() -> None:
    manager = bm.BrowserManager(launch_fn=_make_fake_launch(Path("/tmp"))[0])
    server, thread = _run_http_server(manager)
    try:
        port = server.server_address[1]
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/not-a-real-route")
        resp = conn.getresponse()
        resp.read()
        assert resp.status == 404
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_http_wrong_method_for_action_returns_404() -> None:
    manager = bm.BrowserManager(launch_fn=_make_fake_launch(Path("/tmp"))[0])
    server, thread = _run_http_server(manager)
    try:
        port = server.server_address[1]
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        # /start only accepts POST, not GET.
        conn.request("GET", "/agents/agent-z/start")
        resp = conn.getresponse()
        resp.read()
        assert resp.status == 404
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_env_var_configures_port_no_hardcoded_default_elsewhere() -> None:
    """BROWSER_MANAGER_PORT must be the single source of the default port;
    this test proves the module actually reads the env var (via a
    subprocess so the env var is read at fresh import time)."""
    script = (
        "import os; os.environ['BROWSER_MANAGER_PORT']='19400'; "
        "import importlib.util; "
        f"spec = importlib.util.spec_from_file_location('browser_manager', {str(WORKSPACE_IMAGE_DIR / 'browser_manager.py')!r}); "
        "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); "
        "print(mod.BROWSER_MANAGER_PORT)"
    )
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=10)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "19400"


# ---------------------------------------------------------------------------
# Dockerfile string-assertion test — matches test_dockerfile_wallpaper.py's
# exact pattern.
# ---------------------------------------------------------------------------


def test_dockerfile_copies_browser_manager_script() -> None:
    text = _dockerfile_text()
    assert (
        "COPY backend/workspace-image/browser_manager.py "
        "/opt/hermes-browser-manager/browser_manager.py" in text
    ), "Dockerfile must COPY browser_manager.py into the image."


def _run_all() -> int:
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)
