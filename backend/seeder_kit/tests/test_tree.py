from __future__ import annotations

from pathlib import Path

from seeder_kit.tree import available_modes, parse_tree, slugify


def _write(path: Path, content: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _agent_dir(root: Path, mode: str, agent_name: str) -> Path:
    return root / "modes" / mode / "agents" / agent_name


def test_slugify_lowercases_only() -> None:
    assert slugify("PM") == "pm"
    assert slugify("Widget-Agent_1") == "widget-agent_1"


def test_parse_tree_missing_root_returns_empty_agents(tmp_path: Path) -> None:
    tree = parse_tree(tmp_path / "does-not-exist", mode="simple")

    assert tree.agents == []
    assert tree.global_tools_dir is None
    assert tree.global_skills_dir is None
    assert tree.mode == "simple"


def test_parse_tree_missing_mode_returns_empty_agents_not_an_error(tmp_path: Path) -> None:
    _agent_dir(tmp_path, "simple", "PM").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="creator")

    assert tree.agents == []


def test_parse_tree_finds_global_dirs_regardless_of_mode(tmp_path: Path) -> None:
    (tmp_path / "tools").mkdir()
    (tmp_path / "skills").mkdir()

    tree = parse_tree(tmp_path, mode="simple")

    assert tree.global_tools_dir == tmp_path / "tools"
    assert tree.global_skills_dir == tmp_path / "skills"


def test_parse_tree_reads_agent_folder_contents(tmp_path: Path) -> None:
    agent_dir = _agent_dir(tmp_path, "simple", "PM")
    _write(agent_dir / "soul.md", "# PM soul\n")
    _write(agent_dir / "agent.md", "# PM instructions\n")
    (agent_dir / "tools").mkdir(parents=True)
    (agent_dir / "skills").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="simple")

    assert len(tree.agents) == 1
    agent = tree.agents[0]
    assert agent.folder_name == "PM"
    assert agent.slug == "pm"
    assert agent.read_soul() == "# PM soul\n"
    assert agent.read_agent_instructions() == "# PM instructions\n"
    assert agent.tools_dir == agent_dir / "tools"
    assert agent.skills_dir == agent_dir / "skills"


def test_parse_tree_missing_optional_files_are_none(tmp_path: Path) -> None:
    _agent_dir(tmp_path, "simple", "Bare").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="simple")
    agent = tree.agents[0]

    assert agent.soul_path is None
    assert agent.agent_instructions_path is None
    assert agent.tools_dir is None
    assert agent.skills_dir is None
    assert agent.read_soul() is None
    assert agent.read_agent_instructions() is None
    assert agent.wants_browser is False


def test_parse_tree_detects_browser_enabled_marker(tmp_path: Path) -> None:
    agent_dir = _agent_dir(tmp_path, "simple", "PM")
    _write(agent_dir / "browser.enabled", "")

    tree = parse_tree(tmp_path, mode="simple")
    agent = tree.agents[0]

    assert agent.wants_browser is True


def test_parse_tree_browser_enabled_marker_content_is_ignored(tmp_path: Path) -> None:
    """Presence-only marker, matching every other per-agent marker in this
    tree — its content (if any) must never be parsed or required to be
    anything in particular."""
    agent_dir = _agent_dir(tmp_path, "simple", "PM")
    _write(agent_dir / "browser.enabled", "this text is never read")

    tree = parse_tree(tmp_path, mode="simple")
    agent = tree.agents[0]

    assert agent.wants_browser is True


def test_parse_tree_browser_enabled_as_a_directory_does_not_count(tmp_path: Path) -> None:
    """Must be a FILE, matching `tools_dir`/`skills_dir`'s own
    file-vs-directory distinction elsewhere in this module — a stray
    directory of the same name is not the marker."""
    agent_dir = _agent_dir(tmp_path, "simple", "PM")
    (agent_dir / "browser.enabled").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="simple")
    agent = tree.agents[0]

    assert agent.wants_browser is False


def test_parse_tree_multiple_agents_sorted_by_folder_name(tmp_path: Path) -> None:
    _agent_dir(tmp_path, "simple", "Zebra").mkdir(parents=True)
    _agent_dir(tmp_path, "simple", "Alpha").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="simple")

    assert [a.folder_name for a in tree.agents] == ["Alpha", "Zebra"]


def test_parse_tree_scopes_agents_by_mode(tmp_path: Path) -> None:
    """The core scalability property: two modes at the same root have
    completely independent agent sets."""
    _agent_dir(tmp_path, "simple", "PM").mkdir(parents=True)
    _agent_dir(tmp_path, "creator", "Writer").mkdir(parents=True)
    _agent_dir(tmp_path, "creator", "Editor").mkdir(parents=True)

    simple_tree = parse_tree(tmp_path, mode="simple")
    creator_tree = parse_tree(tmp_path, mode="creator")

    assert [a.folder_name for a in simple_tree.agents] == ["PM"]
    assert [a.folder_name for a in creator_tree.agents] == ["Editor", "Writer"]


def test_tool_dirs_for_combines_global_and_agent(tmp_path: Path) -> None:
    (tmp_path / "tools").mkdir()
    agent_dir = _agent_dir(tmp_path, "simple", "PM")
    (agent_dir / "tools").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="simple")
    agent = tree.agents[0]

    assert tree.tool_dirs_for(agent) == [tmp_path / "tools", agent_dir / "tools"]


def test_tool_dirs_for_omits_missing_dirs(tmp_path: Path) -> None:
    _agent_dir(tmp_path, "simple", "PM").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="simple")
    agent = tree.agents[0]

    assert tree.tool_dirs_for(agent) == []


def test_skill_dirs_for_combines_global_and_agent(tmp_path: Path) -> None:
    (tmp_path / "skills").mkdir()
    agent_dir = _agent_dir(tmp_path, "simple", "PM")
    (agent_dir / "skills").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="simple")
    agent = tree.agents[0]

    assert tree.skill_dirs_for(agent) == [tmp_path / "skills", agent_dir / "skills"]


def test_agent_by_folder_name(tmp_path: Path) -> None:
    _agent_dir(tmp_path, "simple", "PM").mkdir(parents=True)

    tree = parse_tree(tmp_path, mode="simple")

    assert tree.agent_by_folder_name("PM") is not None
    assert tree.agent_by_folder_name("missing") is None


def test_available_modes_lists_mode_directory_names(tmp_path: Path) -> None:
    (tmp_path / "modes" / "simple").mkdir(parents=True)
    (tmp_path / "modes" / "creator").mkdir(parents=True)

    assert available_modes(tmp_path) == ["creator", "simple"]


def test_available_modes_empty_when_no_modes_directory(tmp_path: Path) -> None:
    assert available_modes(tmp_path) == []


def test_available_modes_counts_empty_mode_folder_as_available(tmp_path: Path) -> None:
    (tmp_path / "modes" / "creator").mkdir(parents=True)

    assert available_modes(tmp_path) == ["creator"]
