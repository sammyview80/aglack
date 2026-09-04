# seeder-kit

A small, framework-agnostic Python library for declaring MCP tools,
skills, and agent-identity content as a plain folder tree, then:

- **parsing** that tree into typed data (`tree.py`)
- **discovering** MCP tools from one or more directories, safely and with
  loud failure on mistakes (`discovery.py`)
- **copying** skill folders (`skills.py`)
- **running** the discovered tools as a real stdio MCP server
  (`runner.py`)
- **building** the `mcp_servers:` config entry an MCP-config-driven host
  needs to launch that server (`mcp_config.py`)

It has **zero knowledge of any specific host application** — no Hermes
WebUI imports, no assumptions about profiles or config files beyond the
one small, explicit `mcp_config.build_mcp_server_entry` helper. A host
integrates this library by writing its own thin glue layer; see
[`../wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py`](../wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py)
for the Hermes WebUI wrapper's integration on top of it, and
[`../seeder/README.md`](../seeder/README.md) for the actual content tree
that integration applies by default.

## Why this exists

Most MCP-compatible agent runtimes can only launch whole **server
processes** as tool sources (a `command`/`args`/`env` stdio launcher, or a
`url` for HTTP MCP) — never a single Python file as an individual tool.
`runner.py` is the missing piece: point it at one or more directories of
tool modules and it aggregates all of them into one MCP server process.

## Install

```bash
pip install seeder-kit              # tree.py / discovery.py / skills.py / mcp_config.py only
pip install "seeder-kit[mcp]"       # + runner.py's actual server (needs the `mcp` package)
```

This repo installs it from the sibling path (`pip install -e ../seeder_kit`
or the `file://../seeder_kit` dependency in a consuming `pyproject.toml`)
rather than from PyPI.

## Quick tour

### 1. Declare a tool

```python
# my_tools/say_hello.py
TOOL_NAME = "say_hello"
TOOL_DESCRIPTION = "Say hello to someone."
TOOL_INPUT_SCHEMA = {
    "type": "object",
    "properties": {"name": {"type": "string"}},
    "required": ["name"],
}

async def handle(arguments: dict) -> list[dict]:
    return [{"type": "text", "text": f"Hello, {arguments['name']}!"}]
```

### 2. Discover it

```python
from pathlib import Path
from seeder_kit import discover_tools_in_dirs

tools = discover_tools_in_dirs([Path("my_tools")])
# [DiscoveredTool(name="say_hello", description="...", input_schema={...}, handle=<coroutine fn>, source_dir="my_tools")]
```

A tool name colliding across two directories (or two files in one
directory) raises `seeder_kit.ToolDiscoveryError` immediately — this
library never silently shadows one tool with another.

### 3. Serve it as a real MCP server

```bash
pip install "seeder-kit[mcp]"
hermes-seeder-runner --tools-dir my_tools
# one process per agent? give it that agent's identity — injected into every
# tool call as arguments["_agent_id"] (caller-supplied values are stripped):
hermes-seeder-runner --tools-dir my_tools --agent-id pm
```

`--agent-id` is optional; see `discovery.py`'s module docstring ("Runner-injected
`arguments` key") for the contract, and `build_mcp_server_entry(..., agent_id=...)`
to emit it from a host's config.

### 4. Or describe a whole agent tree, scoped by mode, and let a host apply it

```
my_seed/
  tools/*.py                       global tools every agent, in EVERY mode, gets
  skills/<name>/SKILL.md           global skills every agent, in EVERY mode, gets
  modes/<mode-name>/agents/<AgentName>/
    soul.md
    agent.md
    tools/*.py                     additive, this agent only
    skills/<name>/SKILL.md         additive, this agent only
```

```python
from pathlib import Path
from seeder_kit import available_modes, parse_tree

print(available_modes(Path("my_seed")))   # e.g. ["creator", "simple"]

tree = parse_tree(Path("my_seed"), mode="simple")
for agent in tree.agents:
    print(agent.folder_name, agent.slug)
    print(tree.tool_dirs_for(agent))    # [global tools dir, this agent's tools dir]
    print(tree.skill_dirs_for(agent))   # [global skills dir, this agent's skills dir]
    print(agent.read_soul())
```

`mode` is a required, opaque string — this library has no fixed list of
valid mode names and no opinion about what a mode means; it just scopes
which `modes/<mode>/agents/` subtree gets read. A mode with no directory
on disk (or no agents under it) is not an error — `parse_tree` returns a
tree with `agents == []` for it, same as a genuinely empty mode folder.
Global `tools/`/`skills/` at the root are read regardless of `mode`.

`parse_tree` only reads — it never creates, deletes, or mutates anything.
Turning that data into "create a real agent in system X" is the host
application's job (see the Hermes WebUI wrapper integration linked above
for a complete example: profile creation, SOUL.md writes, skill copying,
and `config.yaml` wiring).

## Module map

| Module | Purpose | Extra dependencies |
|---|---|---|
| `tree.py` | Parse a mode-scoped seeder-tree folder layout into `SeederTree`/`AgentSpec`; `available_modes` lists declared modes | none |
| `discovery.py` | Discover + validate MCP tool modules from directories | none |
| `skills.py` | Copy `<name>/SKILL.md` skill folders | none |
| `mcp_config.py` | Build an `mcp_servers:` config entry pointing at `runner.py` | none |
| `runner.py` | The actual stdio MCP server | `mcp` (the `[mcp]` extra) |

Every function that needs something beyond the standard library imports it
lazily inside its own body — `pip install seeder-kit` (no extras) is
enough to use everything except actually running a server.

## Design principles

- **No side effects on import.** Nothing in this library touches the
  filesystem, network, or environment at import time.
- **Fail loud, never silently shadow.** A duplicate tool name, a malformed
  tool module, or a missing required attribute raises immediately with a
  specific, actionable message — never a silent skip or an overwrite.
- **Host-agnostic core.** This library does not know what a "profile" is,
  what config-file format a host uses, or how a host names its agents
  beyond the plain folder-name -> lowercase-slug convention in `tree.py`.
  Anything host-specific belongs in the host's own integration code.
- **Optional dependencies stay optional.** Only `runner.py` needs the
  `mcp` package; everything else is pure standard library so it can be
  unit-tested and used for validation without installing it.

## Testing

```bash
cd seeder_kit
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m pytest -q
```

No pinned upstream checkout or network access needed — every test uses
`tmp_path` fixtures and synthetic tool/skill trees.
