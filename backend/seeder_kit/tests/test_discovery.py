from __future__ import annotations

import asyncio
import textwrap
from pathlib import Path

import pytest

from seeder_kit.discovery import ToolDiscoveryError, discover_tools_in_dirs


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _write_tool(path: Path, name: str, body: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        textwrap.dedent(
            f'''
            TOOL_NAME = "{name}"
            TOOL_DESCRIPTION = "desc for {name}"
            TOOL_INPUT_SCHEMA = {{"type": "object", "properties": {{}}}}

            async def handle(arguments):
                {body or 'return [{"type": "text", "text": "ok"}]'}
            '''
        ),
        encoding="utf-8",
    )


def test_discovers_single_directory(tmp_path: Path) -> None:
    tools_dir = tmp_path / "tools"
    _write_tool(tools_dir / "update_soul.py", "update_soul")

    discovered = discover_tools_in_dirs([tools_dir])

    assert len(discovered) == 1
    assert discovered[0].name == "update_soul"
    result = _run(discovered[0].handle({}))
    assert result == [{"type": "text", "text": "ok"}]


def test_merges_multiple_directories(tmp_path: Path) -> None:
    global_dir = tmp_path / "global_tools"
    agent_dir = tmp_path / "agent_tools"
    _write_tool(global_dir / "update_soul.py", "update_soul")
    _write_tool(agent_dir / "trigger_kanban.py", "trigger_kanban")

    discovered = discover_tools_in_dirs([global_dir, agent_dir])

    assert {t.name for t in discovered} == {"update_soul", "trigger_kanban"}


def test_duplicate_name_across_directories_raises(tmp_path: Path) -> None:
    global_dir = tmp_path / "global_tools"
    agent_dir = tmp_path / "agent_tools"
    _write_tool(global_dir / "a.py", "same_name")
    _write_tool(agent_dir / "b.py", "same_name")

    with pytest.raises(ToolDiscoveryError, match="duplicate MCP tool name 'same_name'"):
        discover_tools_in_dirs([global_dir, agent_dir])


def test_duplicate_name_within_same_directory_raises(tmp_path: Path) -> None:
    tools_dir = tmp_path / "tools"
    _write_tool(tools_dir / "a.py", "same_name")
    _write_tool(tools_dir / "b.py", "same_name")

    with pytest.raises(ToolDiscoveryError, match="duplicate MCP tool name 'same_name'"):
        discover_tools_in_dirs([tools_dir])


def test_missing_required_attribute_raises(tmp_path: Path) -> None:
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    (tools_dir / "broken.py").write_text('TOOL_NAME = "broken"\n', encoding="utf-8")

    with pytest.raises(ToolDiscoveryError, match="missing required attribute"):
        discover_tools_in_dirs([tools_dir])


def test_noncallable_handle_raises(tmp_path: Path) -> None:
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    (tools_dir / "broken.py").write_text(
        textwrap.dedent(
            """
            TOOL_NAME = "broken"
            TOOL_DESCRIPTION = "x"
            TOOL_INPUT_SCHEMA = {"type": "object", "properties": {}}
            handle = "not callable"
            """
        ),
        encoding="utf-8",
    )

    with pytest.raises(ToolDiscoveryError, match="handle must be callable"):
        discover_tools_in_dirs([tools_dir])


def test_nonexistent_directory_is_skipped(tmp_path: Path) -> None:
    assert discover_tools_in_dirs([tmp_path / "does-not-exist"]) == []


def test_underscore_prefixed_files_are_ignored(tmp_path: Path) -> None:
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    (tools_dir / "__init__.py").write_text("", encoding="utf-8")
    _write_tool(tools_dir / "real_tool.py", "real_tool")

    discovered = discover_tools_in_dirs([tools_dir])

    assert [t.name for t in discovered] == ["real_tool"]


def test_same_basename_in_two_directories_does_not_collide_as_modules(tmp_path: Path) -> None:
    global_dir = tmp_path / "global_tools"
    agent_dir = tmp_path / "agent_tools"
    _write_tool(global_dir / "update_soul.py", "update_soul_global")
    _write_tool(agent_dir / "update_soul.py", "update_soul_agent_scoped")

    discovered = discover_tools_in_dirs([global_dir, agent_dir])

    assert {t.name for t in discovered} == {"update_soul_global", "update_soul_agent_scoped"}
