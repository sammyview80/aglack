"""Browser feature service — the wrapper-side reference implementation of
calling the gateway's per-agent browser lifecycle routes:
`POST /workspaces/<workspace_id>/browser/<agent_id>/{start,stop,status}`
(`rust_gateway/src/workspaces/proxy/browser_proxy.rs`), authenticated with
the SAME per-workspace integrations bearer `features/integrations/service.py`'s
`relay_mcp_call` uses (gated by `mcp_proxy.rs`'s `require_workspace_bearer`).

======================================================================
Where the agent-facing `open_browser`/`close_browser` MCP tools live now
======================================================================

NOT in this process. They are per-agent STDIO tool modules,
`backend/seeder/tools/open_browser.py` and `close_browser.py`, served by
`seeder_kit.runner` — one subprocess per agent, launched from that agent's
own `config.yaml` `mcp_servers.hermes-seeder` entry with `--agent-id
<slug>` (written by `features/agent_seeder/service.py::_apply_mcp_tools`).
The runner injects that launch-time identity into every tool call as
`arguments["_agent_id"]` after stripping anything the MCP client supplied
(see `seeder_kit/discovery.py`'s module docstring), so the tool acts on
exactly the agent whose process it is. Those tool modules cannot import
this module (separate process, zero Hermes/upstream knowledge by design —
the same boundary `backend/seeder/tools/update_soul.py` documents), so
they re-implement `_call_browser_route`/`_cdp_url_from_status` below
standalone with `urllib.request`, reading the same env vars. This module
stays as the wrapper-side, unit-tested reference for that exact call
shape (`tests/v1/test_integrations.py::TestBrowserServiceUnit`); keep the
two in sync if the gateway route or env-var names ever change.

Why they were moved (history — the earlier "CRITICAL, CONFIRMED GAP")
--------------------------------------------------------------------
An earlier revision exposed `open_browser`/`close_browser` on
`features/integrations/mcp_server.py`, the wrapper's ONE shared HTTP MCP
server mounted at a single fixed URL that `set_agent_enabled` writes
verbatim into every agent's `config.yaml`. A tool call arriving there is
served by a FastAPI request task with no per-agent path segment, header,
or query parameter, and upstream's thread-local profile context
(`api.profiles.get_active_profile_name()`, set per agent-turn thread in
`api/streaming.py`) does not propagate across that HTTP boundary. There
was therefore no grounded "which agent is calling" accessor, and the tools
failed closed on every call (`browser_agent_id_unresolved`) rather than
trusting an unscoped thread-local as a security boundary. The stdio
per-agent transport has real process-level identity, so the tools moved
there; the always-failing HTTP versions were removed as dead code.

`BrowserError` is its own `FeatureError` subclass (NOT a reuse of
`IntegrationsError`): this feature's failure modes are distinct from
OpenConnector relay failures, and keeping the error CODE namespace
feature-scoped (`browser_*` vs `integrations_*`) matches every other
feature in this wrapper's convention of never sharing one error class
across two features just because they share http-calling code.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import httpx

from hermes_webui_wrapper.features.errors import FeatureError

_BrowserAction = Literal["start", "stop", "status"]


class BrowserError(FeatureError):
    """This feature's `FeatureError` — see `features/errors.py` and this
    module's own docstring for why it is a separate class from
    `IntegrationsError` despite sharing that module's gateway-calling
    shape."""


def _read_bearer(token_path: Path) -> str:
    """Byte-for-byte the same shape as
    `features/integrations/service.py::_read_bearer` — duplicated (not
    imported) because it raises ITS OWN feature's error class
    (`BrowserError`, not `IntegrationsError`), matching this module's own
    "separate error namespace" decision above. The read/parse logic
    itself has no feature-specific behavior worth sharing beyond that."""
    try:
        bearer = token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise BrowserError(
            "browser_token_missing",
            f"No integrations token at {token_path} — this workspace has no "
            "connected integrations yet, or the token has not been delivered "
            "into this container.",
            409,
        ) from exc
    except OSError as exc:
        raise BrowserError("browser_token_unreadable", str(exc), 500) from exc
    if not bearer:
        raise BrowserError(
            "browser_token_empty", f"Integrations token file at {token_path} is empty.", 500
        )
    return bearer


def _call_browser_route(agent_id: str, action: _BrowserAction) -> dict[str, Any]:
    """`POST /workspaces/<workspace_id>/browser/<agent_id>/<action>` on
    the gateway, using this container's own integrations bearer — same
    three resolvers `relay_mcp_call` uses, reused directly (see this
    module's own docstring). Returns the gateway's parsed JSON response
    body verbatim on a 2xx; raises `BrowserError` on anything else,
    mapping the gateway's own `{"ok": false, "error": {code, message}}`
    envelope when parseable (same convention `relay_mcp_call` already
    applies for `/mcp`).

    `agent_id` here is a plain parameter because this is wrapper-internal
    plumbing with no agent-facing caller; the agent-facing tool modules in
    `backend/seeder/tools/` get theirs from the runner's launch identity
    only (see module docstring)."""
    from hermes_webui_wrapper.config import (
        resolve_gateway_internal_url,
        resolve_integrations_token_path,
        resolve_integrations_workspace_id,
    )

    bearer = _read_bearer(resolve_integrations_token_path())
    gateway_url = resolve_gateway_internal_url()
    workspace_id = resolve_integrations_workspace_id()

    try:
        response = httpx.post(
            f"{gateway_url}/workspaces/{workspace_id}/browser/{agent_id}/{action}",
            headers={"Authorization": f"Bearer {bearer}"},
            timeout=30.0,
        )
    except httpx.HTTPError as exc:
        raise BrowserError("browser_gateway_unreachable", str(exc), 502) from exc

    if response.status_code >= 400:
        try:
            payload = response.json()
            err = payload.get("error") if isinstance(payload, dict) else None
        except ValueError:
            err = None
        if not isinstance(err, dict):
            err = {}
        raise BrowserError(
            err.get("code", "browser_gateway_error"),
            err.get("message", f"Gateway returned HTTP {response.status_code}"),
            response.status_code,
        )

    try:
        return response.json()
    except ValueError as exc:
        raise BrowserError(
            "browser_gateway_invalid_response",
            f"Gateway returned non-JSON body (status {response.status_code}): {exc}",
            502,
        ) from exc


def _cdp_url_from_status(status_data: dict[str, Any]) -> str | None:
    """Build the `cdp_url` an agent's OWN browser-automation tool call
    should use to reach the just-started browser.

    Concluded `127.0.0.1:<port>` (loopback), NOT any gateway-routed
    address: this whole feature's design (see `browser_proxy.rs`'s own
    module docstring — the daemon it forwards to is "a SIBLING process to
    the wrapper inside the SAME container") means the agent process
    calling the MCP tool and the browser-manager daemon it just started
    both run inside the identical container/network-namespace. The
    gateway's own `/workspaces/:id/browser/...` route is reachable only
    from OUTSIDE that container (over the gateway's own published port,
    itself bearer-gated) — routing the agent's own subsequent CDP
    connection back out through the gateway would be a needless network
    hop through a proxy that does not even forward CDP's websocket
    upgrade shape, and would leak this container's cross-workspace
    routing concern into a tool result an agent has no legitimate need to
    know about. The daemon's own `start`/`status` response is expected to
    report the real loopback `cdp_port` it bound (see
    `backend/workspace-image/browser_manager.py`) — this helper reads
    that value defensively (a couple of plausible key spellings) rather
    than assuming one exact shape, since the daemon's response schema is
    owned by that sibling process, not this wrapper.
    `backend/seeder/tools/open_browser.py` mirrors this logic inline.
    """
    port = (
        status_data.get("cdp_port")
        or status_data.get("port")
        or status_data.get("cdpPort")
    )
    if not port:
        return None
    return f"http://127.0.0.1:{port}"
