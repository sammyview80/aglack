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
    return parser.parse_args(argv)


def build_server(tool_dirs: list[Path], server_name: str):
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

    server = Server(server_name)

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return tools

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        handler = handlers.get(name)
        if handler is None:
            return [TextContent(type="text", text=f'{{"error": "Unknown tool: {name}"}}')]
        raw_results = await handler(arguments)
        return [TextContent(**item) for item in raw_results]

    return server


async def _serve(tool_dirs: list[Path], server_name: str) -> None:
    from mcp.server.stdio import stdio_server

    server = build_server(tool_dirs, server_name)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


def cli_main(argv: list[str] | None = None) -> None:
    import asyncio

    args = _parse_args(argv)
    asyncio.run(_serve(args.tools_dir, args.server_name))


if __name__ == "__main__":
    cli_main()
