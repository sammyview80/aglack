"""Agent-seeder feature service — the Hermes-WebUI-specific glue between
the framework-agnostic `seeder_kit` library and upstream's `api.profiles`.

All tree parsing, tool discovery/validation, and skill-copy MECHANICS live
in `seeder_kit` (see `../../../../../seeder_kit/README.md`) — this module's
only job is translating a `seeder_kit.SeederTree`'s content into calls
against upstream Hermes WebUI functions: create a profile, write its
SOUL.md/workspace AGENTS.md (via `features.agent_config.service`, reused
not duplicated), copy its skills into `<profile_home>/skills/`, and write
one `mcp_servers` entry into its `config.yaml`.

The actual seeder CONTENT this wrapper applies by default lives in
`../../../../../seeder/` (a sibling of `upstream/` and `wrapper/`) — see
that folder's own `README.md` for the on-disk tree layout and the
Hermes-specific scope notes (why `agent.md` maps to a workspace-level
AGENTS.md, why profile names get lowercased, etc.).

Every entry point here takes a required `mode` (e.g. `"simple"`,
`"creator"`, `"company"`) — `seeder_kit.parse_tree` scopes which agents
exist to `seeder/modes/<mode>/agents/*` (see that module's own docstring).
This service has NO opinion on which mode names are valid or what
distinguishes them — an unknown/not-yet-populated mode is simply a tree
with zero agents (`apply_all` then returns `{"applied": []}`, not an
error), same as `seeder_kit.parse_tree`'s own contract. `list_modes()`
reports which mode folders actually exist on disk, for a caller (e.g. the
frontend's mode-select screen) that wants to confirm before offering a
mode as a real choice — see `api/v1/agent_seeder.py`'s `GET /modes` route.

For each agent in a mode's tree:

1. Create the profile via `api.profiles.create_profile_api` if it doesn't
   already exist (idempotent — an existing profile is never re-created or
   destroyed).
2. Overwrite SOUL.md from `soul.md`, via
   `features.agent_config.service.update_soul`.
3. If a workspace is already configured for that profile, overwrite its
   workspace AGENTS.md from `agent.md`, via
   `features.agent_config.service.update_agent_instructions`. Skipped
   (recorded, not an error) if no workspace is configured yet.
4. Copy every applicable skill folder (global + this agent's own) into
   `<profile_home>/skills/<name>/`, via `seeder_kit.copy_skill_dirs`.
5. Discover this agent's applicable tool directories (global + its own)
   via `seeder_kit.discover_tools_in_dirs` — validating the tool tree
   before anything is written, so a broken tool module is caught at seed
   time — then write one `mcp_servers.hermes-seeder` entry via
   `seeder_kit.build_mcp_server_entry`.

No upstream symbol is imported at module level — every function below
imports `api.profiles` lazily, after `bootstrap_upstream()` has already
run for this process (same convention as every other `features/*/service.py`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from seeder_kit import (
    AgentSpec,
    SeederTree,
    ToolDiscoveryError,
    available_modes,
    build_mcp_server_entry,
    copy_skill_dirs,
    discover_tools_in_dirs,
    parse_tree,
)

from hermes_webui_wrapper.config import resolve_seeder_root
from hermes_webui_wrapper.features.errors import FeatureError
from hermes_webui_wrapper.features.profile_yaml import load_profile_config, save_profile_config


class AgentSeederError(FeatureError):
    """This feature's `FeatureError` — see `features/errors.py`."""


_MCP_SERVER_NAME = "hermes-seeder"


def _default_seeder_root() -> Path:
    """Kept as this module's own seam (tests monkeypatch it to point apply
    runs at synthetic trees) — real resolution, including the
    `HERMES_SEEDER_ROOT` env override, lives in `config.resolve_seeder_root`."""
    return resolve_seeder_root()


def _load_tree(mode: str) -> SeederTree:
    return parse_tree(_default_seeder_root(), mode=mode)


def list_modes() -> list[str]:
    """Every mode with a `seeder/modes/<name>/` directory on disk — see
    `seeder_kit.available_modes`. Does not imply the mode has any agents
    yet, only that it's a declared mode."""
    return available_modes(_default_seeder_root())


def _create_profile_if_missing(agent: AgentSpec) -> bool:
    """Returns True if a new profile was created. Idempotent — an existing
    profile is left untouched."""
    from api.profiles import create_profile_api, get_hermes_home_for_profile

    home = get_hermes_home_for_profile(agent.slug)
    if home.is_dir():
        return False
    try:
        create_profile_api(agent.slug)
    except FileExistsError:
        # Raced with something else creating it between the is_dir() check
        # and this call — fine, proceed as "already existed".
        pass
    except (ValueError, PermissionError, RuntimeError) as exc:
        raise AgentSeederError("agent_seeder_profile_create_failed", str(exc), 400) from exc
    return True


def _apply_soul(agent: AgentSpec) -> bool:
    from hermes_webui_wrapper.features.agent_config import service as agent_config_service

    content = agent.read_soul()
    if content is None:
        return False
    agent_config_service.update_soul(agent.slug, content)
    return True


def _apply_agent_instructions(agent: AgentSpec, result: dict[str, Any]) -> None:
    from hermes_webui_wrapper.features.agent_config import service as agent_config_service

    content = agent.read_agent_instructions()
    if content is None:
        result["agent_md_updated"] = False
        return

    try:
        agent_config_service.update_agent_instructions(agent.slug, content)
        result["agent_md_updated"] = True
    except agent_config_service.AgentConfigError as exc:
        if exc.code in ("agent_config_workspace_not_configured", "agent_config_workspace_missing"):
            result["agent_md_updated"] = False
            result["agent_md_skipped_reason"] = exc.message
        else:
            raise AgentSeederError(
                "agent_seeder_agent_md_failed", exc.message, exc.status_code
            ) from exc


def _apply_skills(tree: SeederTree, agent: AgentSpec, profile_home: Path) -> list[str]:
    dest_skills_dir = profile_home / "skills"
    dest_skills_dir.mkdir(parents=True, exist_ok=True)

    copied: set[str] = set()
    for source_dir in tree.skill_dirs_for(agent):
        copied.update(copy_skill_dirs(source_dir, dest_skills_dir))
    return sorted(copied)


def _apply_mcp_tools(tree: SeederTree, agent: AgentSpec, profile_home: Path) -> dict[str, Any]:
    tool_dirs = tree.tool_dirs_for(agent)
    try:
        discovered = discover_tools_in_dirs(tool_dirs)
    except ToolDiscoveryError as exc:
        raise AgentSeederError("agent_seeder_tool_discovery_failed", str(exc), 400) from exc

    if not tool_dirs:
        return {"tools_seeded": [], "mcp_server_configured": False}

    config_path = profile_home / "config.yaml"
    try:
        config = load_profile_config(config_path)
    except ValueError as exc:
        raise AgentSeederError("agent_seeder_config_unreadable", str(exc), 500) from exc

    mcp_servers = config.setdefault("mcp_servers", {})
    mcp_servers[_MCP_SERVER_NAME] = build_mcp_server_entry(
        tool_dirs, server_name=f"{_MCP_SERVER_NAME}-{agent.slug}"
    )

    try:
        save_profile_config(config_path, config)
    except OSError as exc:
        raise AgentSeederError("agent_seeder_config_write_failed", str(exc), 500) from exc

    return {
        "tools_seeded": sorted(t.name for t in discovered),
        "mcp_server_configured": True,
    }


def _apply_agent(tree: SeederTree, agent: AgentSpec) -> dict[str, Any]:
    from api.profiles import get_hermes_home_for_profile

    result: dict[str, Any] = {"agent": agent.slug, "display_name": agent.folder_name}

    result["profile_created"] = _create_profile_if_missing(agent)
    result["soul_updated"] = _apply_soul(agent)
    _apply_agent_instructions(agent, result)

    profile_home = get_hermes_home_for_profile(agent.slug)
    result["skills_seeded"] = _apply_skills(tree, agent, profile_home)
    result.update(_apply_mcp_tools(tree, agent, profile_home))

    return result


def apply_all(mode: str) -> dict[str, Any]:
    """Apply every agent found in `mode`'s tree. Returns one result entry
    per agent, in tree order. A single agent's failure raises immediately
    (fail closed on the whole apply) rather than silently skipping it and
    reporting partial success. A mode with no declared agents (including
    one that doesn't exist on disk at all) returns `{"applied": []}` — see
    module docstring for why that's not an error."""
    tree = _load_tree(mode)
    applied = [_apply_agent(tree, agent) for agent in tree.agents]
    return {"applied": applied}


def apply_one(mode: str, folder_name: str) -> dict[str, Any]:
    tree = _load_tree(mode)
    agent = tree.agent_by_folder_name(folder_name)
    if agent is None:
        raise AgentSeederError(
            "agent_seeder_agent_not_in_tree",
            f"No seeder/modes/{mode}/agents/{folder_name}/ directory found.",
            404,
        )
    return _apply_agent(tree, agent)
