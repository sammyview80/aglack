"""Skill-folder copy mechanics — pure filesystem operations, no knowledge
of any host application's profile/config model.

A "skill" here is a directory containing exactly one `SKILL.md` file (the
shape most MCP-capable agent runtimes that support skills expect — e.g.
Hermes Agent's own skill loader scans for files literally named
`SKILL.md`). `copy_skill_dirs` copies every such directory found directly
under a source root into a destination root, overwriting any existing copy
at that name.
"""
from __future__ import annotations

import shutil
from pathlib import Path

SKILL_INDEX_FILENAME = "SKILL.md"


def copy_skill_dirs(source_root: Path | None, dest_root: Path) -> list[str]:
    """Copy every `<name>/SKILL.md` folder directly under `source_root`
    into `dest_root/<name>/`, overwriting any existing copy at that name.

    Returns the sorted list of skill names copied. A `None` or
    non-existent `source_root` is a valid no-op (returns `[]`) — an
    optional skills directory that doesn't exist is not an error.
    """
    if source_root is None or not source_root.is_dir():
        return []

    copied: list[str] = []
    for skill_dir in sorted(p for p in source_root.iterdir() if p.is_dir()):
        if not (skill_dir / SKILL_INDEX_FILENAME).is_file():
            continue
        dest = dest_root / skill_dir.name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(skill_dir, dest)
        copied.append(skill_dir.name)
    return copied
