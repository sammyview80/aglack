"""Builds the `mcp_servers:` config entry that points an MCP-config-driven
host at `seeder_kit.runner` for a given set of tool directories. Returns
plain data — writing it into any particular host's config file (format,
location, merge behavior with other keys) is that host's own concern, not
this library's.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

DEFAULT_PYTHON_ENV_VAR = "SEEDER_KIT_RUNNER_PYTHON"


def runner_entry_point() -> Path:
    """Path to `runner.py` inside this installed `seeder_kit` package —
    used as the `args[0]` for a host's stdio MCP server launcher when it
    invokes this runner by file path rather than via the
    `hermes-seeder-runner` console script."""
    return Path(__file__).resolve().parent / "runner.py"


def build_mcp_server_entry(
    tool_dirs: list[Path],
    *,
    server_name: str,
    python_executable: str | None = None,
    agent_id: str | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build one `mcp_servers.<name>` entry value:
    `{"command": ..., "args": [...]}` (plus `"env": {...}` when `env` is
    given and non-empty).

    `python_executable` defaults to the `SEEDER_KIT_RUNNER_PYTHON`
    environment variable, falling back to plain `"python3"` resolved via
    `PATH` at the time the HOST (not this library's own process) actually
    launches the command — deliberately never `sys.executable` of the
    process building this entry, which has no reason to be the correct
    interpreter for wherever the host's own MCP-server launcher runs.

    `agent_id`, when given, appends `--agent-id <agent_id>` so the
    launched `runner.py` knows which ONE agent it serves (see that
    module's docstring). A host building one entry per agent has this
    identity at hand; passing it here is what turns the stdio runner into
    a real per-agent identity boundary. When omitted, `args` is exactly
    what it was before this parameter existed.

    `env`, when given and non-empty, is emitted verbatim under the entry's
    `env` key — i.e. the host's `mcp_servers.<name>.env` config key. This
    exists because a host's real stdio MCP subprocess launcher does NOT
    inherit arbitrary parent-process environment variables (for security
    it only passes a small allowlist plus whatever that config key names
    explicitly), so any value the launched runner genuinely needs at
    runtime (e.g. how to reach a gateway, which workspace it belongs to,
    where its profile home lives) must be spelled out here by the host.
    Only pass values the host explicitly chooses to expose — never
    secrets. When `env` is `None` or empty, no `env` key is emitted at
    all, so existing callers' output is byte-identical to before this
    parameter existed.
    """
    resolved_python = python_executable or os.environ.get(DEFAULT_PYTHON_ENV_VAR, "python3")

    args: list[str] = [str(runner_entry_point()), "--server-name", server_name]
    for tool_dir in tool_dirs:
        args.extend(["--tools-dir", str(tool_dir)])
    if agent_id is not None:
        args.extend(["--agent-id", agent_id])

    entry: dict[str, Any] = {"command": resolved_python, "args": args}
    if env:
        entry["env"] = dict(env)
    return entry
