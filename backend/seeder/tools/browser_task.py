"""browser_task — global MCP tool: run a natural-language browsing task in
the CALLING agent's own dedicated browser, driven by that agent's OWN
configured model, via `browser_use`.

Identity comes from the runner, never the caller — same contract as
`open_browser.py`/`close_browser.py` (this directory): the agent id is read
from `arguments["_agent_id"]`, injected by `seeder_kit.runner` from its own
`--agent-id` launch argument (see `seeder_kit/discovery.py`'s
"Runner-injected `arguments` key"). Absent key -> refuse, never guess.
`task` is the ONE legitimately caller-supplied argument.

What one call does
------------------
1. `_browser_gateway.start_browser_session(agent_id)` — the same gateway
   `start` call `open_browser` makes (idempotent on the gateway side: an
   already-running browser is confirmed, not duplicated) to get this
   agent's loopback `cdp_url`.
2. `_browser_use_llm.resolve_browser_use_llm(agent_id)` — a `browser_use`
   LLM wrapper for this agent's own `config.yaml` provider/model and the
   credential already in this process's environment (see that module's
   docstring for the deliberate "no .env loading" scope boundary).
3. `browser_use.Agent(task=..., llm=..., browser_session=
   browser_use.BrowserSession(cdp_url=...))` and `await agent.run()`
   (`Agent.run` is a real coroutine function in browser-use 0.13 — awaited
   directly, no thread hop).
4. Returns `history.final_result()` plus, when `history.has_errors()`,
   `history.errors()` too — a task can partially succeed with recorded
   errors along the way, so both are reported, not one or the other.

Failure handling
----------------
Nothing escapes `handle` as an exception. Gateway failures reuse
`open_browser`'s exact error payloads (shared code, same wording). LLM
resolution failures return `BrowserUseLLMResolutionError`'s message, which
is already redaction-safe by construction. Any exception out of
`browser_use` itself (CDP connection, navigation, mid-task LLM call — not
enumerable in advance) is returned as `{"error": ...}` with `str(exc)`
truncated to 500 characters. Belt and suspenders: an invalid/rejected
credential could in principle be echoed back by a provider SDK's own
exception text, so that truncated text is additionally scanned for the
resolved LLM's literal `api_key` value and redacted if present.

Both sibling helpers are loaded via `_import_sibling` (same mechanism and
reasoning as `open_browser.py`'s "Sibling import"); `browser_use` is
imported lazily inside `handle`, matching every other lazy-import
convention in this tree.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

TOOL_NAME = "browser_task"
TOOL_DESCRIPTION = (
    "Run a natural-language browsing task (navigate, read, click, fill forms, extract "
    "information) in THIS agent's own dedicated browser, using this agent's own configured "
    "model to drive it. Starts the browser if it is not already running. The agent identity "
    "comes from this tool server's own launch, never from the caller. Returns the task's "
    "final result text, plus any errors recorded along the way."
)
TOOL_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "task": {
            "type": "string",
            "description": (
                "What to accomplish in the browser, in plain language — e.g. "
                "'Open example.com and return the page title'. Be specific about "
                "what result text you want back."
            ),
        }
    },
    "required": ["task"],
}

_MAX_ERROR_CHARS = 500
_REDACTED = "[redacted]"


def _import_sibling(stem: str):
    """Load `<this directory>/<stem>.py` regardless of cwd or `sys.path`
    (see `open_browser.py`'s module docstring, "Sibling import")."""
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


def _safe_exception_text(exc: BaseException, secret: str | None) -> str:
    text = str(exc)[:_MAX_ERROR_CHARS]
    if secret and secret in text:
        text = text.replace(secret, _REDACTED)
    return text


async def handle(arguments: dict) -> list[dict]:
    agent_id = arguments.get("_agent_id")
    if not agent_id:
        return _error(
            "agent identity required but not provided: this tool only works when its "
            "MCP server process was launched with --agent-id (seeder_kit.runner), so "
            "the browser it drives is provably this agent's own. Refusing to guess."
        )

    task = str(arguments.get("task") or "").strip()
    if not task:
        return _error("task is required: describe what to do in the browser")

    gateway = _import_sibling("_browser_gateway")
    started = gateway.start_browser_session(str(agent_id))
    if started.cdp_url is None:
        if isinstance(started.payload, dict) and "error" in started.payload:
            return gateway.as_text_content(started)
        return _error(
            "gateway started the browser but its response carried no cdp_port/port/cdpPort, "
            "so there is no CDP endpoint to drive"
        )

    llm_module = _import_sibling("_browser_use_llm")
    try:
        llm = llm_module.resolve_browser_use_llm(str(agent_id))
    except llm_module.BrowserUseLLMResolutionError as exc:
        return _error(f"could not resolve this agent's model for browser-use: {exc}")

    secret = getattr(llm, "api_key", None)
    if not isinstance(secret, str) or not secret:
        secret = None

    try:
        import browser_use

        agent = browser_use.Agent(
            task=task,
            llm=llm,
            browser_session=browser_use.BrowserSession(cdp_url=started.cdp_url),
        )
        history = await agent.run()
    except Exception as exc:
        return _error(f"browser task failed: {_safe_exception_text(exc, secret)}")

    result: dict = {
        "task": task,
        "cdp_url": started.cdp_url,
        "final_result": history.final_result(),
    }
    if history.has_errors():
        result["errors"] = [e for e in history.errors() if e]
    return [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]
