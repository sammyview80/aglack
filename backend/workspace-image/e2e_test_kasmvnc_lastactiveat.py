#!/usr/bin/env python3
"""End-to-end regression test for the KasmVNC `lastActiveAt` crash fix
(see `patch_kasmvnc_lastactiveat.py`'s own module doc for the full
research trail on the bug itself). Run this before committing ANY change
to `patch_kasmvnc_lastactiveat.py`, this Dockerfile, or the base image
pin — it is the only test in this repo that actually proves the fix
works against a real browser, not just that a string replacement
succeeded.

## What this proves, and why nothing smaller does

`patch_kasmvnc_lastactiveat.py` has its own fail-closed check (exits
non-zero if the exact known-bad string isn't found), which proves the
STRING REPLACEMENT happened. It does NOT prove the resulting JavaScript
is still syntactically valid, still behaves correctly when actually
executed, or that the real crash is actually gone. This script closes
that gap with a real, if slow (a few minutes), end-to-end run:

1. Builds the real workspace image from this Dockerfile.
2. Launches a REAL container from it (no gateway needed — this test
   talks to the container directly, isolating "does the fix work" from
   "does rust_gateway's proxying work", which `cargo test` already
   covers separately).
3. Drives a REAL headless Chrome (via the Chrome DevTools Protocol) to
   the container's own desktop URL, waits for the VNC connection to
   establish, then kills the REAL server-side VNC process (`Xvnc`,
   `pkill -9` inside the container) — this is the ACTUAL, confirmed
   trigger this bug needs, not a graceful click.
4. Watches for `Runtime.exceptionThrown` CDP events across several full
   interval ticks (25s > 5 * 5s) after the kill.
5. Asserts zero exceptions. A failure here means the patch's exact
   string match no longer matches real runtime behavior (e.g. the guard
   was written correctly as text but broke something else that now
   throws), or the base image changed in some other way that
   reintroduces this crash class.

### Why an `Xvnc` process kill, not a Disconnect button click

An earlier version of this script clicked the page's own Disconnect
button and asserted no crash followed — that PASSED even against a
genuinely unpatched image (verified: rebuilt the pre-fix Dockerfile,
ran this script against it, got a false PASS). Read `app/ui.js`'s own
source to find out why: `UI.disconnect()` (the click handler) calls
`clearInterval(UI._sessionTimeoutInterval)` SYNCHRONOUSLY, before
`UI.rfb` is ever cleared — a clean, user-initiated disconnect can never
reach the buggy interval tick at all.

`UI.rfb = undefined` only happens, unconditionally, inside
`disconnectFinished()` — and THAT function's own comment says exactly
when it runs: "when the disconnection isn't clean or if it is initiated
by the server". `disconnectFinished()` never calls `clearInterval`
either. So the real, reliable trigger is an UNCLEAN disconnect — the
server closing the connection unexpectedly, e.g. from a crash, restart,
or network failure. Killing the real `Xvnc` process the container runs
(`pkill -9`) is the closest real-world equivalent available without
actually breaking the network — and it deterministically reproduced the
crash 5 times in a row against the unpatched image during this fix's own
verification, and zero times against the patched one.

Cleans up the container, and the image if `--no-keep-image` (the
default), on every exit path — success, failure, or a raised exception —
via `atexit`/`finally`, not just the happy path.

## Requirements

- Docker, reachable on the host running this script (same requirement
  `DockerCliLauncher` in `rust_gateway` already has).
- A real Chrome/Chromium binary — pass its path with `--chrome-binary`,
  or this script tries the common macOS/Linux install locations.
- Python's `websockets` package (`pip install websockets`) — the only
  non-stdlib dependency, needed to speak the CDP WebSocket protocol.
  Everything else is stdlib (`urllib`, `json`, `subprocess`, `asyncio`).

## Usage

    python3 e2e_test_kasmvnc_lastactiveat.py [--image-tag TAG] [--skip-build]

`--skip-build` reuses an already-built image tag instead of rebuilding —
useful for iterating on this test script itself without rebuilding the
whole image every run.
"""

# Lets `X | None` union annotations (PEP 604) parse on Python 3.9+ instead
# of requiring 3.10 — annotations become strings, never evaluated at
# runtime, so this is a purely cosmetic/tooling concession, not a
# behavior change. Keeps this script runnable with whatever python3 a
# contributor already has instead of pinning a specific minor version
# for one syntax feature.
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import websockets
except ImportError:
    print(
        "This test needs the 'websockets' package: pip install websockets",
        file=sys.stderr,
    )
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parents[2]  # revamp/
DOCKERFILE = "backend/workspace-image/Dockerfile"
DEFAULT_IMAGE_TAG = "hermes-workspace:e2e-lastactiveat-test"
CONTAINER_NAME = "hermes-e2e-lastactiveat-test"

# Real unclean disconnect must be given time for the keep-alive interval
# (which fires every 5s in the real code — see
# patch_kasmvnc_lastactiveat.py) to tick multiple times afterward. 25s is
# 5 full ticks; the original bug crashed on literally the first one
# (confirmed: reproduced 5/5 times against the unpatched image during
# this test's own development), so this has wide margin without making
# the test unnecessarily slow.
POST_DISCONNECT_WATCH_SECONDS = 25
CONNECT_SETTLE_SECONDS = 8


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print(f"$ {' '.join(cmd)}")
    kwargs.setdefault("check", True)
    return subprocess.run(cmd, **kwargs)


def pick_free_port() -> int:
    """Same technique `rust_gateway`'s own `pick_free_port` uses (see
    `rust_gateway/src/workspaces/container.rs`): bind to port 0, read back
    the OS-assigned port, release it immediately. Used as the CDP port's
    default instead of the conventional 9222 — confirmed on this exact
    machine that something else already holds 9222 permanently, which
    would otherwise make this script fail non-deterministically depending
    on what else happens to be running."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_chrome_binary(explicit: str | None) -> str:
    if explicit:
        return explicit
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    which = shutil.which("google-chrome") or shutil.which("chromium")
    if which:
        return which
    raise SystemExit(
        "No Chrome/Chromium binary found. Pass one explicitly with "
        "--chrome-binary /path/to/chrome."
    )


def build_image(image_tag: str) -> None:
    run(
        ["docker", "build", "-t", image_tag, "-f", DOCKERFILE, "."],
        cwd=REPO_ROOT,
    )


def launch_container(image_tag: str) -> tuple[int, int]:
    """`docker run` the image directly (no rust_gateway involved — see
    module doc for why) and return (wrapper_host_port, desktop_host_port).
    Publishes both container ports to OS-assigned free host ports, exactly
    like `DockerCliLauncher::launch` does in production, just via `docker
    run` instead of separate create+cp+start (this test does not need the
    wrapper boot script at all, only the desktop)."""
    run(["docker", "rm", "-f", CONTAINER_NAME], check=False)
    run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            CONTAINER_NAME,
            "-p",
            "0:8787",
            "-p",
            "0:3000",
            image_tag,
        ]
    )
    port_output = subprocess.run(
        ["docker", "port", CONTAINER_NAME], capture_output=True, text=True, check=True
    ).stdout
    wrapper_port = desktop_port = None
    for line in port_output.splitlines():
        if "8787/tcp" in line and "0.0.0.0" in line:
            wrapper_port = int(line.rsplit(":", 1)[-1])
        elif "3000/tcp" in line and "0.0.0.0" in line:
            desktop_port = int(line.rsplit(":", 1)[-1])
    if wrapper_port is None or desktop_port is None:
        raise RuntimeError(f"could not parse ports from `docker port` output:\n{port_output}")
    return wrapper_port, desktop_port


def wait_for_desktop_ready(desktop_port: int, timeout_s: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_s
    url = f"http://127.0.0.1:{desktop_port}/"
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, OSError) as err:
            last_error = err
        time.sleep(0.5)
    raise TimeoutError(f"desktop at {url} did not become ready within {timeout_s}s: {last_error}")


def kill_xvnc_in_container(container_name: str) -> None:
    """The real, confirmed trigger — see this module's own doc comment
    for why a Disconnect-button click does NOT reach the buggy code path
    at all. `Xvnc` is the actual VNC server process the base image runs
    (confirmed live: `ps aux` inside a running container); killing it
    drops the client's WebSocket without a clean close handshake, which
    is exactly what `core/rfb.js`'s `_fail()` path (and therefore
    `app/ui.js`'s `disconnectFinished({clean: false})`) is for."""
    subprocess.run(
        ["docker", "exec", container_name, "pkill", "-9", "Xvnc"],
        check=False,
    )


async def drive_unclean_disconnect_and_watch_for_crash(
    desktop_port: int, container_name: str, chrome_binary: str, chrome_profile_dir: Path, cdp_port: int
) -> list[str]:
    """Launch a real headless Chrome, navigate to the real desktop URL,
    wait for the VNC connection to establish, then kill the real
    server-side `Xvnc` process (see `kill_xvnc_in_container` — a clean,
    user-initiated disconnect does NOT reach the buggy code, only an
    unclean/server-initiated one does). Returns every
    `Runtime.exceptionThrown` message text observed in the following
    `POST_DISCONNECT_WATCH_SECONDS`. An empty list means the fix holds."""
    chrome_proc = subprocess.Popen(
        [
            chrome_binary,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            f"--user-data-dir={chrome_profile_dir}",
            f"--remote-debugging-port={cdp_port}",
            "--remote-allow-origins=*",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        version_url = f"http://127.0.0.1:{cdp_port}/json/version"
        deadline = time.monotonic() + 10
        browser_ws_url = None
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(version_url, timeout=1) as resp:
                    browser_ws_url = json.loads(resp.read())["webSocketDebuggerUrl"]
                    break
            except (urllib.error.URLError, OSError, KeyError):
                time.sleep(0.3)
        if browser_ws_url is None:
            raise TimeoutError("Chrome's CDP endpoint never became reachable")

        exceptions: list[str] = []
        async with websockets.connect(browser_ws_url, max_size=None) as ws:
            msg_id = 0

            async def send(method: str, params: dict | None = None, session_id: str | None = None) -> int:
                nonlocal msg_id
                msg_id += 1
                payload = {"id": msg_id, "method": method, "params": params or {}}
                if session_id:
                    payload["sessionId"] = session_id
                await ws.send(json.dumps(payload))
                return msg_id

            async def recv_until(target_id: int, session_id: str | None = None) -> dict:
                while True:
                    raw = await ws.recv()
                    data = json.loads(raw)
                    if data.get("id") == target_id and data.get("sessionId") == session_id:
                        return data

            create_id = await send("Target.createTarget", {"url": "about:blank"})
            target_id = (await recv_until(create_id))["result"]["targetId"]

            attach_id = await send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
            session_id = (await recv_until(attach_id))["result"]["sessionId"]

            for domain in ("Page", "Runtime"):
                enable_id = await send(f"{domain}.enable", {}, session_id)
                await recv_until(enable_id, session_id)

            desktop_url = f"http://127.0.0.1:{desktop_port}/"
            nav_id = await send("Page.navigate", {"url": desktop_url}, session_id)
            await recv_until(nav_id, session_id)

            await asyncio.sleep(CONNECT_SETTLE_SECONDS)

            # Confirm the connection genuinely established before killing
            # the server — a failure here means this run proves nothing
            # (never reached the state the bug needs), so it must be a
            # hard error, not a silently-ignored warning.
            conn_check_id = await send(
                "Runtime.evaluate",
                {
                    "expression": """
                        (function() {
                            var iframe = document.querySelector('iframe.vnc')
                                || document.querySelector('iframe[src*="vnc/index.html"]');
                            if (!iframe) return 'ERROR: no vnc iframe found';
                            var doc = iframe.contentDocument;
                            if (!doc) return 'ERROR: no access to iframe document';
                            return doc.documentElement.className;
                        })()
                    """,
                    "awaitPromise": False,
                },
                session_id,
            )
            conn_result = await recv_until(conn_check_id, session_id)
            conn_class = conn_result.get("result", {}).get("result", {}).get("value", "")
            print(f"vnc iframe connection state: {conn_class!r}")
            if "noVNC_connected" not in conn_class:
                raise RuntimeError(
                    f"the VNC connection never reached noVNC_connected within "
                    f"{CONNECT_SETTLE_SECONDS}s (state: {conn_class!r}) — this run proves "
                    f"nothing about the crash, since the bug only fires on an unclean "
                    f"disconnect FROM an established connection"
                )

            kill_xvnc_in_container(container_name)
            print("killed the real Xvnc server process (unclean disconnect trigger)")

            end_time = asyncio.get_event_loop().time() + POST_DISCONNECT_WATCH_SECONDS
            while asyncio.get_event_loop().time() < end_time:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1)
                except asyncio.TimeoutError:
                    continue
                data = json.loads(raw)
                if data.get("method") == "Runtime.exceptionThrown":
                    details = data["params"].get("exceptionDetails", {})
                    text = details.get("exception", {}).get("description") or details.get("text", "")
                    exceptions.append(text)

        return exceptions
    finally:
        chrome_proc.terminate()
        try:
            chrome_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome_proc.kill()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-tag", default=DEFAULT_IMAGE_TAG)
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing image tag")
    parser.add_argument(
        "--keep-image",
        action="store_true",
        help="don't docker rmi the test image on exit — ALWAYS effectively true when "
        "--skip-build is set (see below), regardless of this flag's own value",
    )
    parser.add_argument("--chrome-binary", default=None)
    parser.add_argument(
        "--cdp-port",
        type=int,
        default=None,
        help="defaults to an OS-assigned free port (see pick_free_port) rather than the "
        "conventional 9222, since that port is not reliably free on every machine",
    )
    args = parser.parse_args()

    cdp_port = args.cdp_port if args.cdp_port is not None else pick_free_port()
    chrome_binary = find_chrome_binary(args.chrome_binary)

    if not args.skip_build:
        build_image(args.image_tag)

    chrome_profile_dir = Path("/tmp") / f"e2e-lastactiveat-chrome-{int(time.time())}"
    chrome_profile_dir.mkdir(parents=True, exist_ok=True)

    try:
        _wrapper_port, desktop_port = launch_container(args.image_tag)
        print(f"container up, desktop published on host port {desktop_port}")
        wait_for_desktop_ready(desktop_port)
        print("desktop root answers 200, proceeding to browser test")

        exceptions = asyncio.run(
            drive_unclean_disconnect_and_watch_for_crash(
                desktop_port, CONTAINER_NAME, chrome_binary, chrome_profile_dir, cdp_port
            )
        )

        if exceptions:
            print(
                f"\nFAIL: {len(exceptions)} uncaught exception(s) after killing the real "
                f"Xvnc server process and waiting {POST_DISCONNECT_WATCH_SECONDS}s:",
                file=sys.stderr,
            )
            for exc in exceptions:
                print(f"  {exc}", file=sys.stderr)
            return 1

        print(
            f"\nPASS: zero exceptions across {POST_DISCONNECT_WATCH_SECONDS}s "
            f"after a real unclean (server-killed) disconnect."
        )
        return 0
    finally:
        run(["docker", "rm", "-f", CONTAINER_NAME], check=False)
        # Real hazard this guards against: `--skip-build --image-tag
        # hermes-workspace:dev` reuses the SAME tag the real dev gateway
        # points at (see rust_gateway's WORKSPACE_IMAGE_TAG config) — a
        # bare `docker rmi` on exit would delete that shared, real image
        # out from under it. Only ever `docker rmi` an image THIS script
        # itself built; never one it was told to merely reuse.
        if not args.keep_image and not args.skip_build:
            run(["docker", "rmi", args.image_tag], check=False)
        shutil.rmtree(chrome_profile_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
