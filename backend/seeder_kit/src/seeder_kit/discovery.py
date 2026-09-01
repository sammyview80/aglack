"""Pure-stdlib discovery of MCP tool modules from one or more directories.

Zero dependency on the `mcp` package — this is what lets `discover_tools_in_dirs`
be called from a host application's own process (e.g. to validate a tool
tree before writing it into an agent's config) without requiring that
process to install the optional `mcp` dependency. Only `runner.py` (the
actual stdio MCP server) needs `mcp` installed.

Tool module contract — a `.py` file under a discovered directory must
define:

    TOOL_NAME: str
    TOOL_DESCRIPTION: str
    TOOL_INPUT_SCHEMA: dict          # JSON Schema object, e.g. {"type": "object", ...}
    async def handle(arguments: dict) -> list[dict]

`handle` returns plain dicts shaped like MCP `TextContent`
(`{"type": "text", "text": "..."}`) rather than SDK objects, for the same
reason this module has no `mcp` import — the SDK boundary conversion
happens once, in `runner.py`.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, Awaitable, Callable, NamedTuple

Handler = Callable[[dict], Awaitable[list[dict]]]

_REQUIRED_ATTRS = ("TOOL_NAME", "TOOL_DESCRIPTION", "TOOL_INPUT_SCHEMA", "handle")


class DiscoveredTool(NamedTuple):
    name: str
    description: str
    input_schema: dict[str, Any]
    handle: Handler
    source_dir: str
    """Which directory (as passed to `discover_tools_in_dirs`) this tool
    came from — used only for error messages, so a duplicate-name error can
    say which two directories collided."""


class ToolDiscoveryError(RuntimeError):
    """Raised for any malformed tool module or name collision. A plain
    `RuntimeError` subclass so existing `except RuntimeError` call sites
    keep working, while giving callers that want to catch specifically
    discovery failures (and not any other RuntimeError) a dedicated type."""


def _load_module_from_path(path: Path):
    """Import a single `.py` file as an isolated module object — never
    inserted into `sys.modules` under a shared name. Two different
    directories may each contain a same-named file (e.g. two independent
    `update_soul.py` for two different agents); they must not collide as
    Python module objects just because their basenames match."""
    spec = importlib.util.spec_from_file_location(f"_seeder_kit_tool_{path.stem}_{id(path)}", path)
    if spec is None or spec.loader is None:
        raise ToolDiscoveryError(f"could not load tool module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _validate_and_extract(module, path: Path) -> DiscoveredTool | None:
    values = {attr: getattr(module, attr, None) for attr in _REQUIRED_ATTRS}
    missing = [attr for attr, val in values.items() if val is None]
    if missing:
        raise ToolDiscoveryError(
            f"{path} is missing required attribute(s): {', '.join(missing)}"
        )
    if not callable(values["handle"]):
        raise ToolDiscoveryError(f"{path}'s handle must be callable")
    return DiscoveredTool(
        name=values["TOOL_NAME"],
        description=values["TOOL_DESCRIPTION"],
        input_schema=values["TOOL_INPUT_SCHEMA"],
        handle=values["handle"],
        source_dir="",  # filled in by discover_tools_in_dirs
    )


def discover_tools_in_dirs(tool_dirs: list[Path]) -> list[DiscoveredTool]:
    """Discover every tool module across `tool_dirs`, in the order given.

    Raises `ToolDiscoveryError` immediately on:
    - a tool name colliding across two directories, or two files in the
      same directory (never silently shadow one tool with another)
    - a module missing a required attribute, or a non-callable `handle`

    A directory in `tool_dirs` that does not exist is silently skipped —
    an optional per-agent `tools/` folder is a normal, valid case, not an
    error.
    """
    discovered: dict[str, DiscoveredTool] = {}

    for tool_dir in tool_dirs:
        if not tool_dir.is_dir():
            continue
        for py_file in sorted(tool_dir.glob("*.py")):
            if py_file.name.startswith("_"):
                continue
            module = _load_module_from_path(py_file)
            tool = _validate_and_extract(module, py_file)
            tool = tool._replace(source_dir=str(tool_dir))

            if tool.name in discovered:
                raise ToolDiscoveryError(
                    f"duplicate MCP tool name {tool.name!r}: declared by both "
                    f"{discovered[tool.name].source_dir} and {tool_dir}"
                )
            discovered[tool.name] = tool

    return list(discovered.values())
