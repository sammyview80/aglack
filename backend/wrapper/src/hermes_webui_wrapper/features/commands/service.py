"""Commands feature service — calls upstream's `api.commands` functions
directly instead of routing through the catch-all stdlib-handler-emulation
proxy (`transport/dispatcher.py`). Same shape as `features/onboarding/
service.py`; read that module's docstring for why the native path exists.

Every upstream function wrapped here (`list_commands`, `list_command_bundles`,
`resolve_moa_config`, `resolve_bundle_command`, `execute_agent_command`,
`execute_plugin_command`) is a plain function taking/returning plain data —
no `BaseHTTPRequestHandler` involved — so it can be called natively.

Profile binding: `list_command_bundles`, `resolve_bundle_command` and
`execute_agent_command` read the ACTIVE profile through upstream's
thread-local (`api.profiles.get_active_profile_name`). On the proxied path
that thread-local is set from the `hermes_profile` cookie by
`transport/dispatcher.py` (`set_request_profile(cookie_profile)` ...
`finally: clear_request_profile()`). A native FastAPI route never goes
through that dispatcher, so every function below takes an explicit
`profile` argument and reproduces the same bind/unbind around the upstream
call via `_bound_profile()` — always cleared, even on exception, so a
threadpool worker never leaks one request's profile into the next. A
`None`/empty profile is a no-op (upstream's own default-profile behavior).

Every function here is synchronous and potentially blocking (file I/O,
plugin execution, runtime reloads) — callers in `api/v1/commands.py` MUST
run these via `envelope.service_call`'s threadpool hop, never await them
directly.

As with every other feature in this wrapper, no upstream symbol is imported
at module import time — every function below imports `api.commands` /
`api.profiles` lazily, after `bootstrap_upstream()` has already run for
this process (see `upstream.py`, rule 1 in AGENTS.md).
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

from hermes_webui_wrapper.features.errors import FeatureError


def _sanitize(message: str) -> str:
    """Strip absolute filesystem paths from an upstream RuntimeError's text
    before it reaches the client — mirrors upstream `api/helpers.py`'s own
    `_sanitize_error`, which `routes.py` runs every RuntimeError message
    from these same endpoints through (see `/api/commands/bundles/resolve`
    and `/api/commands/exec` in routes.py). No `commands.py` RuntimeError
    embeds a path today, but this keeps the mapping byte-for-byte faithful
    instead of silently diverging the moment one does."""
    import re

    return re.sub(r"(?:(?:/[a-zA-Z0-9_.-]+)+|(?:[A-Z]:\\[^\s]+))", "<path>", message)


class CommandsError(FeatureError):
    """This feature's `FeatureError` — see `features/errors.py`.
    `status_code` mirrors upstream `routes.py`'s own mapping for these
    exact endpoints: ValueError -> 400, KeyError -> 404, RuntimeError ->
    500 (`/api/commands/moa/resolve` alone maps RuntimeError -> 503),
    rather than inventing a new one, so behavior stays identical to what
    the proxied catch-all route already did for these paths."""


@contextmanager
def _bound_profile(profile: str | None) -> Iterator[None]:
    """Bind `profile` as upstream's active request profile for the duration
    of the block — the same `set_request_profile` / `clear_request_profile`
    pair `transport/dispatcher.py` wraps every proxied request in, driven
    here by an explicit name instead of the `hermes_profile` cookie. No-op
    when `profile` is None/empty."""
    if not profile:
        yield
        return
    from api.profiles import clear_request_profile, set_request_profile

    set_request_profile(profile)
    try:
        yield
    finally:
        clear_request_profile()


def _wrap(
    code: str,
    fn,
    *args,
    profile: str | None = None,
    runtime_status: int = 500,
    key_error_message: str | None = None,
    **kwargs,
):
    """Call an upstream `api.commands` function under `_bound_profile`,
    translating its plain ValueError/KeyError/RuntimeError into
    `CommandsError` with the same status-code mapping `api/routes.py` uses
    for these endpoints. `runtime_status` exists only for
    `/moa/resolve`, which upstream maps RuntimeError -> 503 instead of 500;
    `key_error_message` lets `/exec` keep upstream's fixed
    "Plugin command not found" text."""
    try:
        with _bound_profile(profile):
            return fn(*args, **kwargs)
    except ValueError as exc:
        raise CommandsError(code, str(exc), 400) from exc
    except KeyError as exc:
        message = key_error_message or str(exc).strip("'\"") or "not found"
        raise CommandsError(code, message, 404) from exc
    except RuntimeError as exc:
        raise CommandsError(code, _sanitize(str(exc)), runtime_status) from exc


def list_commands(profile: str | None = None) -> list[dict[str, Any]]:
    from api.commands import list_commands as upstream_list_commands

    return _wrap("commands_list_failed", upstream_list_commands, profile=profile)


def list_bundles(profile: str | None = None) -> list[dict[str, Any]]:
    from api.commands import list_command_bundles

    return _wrap("commands_bundles_failed", list_command_bundles, profile=profile)


def resolve_moa(profile: str | None = None) -> dict[str, Any]:
    """No `preset` argument: upstream's own `GET /api/commands/moa/resolve`
    (routes.py) always calls `resolve_moa_config()` with none — `preset` is
    only ever passed internally from chat-model-resolution code, never from
    this HTTP endpoint. Exposing it here would be new surface this native
    route does not own; kept out to stay a faithful port of the endpoint
    being wrapped."""
    from api.commands import resolve_moa_config

    # routes.py maps RuntimeError -> 503 for this one endpoint (MoA runtime
    # unavailable), not the 500 every other commands endpoint uses.
    return _wrap(
        "commands_moa_resolve_failed",
        resolve_moa_config,
        profile=profile,
        runtime_status=503,
    )


def resolve_bundle(command: str, profile: str | None = None) -> dict[str, Any]:
    from api.commands import resolve_bundle_command

    # routes.py:16549-16550 returns the fixed literal "Bundle command not
    # found" for every KeyError here, never the raw bundle name — same
    # convention exec_command already applies via its own
    # key_error_message below.
    return _wrap(
        "commands_bundle_resolve_failed",
        resolve_bundle_command,
        command,
        profile=profile,
        key_error_message="Bundle command not found",
    )


def _execute(command: str) -> str:
    """Mirror routes.py's `/api/commands/exec` two-step: try the narrow
    agent-command allowlist first, ignoring ITS KeyError (command simply
    isn't an agent command), then fall through to the plugin command path,
    whose own KeyError means "Plugin command not found" (404)."""
    from api.commands import execute_agent_command, execute_plugin_command

    try:
        return execute_agent_command(command)
    except KeyError:
        pass
    return execute_plugin_command(command)


def exec_command(command: str, profile: str | None = None) -> dict[str, Any]:
    output = _wrap(
        "commands_exec_failed",
        _execute,
        command,
        profile=profile,
        key_error_message="Plugin command not found",
    )
    return {"output": output}
