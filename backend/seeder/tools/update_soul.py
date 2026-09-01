"""update_soul — global MCP tool available to every seeded agent.

Calls the wrapper's own native `PUT /api/wrapper/v1/agent-config/{name}/soul`
route over HTTP (this tool module runs inside a separate `seeder_kit.runner`
subprocess, not inside the wrapper's own process, so it cannot import
`hermes_webui_wrapper.features.agent_config.service` directly — going
through the wrapper's own HTTP API is the correct boundary here, not a
duplicate of that logic). See
`../../wrapper/src/hermes_webui_wrapper/features/agent_config/service.py`
for what this ultimately writes (SOUL.md, always-overwrite, no
skip-if-exists guard).

Reads the wrapper's base URL from `HERMES_WRAPPER_URL`
(default `http://127.0.0.1:8787`, matching
`hermes_webui_wrapper.__main__`'s own `HERMES_WRAPPER_HOST`/
`HERMES_WRAPPER_PORT` defaults) so this works unchanged whether the wrapper
and this MCP subprocess share a container network namespace or not.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

TOOL_NAME = "update_soul"
TOOL_DESCRIPTION = (
    "Overwrite SOUL.md (identity/personality) for a named Hermes agent/profile. "
    "Always writes — no skip-if-exists guard. Use this to change an agent's "
    "existing identity, not just fill in a missing one."
)
TOOL_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "agent_name": {"type": "string", "description": "Hermes profile name"},
        "content": {"type": "string", "description": "Full replacement SOUL.md markdown content"},
    },
    "required": ["agent_name", "content"],
}


def _wrapper_base_url() -> str:
    return os.environ.get("HERMES_WRAPPER_URL", "http://127.0.0.1:8787").rstrip("/")


async def handle(arguments: dict) -> list[dict]:
    agent_name = str(arguments.get("agent_name") or "").strip()
    content = str(arguments.get("content") or "")
    if not agent_name:
        return [{"type": "text", "text": json.dumps({"error": "agent_name is required"})}]
    if not content.strip():
        return [{"type": "text", "text": json.dumps({"error": "content is required"})}]

    url = f"{_wrapper_base_url()}/api/wrapper/v1/agent-config/{agent_name}/soul"
    body = json.dumps({"content": content}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PUT", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        payload = json.loads(exc.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        return [{"type": "text", "text": json.dumps({"error": f"wrapper unreachable: {exc}"})}]

    return [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]
