"""seeder-kit — declare MCP tools, skills, and agent identity content as a
folder tree; discover and run tools from it as a stdio MCP server.

Public API:

    from seeder_kit import parse_tree, available_modes, SeederTree, AgentSpec
    from seeder_kit import discover_tools_in_dirs, DiscoveredTool, ToolDiscoveryError
    from seeder_kit import copy_skill_dirs
    from seeder_kit import build_mcp_server_entry

See each module's own docstring for details:

- `tree.py`      — pure parser for the on-disk seeder-tree layout
- `discovery.py` — pure-stdlib MCP tool module discovery/validation
- `skills.py`    — skill-folder copy mechanics
- `mcp_config.py`— build an `mcp_servers:` config entry pointing at `runner.py`
- `runner.py`    — the actual stdio MCP server (needs the `mcp` extra)

This package is intentionally host-agnostic: it has no knowledge of Hermes
WebUI, profiles, or any other specific application. Host-specific
integration (e.g. "apply this tree to Hermes profiles") lives in that
host's own codebase — see
`backend/wrapper/src/hermes_webui_wrapper/features/agent_seeder/` for the
Hermes WebUI wrapper's integration on top of this library.
"""
from __future__ import annotations

from seeder_kit.discovery import DiscoveredTool, ToolDiscoveryError, discover_tools_in_dirs
from seeder_kit.mcp_config import build_mcp_server_entry
from seeder_kit.skills import copy_skill_dirs
from seeder_kit.tree import AgentSpec, SeederTree, available_modes, parse_tree, slugify

__all__ = [
    "AgentSpec",
    "DiscoveredTool",
    "SeederTree",
    "ToolDiscoveryError",
    "available_modes",
    "build_mcp_server_entry",
    "copy_skill_dirs",
    "discover_tools_in_dirs",
    "parse_tree",
    "slugify",
]
