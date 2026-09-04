"""open_browser — global MCP tool: start (or confirm already running) the
CALLING agent's own dedicated browser, and report where its CDP endpoint is
reachable from that agent's own tool-execution context.

Identity comes from the runner, never the caller
------------------------------------------------
This module takes ZERO caller-supplied parameters. The agent whose browser
gets opened is read from `arguments["_agent_id"]`, which
`seeder_kit.runner` injects immediately before calling `handle()` from its
own `--agent-id` launch argument (see `seeder_kit/discovery.py`'s module
docstring, "Runner-injected `arguments` key"). The runner strips any
`_agent_id` an MCP client put in the `tools/call` payload before setting
its own, so the value seen here is always the identity of the ONE agent
this stdio subprocess was launched for — `features/agent_seeder/service.py`
writes a separate `mcp_servers.hermes-seeder` entry (with `--agent-id
<slug>`) into each agent's own `config.yaml`. If the key is absent (a
runner launched without `--agent-id`), this tool refuses to act rather
than guessing.

This is the fix for the gap `backend/wrapper/src/hermes_webui_wrapper/
features/browser/service.py` documents under "CRITICAL, CONFIRMED GAP":
the wrapper's shared HTTP-mounted `integrations` MCP server has no way to
know which agent is calling, but a per-agent stdio subprocess does.

Why this duplicates the wrapper's gateway call instead of importing it
----------------------------------------------------------------------
Same boundary `update_soul.py` (this directory) already documents: this
tool module runs inside a separate `seeder_kit.runner` subprocess, not
inside the wrapper's own process, so it cannot import
`hermes_webui_wrapper.features.browser.service` (and `seeder_kit`/
`backend/seeder/` have zero Hermes/upstream knowledge by design — see
`backend/seeder_kit/README.md`). It therefore mirrors, standalone, what
that module's `_call_browser_route` + `_cdp_url_from_status` do:

    POST {GATEWAY_INTERNAL_URL}/workspaces/{INTEGRATIONS_WORKSPACE_ID}/browser/{agent_id}/start
    Authorization: Bearer <contents of INTEGRATIONS_TOKEN_PATH>

reading the SAME three env vars the wrapper's `config.py` resolvers read
(`resolve_gateway_internal_url`, `resolve_integrations_workspace_id`,
`resolve_integrations_token_path`; token path default
`/run/hermes/integrations.token`), and adding `cdp_url:
http://127.0.0.1:<port>` when the gateway's JSON carries a
`cdp_port`/`port`/`cdpPort` key (loopback on purpose — the browser daemon is
a sibling process in this same container; see `_cdp_url_from_status`'s doc
comment in the wrapper module for the full reasoning).

Uses `urllib.request` (stdlib), not `httpx`: `httpx` is a wrapper
dependency, not a `seeder_kit` one (`backend/seeder_kit/pyproject.toml`
declares zero required dependencies), and this subprocess runs under
whatever `python3` the host's MCP launcher resolves — `update_soul.py`
avoids `httpx` for exactly this reason.

That request body now lives in the sibling helper `_browser_gateway.py`
(`start_browser_session` / `as_text_content`), shared with
`browser_task.py` so there is one gateway call site, not two. The JSON this
tool returns is unchanged by that move — see `_browser_gateway.py`'s
"Result shape" for how the historical `_error` vs. gateway-payload
serialisation is preserved exactly.

Sibling import
--------------
`seeder_kit.discovery._load_module_from_path` loads each tool file with
`importlib.util.spec_from_file_location` under a synthetic module name and
does NOT put this directory on `sys.path`, so a plain
`from _browser_gateway import ...` would fail. `_import_sibling` loads the
helper by absolute path next to this file (cwd-independent) and caches it
in `sys.modules` under a path-derived key so every tool module in this
directory shares one helper module object.

Errors are returned as a `{"error": ...}` JSON text payload (never raised),
matching `update_soul.py`'s return shape.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

TOOL_NAME = "open_browser"
TOOL_DESCRIPTION = (
    "Start (or confirm already running) THIS agent's own dedicated browser instance "
    "and report where to reach it. Takes no arguments — the agent identity comes from "
    "this tool server's own launch, never from the caller. On success the result "
    "includes cdp_url (a loopback http://127.0.0.1:<port> address reachable from this "
    "same container); point your browser-automation/CDP client at exactly that URL."
)
TOOL_INPUT_SCHEMA = {"type": "object", "properties": {}}


def _import_sibling(stem: str):
    """Load `<this directory>/<stem>.py` regardless of cwd or `sys.path`
    (see module docstring, "Sibling import")."""
    path = Path(__file__).resolve().with_name(f"{stem}.py")
    key = "_seeder_tool_sibling_" + re.sub(r"\W", "_", str(path))
    cached = sys.modules.get(key)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(key, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load sibling helper {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


def _error(message: str) -> list[dict]:
    return [{"type": "text", "text": json.dumps({"error": message})}]


async def handle(arguments: dict) -> list[dict]:
    agent_id = arguments.get("_agent_id")
    if not agent_id:
        return _error(
            "agent identity required but not provided: this tool only works when its "
            "MCP server process was launched with --agent-id (seeder_kit.runner), so "
            "the browser it opens is provably this agent's own. Refusing to guess."
        )

    gateway = _import_sibling("_browser_gateway")
    return gateway.as_text_content(gateway.start_browser_session(str(agent_id)))
