"""Best-effort start/stop of upstream's background runtime services.

No socket binding, no auto-install, no destructive reconcile, no env
mutation, no global process kill happens here. Each action is isolated so
one failing subsystem never blocks the others; failures are logged, not
raised.
"""
from __future__ import annotations

import logging
from typing import Callable

logger = logging.getLogger(__name__)


def _run(label: str, action: Callable[[], None]) -> None:
    try:
        action()
    except Exception:
        logger.exception("hermes_webui_wrapper runtime: %s failed", label)


def start_runtime() -> None:
    """Prepare upstream's on-disk state and start its background services.

    Must run after bootstrap_upstream() has put the pinned upstream
    checkout on sys.path, since every upstream symbol is imported lazily
    here.
    """
    from api import config as upstream_config

    def _mkdirs() -> None:
        from pathlib import Path

        Path(upstream_config.STATE_DIR).mkdir(parents=True, exist_ok=True)
        Path(upstream_config.SESSION_DIR).mkdir(parents=True, exist_ok=True)
        Path(upstream_config.DEFAULT_WORKSPACE).mkdir(parents=True, exist_ok=True)

    _run("create state directories", _mkdirs)

    def _fix_permissions() -> None:
        from api.startup import fix_credential_permissions

        fix_credential_permissions()

    _run("fix credential permissions", _fix_permissions)

    def _start_gateway_watcher() -> None:
        from api.gateway_watcher import start_watcher

        start_watcher()

    _run("start gateway watcher", _start_gateway_watcher)

    def _start_drain_thread() -> None:
        from api.background_process import start_drain_thread

        start_drain_thread()

    _run("start drain thread", _start_drain_thread)

    def _start_session_channel_reaper() -> None:
        from api.background_process import start_session_channel_reaper

        start_session_channel_reaper()

    _run("start session channel reaper", _start_session_channel_reaper)

    def _load_plugins() -> None:
        from api.plugins import load_plugins

        load_plugins()

    _run("load plugins", _load_plugins)


def stop_runtime() -> None:
    """Best-effort shutdown of upstream's background services, mirroring
    start_runtime()'s isolation: one failure never blocks the rest."""

    def _stop_gateway_watcher() -> None:
        from api.gateway_watcher import stop_watcher

        stop_watcher()

    _run("stop gateway watcher", _stop_gateway_watcher)

    def _drain_all_on_shutdown() -> None:
        from api.session_lifecycle import drain_all_on_shutdown

        drain_all_on_shutdown()

    _run("drain all sessions on shutdown", _drain_all_on_shutdown)

    def _stop_drain_thread() -> None:
        from api.background_process import stop_drain_thread

        stop_drain_thread()

    _run("stop drain thread", _stop_drain_thread)

    def _stop_session_channel_reaper() -> None:
        from api.background_process import stop_session_channel_reaper

        stop_session_channel_reaper()

    _run("stop session channel reaper", _stop_session_channel_reaper)
