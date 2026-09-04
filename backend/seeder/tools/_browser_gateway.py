"""_browser_gateway — shared helper (NOT a tool): the one "start this agent's
browser via the gateway" call that both `open_browser.py` and
`browser_task.py` use.

Leading underscore: `seeder_kit/discovery.py`'s `discover_tools_in_dirs`
skips `*.py` files whose name starts with `_` (`if py_file.name.startswith("_"):
continue`), so this file is never registered as an MCP tool — it defines no
`TOOL_NAME`/`handle`. Same convention as `_browser_use_llm.py`.

This is `open_browser.py`'s former inline body, moved verbatim so the two
tool modules share ONE `urllib.request` call site instead of two copies.
Read `open_browser.py`'s module docstring for the full reasoning behind the
route, the env vars, the loopback `cdp_url`, and why this uses stdlib
`urllib.request` rather than `httpx`:

    POST {GATEWAY_INTERNAL_URL}/workspaces/{INTEGRATIONS_WORKSPACE_ID}/browser/{agent_id}/start
    Authorization: Bearer <contents of INTEGRATIONS_TOKEN_PATH>

`close_browser.py` deliberately keeps its own small self-contained "stop"
mirror — only the "start" action lives here.

Result shape
------------
`start_browser_session(agent_id)` never raises; it returns a
`BrowserStartResult` whose `payload` is exactly the dict `open_browser`
has always serialised, and `as_text_content(result)` reproduces
`open_browser`'s exact historical JSON text byte for byte:

- a locally-detected failure (gateway not configured, unreachable, non-JSON
  body) -> `payload == {"error": ...}`, `local_error=True`, serialised with
  `json.dumps(payload)` (default `ensure_ascii`), as the old `_error` did;
- anything the gateway itself answered (success JSON, or an HTTP error
  status's JSON/fallback dict) -> `local_error=False`, serialised with
  `ensure_ascii=False`, as the old success/HTTPError paths did.

`cdp_url` is set only when the gateway's JSON carried a `cdp_port`/`port`/
`cdpPort`; when set it has also been added to `payload["cdp_url"]`.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import NamedTuple

_DEFAULT_TOKEN_PATH = "/run/hermes/integrations.token"
_ACTION = "start"


class BrowserStartResult(NamedTuple):
    cdp_url: str | None
    payload: dict
    local_error: bool


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


def _cdp_url_from_status(status_data: dict) -> str | None:
    """Same defensive key-spelling read as the wrapper's
    `_cdp_url_from_status`; loopback address on purpose (see
    `open_browser.py`'s module docstring)."""
    port = status_data.get("cdp_port") or status_data.get("port") or status_data.get("cdpPort")
    if not port:
        return None
    return f"http://127.0.0.1:{port}"


def start_browser_session(agent_id: str) -> BrowserStartResult:
    """POST the gateway's browser `start` route for `agent_id`. Never
    raises — see module docstring for the result shape."""
    try:
        url = _gateway_route(str(agent_id))
        bearer = _read_bearer()
    except (OSError, ValueError) as exc:
        return BrowserStartResult(None, {"error": f"browser gateway not configured: {exc}"}, True)

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
        return BrowserStartResult(None, payload, False)
    except urllib.error.URLError as exc:
        return BrowserStartResult(None, {"error": f"gateway unreachable: {exc}"}, True)

    try:
        payload = json.loads(raw)
    except ValueError:
        return BrowserStartResult(None, {"error": f"gateway returned non-JSON body: {raw[:200]}"}, True)

    result = dict(payload) if isinstance(payload, dict) else {"data": payload}
    cdp_url = _cdp_url_from_status(result)
    if cdp_url:
        result["cdp_url"] = cdp_url
    return BrowserStartResult(cdp_url, result, False)


def as_text_content(result: BrowserStartResult) -> list[dict]:
    """Serialise exactly as `open_browser.handle` always has (see module
    docstring, "Result shape")."""
    if result.local_error:
        return _error(str(result.payload.get("error")))
    return [{"type": "text", "text": json.dumps(result.payload, ensure_ascii=False)}]
