"""Tests for the parts of `runner.py` that don't require the optional
`mcp` package — argument parsing, and the `call_tool` body
(`build_call_tool_handler`, which `build_server` wraps with only the SDK
`TextContent` conversion). `build_server`/`cli_main` import `mcp` lazily
inside their own bodies specifically so this module stays importable and
testable without that dependency installed; a real end-to-end stdio
server test belongs in an environment with `seeder-kit[mcp]` installed,
not this base test run.
"""
from __future__ import annotations

import asyncio
import json
import textwrap
from pathlib import Path

import pytest

from seeder_kit.discovery import discover_tools_in_dirs
from seeder_kit.runner import _parse_args, build_call_tool_handler, inject_agent_id


def test_single_tools_dir() -> None:
    args = _parse_args(["--tools-dir", "/a"])

    assert args.tools_dir == [Path("/a")]
    assert args.server_name == "seeder-kit"


def test_multiple_tools_dirs_accumulate() -> None:
    args = _parse_args(["--tools-dir", "/a", "--tools-dir", "/b"])

    assert args.tools_dir == [Path("/a"), Path("/b")]


def test_custom_server_name() -> None:
    args = _parse_args(["--tools-dir", "/a", "--server-name", "custom"])

    assert args.server_name == "custom"


def test_missing_tools_dir_errors() -> None:
    with pytest.raises(SystemExit):
        _parse_args([])


def test_agent_id_is_optional_and_defaults_to_none() -> None:
    args = _parse_args(["--tools-dir", "/a"])

    assert args.agent_id is None


def test_agent_id_parses() -> None:
    args = _parse_args(["--tools-dir", "/a", "--agent-id", "pm"])

    assert args.agent_id == "pm"


# --- `_agent_id` injection through the real call_tool body ---


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _write_echo_tool(path: Path) -> None:
    """A real tool module whose `handle` reports back the exact
    `arguments` dict it received, so a test can see what the runner
    actually passed through."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        textwrap.dedent(
            '''
            import json

            TOOL_NAME = "echo_args"
            TOOL_DESCRIPTION = "echo"
            TOOL_INPUT_SCHEMA = {"type": "object", "properties": {}}

            async def handle(arguments):
                return [{"type": "text", "text": json.dumps(arguments)}]
            '''
        ),
        encoding="utf-8",
    )


def _call_tool_for(tmp_path: Path, agent_id: str | None):
    tools_dir = tmp_path / "tools"
    _write_echo_tool(tools_dir / "echo_args.py")
    handlers = {t.name: t.handle for t in discover_tools_in_dirs([tools_dir])}
    return build_call_tool_handler(handlers, agent_id)


def _received_arguments(result: list[dict]) -> dict:
    return json.loads(result[0]["text"])


def test_inject_agent_id_sets_key_when_runner_has_identity() -> None:
    assert inject_agent_id({"x": 1}, "pm") == {"x": 1, "_agent_id": "pm"}


def test_inject_agent_id_leaves_key_absent_when_runner_has_none() -> None:
    arguments = inject_agent_id({"x": 1}, None)

    assert arguments == {"x": 1}
    assert "_agent_id" not in arguments


def test_handle_receives_injected_agent_id_end_to_end(tmp_path: Path) -> None:
    """A real discovered tool module's `handle` sees the runner's own
    `--agent-id` value under `_agent_id`, via the same call_tool body
    `build_server` serves over stdio."""
    call_tool = _call_tool_for(tmp_path, agent_id="pm")

    received = _received_arguments(_run(call_tool("echo_args", {"foo": "bar"})))

    assert received == {"foo": "bar", "_agent_id": "pm"}


def test_handle_sees_no_agent_id_key_when_runner_launched_without_one(tmp_path: Path) -> None:
    """Backward compat: an old runner invocation (no `--agent-id`) leaves
    the key ABSENT — not `None`, not `""` — so `arguments.get("_agent_id")`
    is `None` for a tool module that never heard of the key."""
    call_tool = _call_tool_for(tmp_path, agent_id=None)

    received = _received_arguments(_run(call_tool("echo_args", {"foo": "bar"})))

    assert received == {"foo": "bar"}
    assert "_agent_id" not in received


def test_caller_supplied_agent_id_is_stripped_and_overwritten(tmp_path: Path) -> None:
    """Adversarial: an MCP client claiming to be agent X in the `tools/call`
    arguments must NEVER win over the identity this runner process was
    actually launched with (same framing as the gateway's
    `strips_client_supplied_connection_name_and_alias` test in
    `rust_gateway/src/integrations/mcp_proxy.rs`)."""
    call_tool = _call_tool_for(tmp_path, agent_id="the-real-launched-agent")

    received = _received_arguments(
        _run(call_tool("echo_args", {"_agent_id": "some-other-agent", "foo": "bar"}))
    )

    assert received["_agent_id"] == "the-real-launched-agent"
    assert received == {"foo": "bar", "_agent_id": "the-real-launched-agent"}


def test_caller_supplied_agent_id_is_stripped_even_when_runner_has_none(tmp_path: Path) -> None:
    """A runner with NO identity of its own still refuses to pass a
    caller's fake one through — the key is removed, not forwarded."""
    call_tool = _call_tool_for(tmp_path, agent_id=None)

    received = _received_arguments(
        _run(call_tool("echo_args", {"_agent_id": "some-other-agent", "foo": "bar"}))
    )

    assert received == {"foo": "bar"}
    assert "_agent_id" not in received


def test_unknown_tool_returns_error_payload(tmp_path: Path) -> None:
    call_tool = _call_tool_for(tmp_path, agent_id="pm")

    result = _run(call_tool("nope", {}))

    assert result == [{"type": "text", "text": '{"error": "Unknown tool: nope"}'}]
