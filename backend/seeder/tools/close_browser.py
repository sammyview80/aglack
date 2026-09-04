"""close_browser — global MCP tool: stop the CALLING agent's own dedicated
browser instance.

Sibling of `open_browser.py` (this directory) — read that module's
docstring for the two design points that apply verbatim here:

1. Identity comes from the runner, never the caller: the agent id is read
   from `arguments["_agent_id"]`, injected by `seeder_kit.runner` from its
   own `--agent-id` launch argument after stripping anything the MCP client
   supplied (see `seeder_kit/discovery.py`'s "Runner-injected `arguments`
   key"). Absent key -> refuse, never guess.
2. This module mirrors, standalone via `urllib.request`, the wrapper's
   `features/browser/service.py::_call_browser_route` (`POST
   {GATEWAY_INTERNAL_URL}/workspaces/{INTEGRATIONS_WORKSPACE_ID}/browser/
   {agent_id}/stop`, bearer from `INTEGRATIONS_TOKEN_PATH`) because a tool
   module runs in a separate `seeder_kit.runner` subprocess and cannot
   import `hermes_webui_wrapper` — the same boundary `update_soul.py`
   documents.

Errors are returned as a `{"error": ...}` JSON text payload (never raised),
matching `update_soul.py`'s return shape.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

TOOL_NAME = "close_browser"
TOOL_DESCRIPTION = (
    "Stop THIS agent's own dedicated browser instance. Takes no arguments — the agent "
    "identity comes from this tool server's own launch, never from the caller."
)
TOOL_INPUT_SCHEMA = {"type": "object", "properties": {}}

_DEFAULT_TOKEN_PATH = "/run/hermes/integrations.token"
_ACTION = "stop"


def _error(message: str) -> list[dict]:
    return [{"type": "text", "text": json.dumps({"error": message})}]


def _read_bearer() -> str:
    """Mirror of the wrapper's `features/browser/service.py::_read_bearer`
    + `config.resolve_integrations_token_path` (same env var, same
    default)."""
    token_path = Path(os.environ.get("INTEGRATIONS_TOKEN_PATH", "").strip() or _DEFAULT_TOKEN_PATH)
    bearer = token_path.read_text(encoding="utf-8").strip()
    if not bearer:
        raise ValueError(f"integrations token file at {token_path} is empty")
    return bearer


def _gateway_route(agent_id: str) -> str:
    """Mirror of `config.resolve_gateway_internal_url` /
    `resolve_integrations_workspace_id` — both fail closed on a missing
    value, never guess."""
    gateway_url = os.environ.get("GATEWAY_INTERNAL_URL", "").strip()
    if not gateway_url:
        raise ValueError("GATEWAY_INTERNAL_URL is not set — cannot reach the gateway's browser route")
    workspace_id = os.environ.get("INTEGRATIONS_WORKSPACE_ID", "").strip()
    if not workspace_id:
        raise ValueError("INTEGRATIONS_WORKSPACE_ID is not set — this container does not know its workspace id")
    return f"{gateway_url.rstrip('/')}/workspaces/{workspace_id}/browser/{agent_id}/{_ACTION}"


async def handle(arguments: dict) -> list[dict]:
    agent_id = arguments.get("_agent_id")
    if not agent_id:
        return _error(
            "agent identity required but not provided: this tool only works when its "
            "MCP server process was launched with --agent-id (seeder_kit.runner), so "
            "the browser it stops is provably this agent's own. Refusing to guess."
        )

    try:
        url = _gateway_route(str(agent_id))
        bearer = _read_bearer()
    except (OSError, ValueError) as exc:
        return _error(f"browser gateway not configured: {exc}")

    req = urllib.request.Request(
        url, data=b"", method="POST", headers={"Authorization": f"Bearer {bearer}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"error": f"gateway returned HTTP {exc.code}: {raw[:200]}"}
        return [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]
    except urllib.error.URLError as exc:
        return _error(f"gateway unreachable: {exc}")

    try:
        payload = json.loads(raw)
    except ValueError:
        return _error(f"gateway returned non-JSON body: {raw[:200]}")

    result = payload if isinstance(payload, dict) else {"data": payload}
    return [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]
