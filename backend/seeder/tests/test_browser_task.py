"""Unit tests for `tools/browser_task.py::handle` and the `open_browser.py`
refactor onto the shared `_browser_gateway.py` helper.

No real gateway, browser, LLM, or `browser_use` Agent is involved: the
shared gateway helper and the LLM resolver are monkeypatched on the cached
sibling module objects `_import_sibling` returns, and `browser_use` is
replaced by a stub module whose `Agent.run` is an async function returning
a fake history.
"""
from __future__ import annotations

import asyncio
import json
import sys
import types

import pytest


def _text(result: list[dict]) -> dict:
    assert len(result) == 1 and result[0]["type"] == "text"
    return json.loads(result[0]["text"])


@pytest.fixture
def browser_task(load_tool):
    return load_tool("browser_task")


@pytest.fixture
def open_browser(load_tool):
    return load_tool("open_browser")


def test_tool_contract(browser_task):
    assert browser_task.TOOL_NAME == "browser_task"
    assert browser_task.TOOL_INPUT_SCHEMA["required"] == ["task"]
    assert "task" in browser_task.TOOL_INPUT_SCHEMA["properties"]


def test_sibling_import_resolves_helpers_without_sys_path(browser_task, open_browser):
    """The production loader gives each tool a synthetic module name and
    never adds tools/ to sys.path — `_import_sibling` must still find both
    helpers, and both tool modules must share ONE cached gateway module."""
    gw_a = browser_task._import_sibling("_browser_gateway")
    gw_b = open_browser._import_sibling("_browser_gateway")
    assert gw_a is gw_b
    assert callable(gw_a.start_browser_session)
    llm_mod = browser_task._import_sibling("_browser_use_llm")
    assert callable(llm_mod.resolve_browser_use_llm)


def test_missing_agent_id_refuses_with_established_wording(browser_task):
    out = _text(asyncio.run(browser_task.handle({"task": "x"})))
    assert out["error"].startswith("agent identity required but not provided")
    assert out["error"].endswith("Refusing to guess.")
    assert "--agent-id" in out["error"]


@pytest.mark.parametrize("args", [{}, {"task": ""}, {"task": "   "}, {"task": None}])
def test_missing_or_empty_task_is_its_own_error(browser_task, args):
    out = _text(asyncio.run(browser_task.handle({"_agent_id": "pm", **args})))
    assert out["error"].startswith("task is required")
    assert "agent identity" not in out["error"]


def test_gateway_failure_is_returned_with_open_browser_wording(browser_task, monkeypatch):
    gw = browser_task._import_sibling("_browser_gateway")
    monkeypatch.setattr(
        gw,
        "start_browser_session",
        lambda agent_id: gw.BrowserStartResult(
            None, {"error": "browser gateway not configured: GATEWAY_INTERNAL_URL is not set"}, True
        ),
    )
    out = _text(asyncio.run(browser_task.handle({"_agent_id": "pm", "task": "go"})))
    assert out["error"].startswith("browser gateway not configured")


def test_gateway_success_without_cdp_port_is_an_error(browser_task, monkeypatch):
    gw = browser_task._import_sibling("_browser_gateway")
    monkeypatch.setattr(
        gw, "start_browser_session", lambda agent_id: gw.BrowserStartResult(None, {"status": "running"}, False)
    )
    out = _text(asyncio.run(browser_task.handle({"_agent_id": "pm", "task": "go"})))
    assert "no cdp_port" in out["error"]


def test_llm_resolution_error_is_returned_not_raised(browser_task, monkeypatch):
    gw = browser_task._import_sibling("_browser_gateway")
    monkeypatch.setattr(
        gw,
        "start_browser_session",
        lambda agent_id: gw.BrowserStartResult("http://127.0.0.1:9222", {"cdp_url": "http://127.0.0.1:9222"}, False),
    )
    llm_mod = browser_task._import_sibling("_browser_use_llm")

    def failing(agent_id):
        raise llm_mod.BrowserUseLLMResolutionError("unsupported api_mode 'bedrock_converse'")

    monkeypatch.setattr(llm_mod, "resolve_browser_use_llm", failing)
    out = _text(asyncio.run(browser_task.handle({"_agent_id": "pm", "task": "go"})))
    assert "could not resolve this agent's model" in out["error"]
    assert "bedrock_converse" in out["error"]


def _install_fake_browser_use(monkeypatch, *, final="Title: Example", errors=None, run_raises=None):
    class FakeHistory:
        def final_result(self):
            return final

        def has_errors(self):
            return bool(errors)

        def errors(self):
            return list(errors or [])

    captured = {}

    class FakeBrowserSession:
        def __init__(self, cdp_url=None, **kwargs):
            captured["cdp_url"] = cdp_url

    class FakeAgent:
        def __init__(self, task, llm, browser_session, **kwargs):
            captured["task"] = task
            captured["llm"] = llm
            captured["browser_session"] = browser_session

        async def run(self, max_steps=500):
            if run_raises is not None:
                raise run_raises
            return FakeHistory()

    fake = types.ModuleType("browser_use")
    fake.Agent = FakeAgent
    fake.BrowserSession = FakeBrowserSession
    monkeypatch.setitem(sys.modules, "browser_use", fake)
    return captured


class _StubLLM:
    api_key = "sk-TOTALLY-FAKE-SECRET-VALUE-12345"


def _wire_success(browser_task, monkeypatch):
    gw = browser_task._import_sibling("_browser_gateway")
    monkeypatch.setattr(
        gw,
        "start_browser_session",
        lambda agent_id: gw.BrowserStartResult("http://127.0.0.1:9222", {"cdp_url": "http://127.0.0.1:9222"}, False),
    )
    llm_mod = browser_task._import_sibling("_browser_use_llm")
    monkeypatch.setattr(llm_mod, "resolve_browser_use_llm", lambda agent_id: _StubLLM())


def test_success_path_returns_final_result(browser_task, monkeypatch):
    _wire_success(browser_task, monkeypatch)
    captured = _install_fake_browser_use(monkeypatch, final="Title: Example")
    out = _text(asyncio.run(browser_task.handle({"_agent_id": "pm", "task": "  get the title "})))
    assert out["final_result"] == "Title: Example"
    assert out["cdp_url"] == "http://127.0.0.1:9222"
    assert "errors" not in out
    assert captured["task"] == "get the title"
    assert captured["cdp_url"] == "http://127.0.0.1:9222"
    assert isinstance(captured["llm"], _StubLLM)


def test_success_with_recorded_errors_reports_both(browser_task, monkeypatch):
    _wire_success(browser_task, monkeypatch)
    _install_fake_browser_use(monkeypatch, final="partial", errors=["step 2 timed out", None])
    out = _text(asyncio.run(browser_task.handle({"_agent_id": "pm", "task": "go"})))
    assert out["final_result"] == "partial"
    assert out["errors"] == ["step 2 timed out"]


def test_browser_use_exception_is_returned_truncated_and_redacted(browser_task, monkeypatch):
    _wire_success(browser_task, monkeypatch)
    long_msg = "CDP connect failed " + ("x" * 1000) + " key=" + _StubLLM.api_key
    _install_fake_browser_use(monkeypatch, run_raises=RuntimeError(_StubLLM.api_key + " rejected: " + long_msg))
    out = _text(asyncio.run(browser_task.handle({"_agent_id": "pm", "task": "go"})))
    assert out["error"].startswith("browser task failed: ")
    assert _StubLLM.api_key not in out["error"]
    assert "[redacted]" in out["error"]
    assert len(out["error"]) <= len("browser task failed: ") + 500 + len("[redacted]")


# --- open_browser.py refactor: behaviour unchanged ---------------------------


def test_open_browser_missing_agent_id_wording_unchanged(open_browser):
    out = _text(asyncio.run(open_browser.handle({})))
    assert out["error"] == (
        "agent identity required but not provided: this tool only works when its "
        "MCP server process was launched with --agent-id (seeder_kit.runner), so "
        "the browser it opens is provably this agent's own. Refusing to guess."
    )


def test_open_browser_not_configured_serialises_exactly_as_before(open_browser, monkeypatch):
    monkeypatch.delenv("GATEWAY_INTERNAL_URL", raising=False)
    result = asyncio.run(open_browser.handle({"_agent_id": "pm"}))
    expected = json.dumps(
        {"error": "browser gateway not configured: GATEWAY_INTERNAL_URL is not set — cannot reach the gateway's browser route"}
    )
    assert result == [{"type": "text", "text": expected}]  # default ensure_ascii, em-dash escaped


def test_open_browser_success_adds_cdp_url_with_ensure_ascii_false(open_browser, monkeypatch):
    gw = open_browser._import_sibling("_browser_gateway")
    monkeypatch.setattr(
        gw,
        "start_browser_session",
        lambda agent_id: gw.BrowserStartResult(
            "http://127.0.0.1:9222", {"status": "running — ok", "cdp_port": 9222, "cdp_url": "http://127.0.0.1:9222"}, False
        ),
    )
    result = asyncio.run(open_browser.handle({"_agent_id": "pm"}))
    assert result == [
        {
            "type": "text",
            "text": json.dumps(
                {"status": "running — ok", "cdp_port": 9222, "cdp_url": "http://127.0.0.1:9222"}, ensure_ascii=False
            ),
        }
    ]


def test_gateway_helper_cdp_url_extraction_and_result_shape(open_browser):
    gw = open_browser._import_sibling("_browser_gateway")
    assert gw._cdp_url_from_status({"cdp_port": 9222}) == "http://127.0.0.1:9222"
    assert gw._cdp_url_from_status({"port": 1}) == "http://127.0.0.1:1"
    assert gw._cdp_url_from_status({"cdpPort": 2}) == "http://127.0.0.1:2"
    assert gw._cdp_url_from_status({}) is None
    assert gw.as_text_content(gw.BrowserStartResult(None, {"error": "x — y"}, True)) == [
        {"type": "text", "text": json.dumps({"error": "x — y"})}
    ]
