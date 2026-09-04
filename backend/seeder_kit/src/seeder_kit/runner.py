"""The generic stdio MCP server: exposes every tool module found across one
or more `--tools-dir` directories as an MCP tool. Requires the optional
`mcp` extra (`pip install "seeder-kit[mcp]"`).

This exists because an MCP-compatible agent's config can only launch whole
MCP server *processes* (a `command`/`args`/`env` stdio launcher, or a
`url` for HTTP MCP) — never a bare Python file as an individual tool. This
runner is the aggregator: point it at one or more directories of tool
modules (see `discovery.py`'s module docstring for the per-file contract)
and it serves the union of all of them over stdio.

Usage:

    pip install "seeder-kit[mcp]"
    hermes-seeder-runner --tools-dir /path/to/tools --tools-dir /path/to/more-tools

or, without installing the console script:

    python3 -m seeder_kit.runner --tools-dir /path/to/tools

Optional `--agent-id <id>`: the identity of the ONE agent this process
serves. A host that launches one runner subprocess per agent (the
`mcp_servers.<name>: {command, args}` stdio shape — see `mcp_config.py`)
knows the agent at spawn time, so this is real process-level identity, not
something an MCP client asserts. `call_tool` strips any caller-supplied
`"_agent_id"` from the `tools/call` arguments and, when `--agent-id` was
given, injects the launched value under that same key (see `discovery.py`'s
module docstring, "Runner-injected `arguments` key"). Without `--agent-id`
the key is left absent — fully backward compatible for the generic
tool-discovery use.

All tool discovery/validation logic lives in `discovery.py`, which has no
`mcp` import, so it stays usable (e.g. for a dry-run validation before
writing a tool tree into an agent's config) without this optional
dependency.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from seeder_kit.discovery import discover_tools_in_dirs


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tools-dir",
        action="append",
        required=True,
        type=Path,
        help="Directory to scan for tool modules. Repeatable; order does "
        "not grant priority — a duplicate tool name across any two "
        "directories always fails loud.",
    )
    parser.add_argument(
        "--server-name",
        default="seeder-kit",
        help="MCP server name reported at initialization (default: seeder-kit).",
    )
    parser.add_argument(
        "--agent-id",
        default=None,
        help="Identity of the one agent this server process serves. When "
        "given, injected into every tool call's arguments as "
        "'_agent_id' (any caller-supplied value is stripped first). "
        "Optional: omit for a generic, agent-agnostic runner.",
    )
    return parser.parse_args(argv)


AGENT_ID_ARGUMENT_KEY = "_agent_id"
"""The reserved `arguments` key the runner owns — see `discovery.py`'s
module docstring ("Runner-injected `arguments` key")."""


def inject_agent_id(arguments: dict, agent_id: str | None) -> dict:
    """Strip any caller-supplied `_agent_id`, then set the runner's own
    value if it has one. Mutates and returns `arguments`.

    Order matters and is deliberate: the caller's value is removed
    UNCONDITIONALLY (even when this runner has no `agent_id` of its own),
    so a client can never smuggle an identity into a tool module through
    the `tools/call` payload — the only way the key is ever present is
    when this process was launched with `--agent-id`. Mirrors
    `rust_gateway/src/integrations/mcp_proxy.rs`'s `connectionName`
    handling (remove every caller alias, then insert the server-owned
    value). Kept as a small standalone function so it is testable without
    the `mcp` package or a stdio transport.
    """
    arguments.pop(AGENT_ID_ARGUMENT_KEY, None)
    if agent_id is not None:
        arguments[AGENT_ID_ARGUMENT_KEY] = agent_id
    return arguments


def build_call_tool_handler(handlers: dict, agent_id: str | None = None):
    """The body of `build_server`'s `call_tool`, minus the `mcp` SDK
    `TextContent` conversion — returns the tool module's own plain
    `list[dict]`. Factored out so the injection contract can be tested
    end-to-end (real discovered tool module, real `handle`) without the
    optional `mcp` dependency; `build_server` wraps this and only adds the
    SDK-object conversion."""

    async def call_tool(name: str, arguments: dict) -> list[dict]:
        handler = handlers.get(name)
        if handler is None:
            return [{"type": "text", "text": f'{{"error": "Unknown tool: {name}"}}'}]
        arguments = inject_agent_id(dict(arguments or {}), agent_id)
        return await handler(arguments)

    return call_tool


def build_server(tool_dirs: list[Path], server_name: str, agent_id: str | None = None):
    """Build a ready-to-run `mcp.server.Server`. Imports `mcp` lazily so
    this module remains importable (for `_parse_args`/wiring tests) without
    the optional dependency installed."""
    from mcp.server import Server
    from mcp.types import TextContent, Tool

    discovered = discover_tools_in_dirs(tool_dirs)

    tools = [
        Tool(name=t.name, description=t.description, inputSchema=t.input_schema)
        for t in discovered
    ]
    handlers = {t.name: t.handle for t in discovered}
    plain_call_tool = build_call_tool_handler(handlers, agent_id)

    server = Server(server_name)

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return tools

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        raw_results = await plain_call_tool(name, arguments)
        return [TextContent(**item) for item in raw_results]

    return server


async def _serve(tool_dirs: list[Path], server_name: str, agent_id: str | None = None) -> None:
    from mcp.server.stdio import stdio_server

    server = build_server(tool_dirs, server_name, agent_id=agent_id)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


def cli_main(argv: list[str] | None = None) -> None:
    import asyncio

    args = _parse_args(argv)
    asyncio.run(_serve(args.tools_dir, args.server_name, agent_id=args.agent_id))


if __name__ == "__main__":
    cli_main()
