"""Pure, read-only parser for a seeder tree — the on-disk folder layout
that declares global/per-agent MCP tools, skills, and identity content,
scoped by an optional MODE (e.g. "simple", "creator", "company" — this
module has no opinion on which modes exist or what they mean, it only
knows how to read one given its name):

    <root>/
      tools/*.py                       global MCP tools — every agent, in every
                                        mode, gets these
      skills/<name>/SKILL.md           global skills — every agent, in every
                                        mode, gets these
      modes/<mode>/agents/<AgentName>/
        soul.md                        -> that agent's identity file content
        agent.md                       -> that agent's instructions file content
        tools/*.py                     per-agent MCP tools, additive to <root>/tools/
        skills/<name>/SKILL.md         per-agent skills, additive to <root>/skills/

Global `tools/`/`skills/` live at the tree root, OUTSIDE any mode — a tool
or skill every agent should get regardless of mode belongs there once, not
duplicated per mode. Per-agent content is mode-scoped
(`modes/<mode>/agents/<name>/`) because which agents even exist is exactly
what differs between modes (e.g. "simple" seeds one PM agent, a future
"company" mode might seed a whole department tree) — see
`backend/wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py`
for the Hermes-specific translation of this into real profiles, and
`backend/seeder/README.md` for the actual current mode(s) on disk.

This module ONLY reads the tree and returns plain data — it has no opinion
about what "creating a profile" or "writing SOUL.md" means for any
particular host application (Hermes WebUI, or anything else), and no
opinion about which mode names are valid (an unknown/missing mode just
produces an empty-agents tree — see `parse_tree`). That translation
belongs in the host application's own integration code. This separation is
what makes `seeder-kit` reusable outside this one wrapper.

Profile/agent *names*: this module reports the raw folder name unchanged
(`AgentSpec.folder_name`, e.g. `"PM"`) alongside a normalized `slug`
(lowercased) — many host systems (Hermes profiles included) require a
lowercase identifier, but the human-facing folder name is worth keeping
around for display purposes. `slugify` is intentionally simple (lowercase
only, no character substitution) — a host with stricter identifier rules
should validate `slug` itself rather than assume this module's normalization
is sufficient.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


def slugify(folder_name: str) -> str:
    return folder_name.lower()


@dataclass(frozen=True)
class AgentSpec:
    folder_name: str
    """Raw folder name under `<root>/modes/<mode>/agents/`, e.g. `"PM"`."""

    slug: str
    """Normalized identifier (`slugify(folder_name)`), e.g. `"pm"`."""

    path: Path
    """Absolute path to `<root>/modes/<mode>/agents/<folder_name>/`."""

    soul_path: Path | None
    """`<agent_dir>/soul.md`, or None if it doesn't exist."""

    agent_instructions_path: Path | None
    """`<agent_dir>/agent.md`, or None if it doesn't exist."""

    tools_dir: Path | None
    """`<agent_dir>/tools/`, or None if it doesn't exist as a directory."""

    skills_dir: Path | None
    """`<agent_dir>/skills/`, or None if it doesn't exist as a directory."""

    def read_soul(self) -> str | None:
        return self.soul_path.read_text(encoding="utf-8") if self.soul_path else None

    def read_agent_instructions(self) -> str | None:
        return (
            self.agent_instructions_path.read_text(encoding="utf-8")
            if self.agent_instructions_path
            else None
        )


@dataclass(frozen=True)
class SeederTree:
    root: Path
    mode: str
    """The mode this tree was parsed for (e.g. `"simple"`)."""

    global_tools_dir: Path | None
    global_skills_dir: Path | None
    agents: list[AgentSpec] = field(default_factory=list)

    def tool_dirs_for(self, agent: AgentSpec) -> list[Path]:
        """Every directory that should be scanned for this agent's MCP
        tools: the global tools dir (if present) plus this agent's own (if
        present), in that order."""
        return [d for d in (self.global_tools_dir, agent.tools_dir) if d is not None]

    def skill_dirs_for(self, agent: AgentSpec) -> list[Path]:
        """Every directory that should be scanned for this agent's skills:
        the global skills dir (if present) plus this agent's own (if
        present)."""
        return [d for d in (self.global_skills_dir, agent.skills_dir) if d is not None]

    def agent_by_folder_name(self, folder_name: str) -> AgentSpec | None:
        for agent in self.agents:
            if agent.folder_name == folder_name:
                return agent
        return None


def _existing_dir_or_none(path: Path) -> Path | None:
    return path if path.is_dir() else None


def _existing_file_or_none(path: Path) -> Path | None:
    return path if path.is_file() else None


def _parse_agent_dir(agent_dir: Path) -> AgentSpec:
    return AgentSpec(
        folder_name=agent_dir.name,
        slug=slugify(agent_dir.name),
        path=agent_dir,
        soul_path=_existing_file_or_none(agent_dir / "soul.md"),
        agent_instructions_path=_existing_file_or_none(agent_dir / "agent.md"),
        tools_dir=_existing_dir_or_none(agent_dir / "tools"),
        skills_dir=_existing_dir_or_none(agent_dir / "skills"),
    )


def available_modes(root: Path) -> list[str]:
    """List every mode name with a `modes/<name>/` directory under `root`,
    sorted. Does not validate that a mode actually has any agents — an
    empty mode folder still counts as "available" (declared, just empty)."""
    modes_root = Path(root) / "modes"
    if not modes_root.is_dir():
        return []
    return sorted(p.name for p in modes_root.iterdir() if p.is_dir())


def parse_tree(root: Path, mode: str) -> SeederTree:
    """Read `root` scoped to `mode` and return a `SeederTree` snapshot.

    A missing `root`, a missing `modes/<mode>/` directory, or a missing
    `modes/<mode>/agents/` directory are all NOT errors — each produces an
    empty-agents tree for that mode, since "this mode has no agents
    declared (yet)" is a normal state, not a malformed tree. Global
    `tools/`/`skills/` are still read from `root` regardless of whether
    the mode itself has any content.
    """
    root = Path(root)
    agents_root = root / "modes" / mode / "agents"
    agents = []
    if agents_root.is_dir():
        agents = [_parse_agent_dir(p) for p in sorted(agents_root.iterdir()) if p.is_dir()]

    return SeederTree(
        root=root,
        mode=mode,
        global_tools_dir=_existing_dir_or_none(root / "tools"),
        global_skills_dir=_existing_dir_or_none(root / "skills"),
        agents=agents,
    )
