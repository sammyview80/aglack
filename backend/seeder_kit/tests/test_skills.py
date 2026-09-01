from __future__ import annotations

from pathlib import Path

from seeder_kit.skills import copy_skill_dirs


def _make_skill(root: Path, name: str, content: str = "content") -> None:
    skill_dir = root / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")


def test_copies_skill_folders(tmp_path: Path) -> None:
    source = tmp_path / "source"
    dest = tmp_path / "dest"
    dest.mkdir()
    _make_skill(source, "alpha")
    _make_skill(source, "beta")

    copied = copy_skill_dirs(source, dest)

    assert copied == ["alpha", "beta"]
    assert (dest / "alpha" / "SKILL.md").is_file()
    assert (dest / "beta" / "SKILL.md").is_file()


def test_none_source_is_noop(tmp_path: Path) -> None:
    dest = tmp_path / "dest"
    dest.mkdir()

    assert copy_skill_dirs(None, dest) == []


def test_missing_source_is_noop(tmp_path: Path) -> None:
    dest = tmp_path / "dest"
    dest.mkdir()

    assert copy_skill_dirs(tmp_path / "does-not-exist", dest) == []


def test_folder_without_skill_md_is_skipped(tmp_path: Path) -> None:
    source = tmp_path / "source"
    dest = tmp_path / "dest"
    dest.mkdir()
    (source / "not_a_skill").mkdir(parents=True)
    (source / "not_a_skill" / "readme.txt").write_text("x", encoding="utf-8")

    assert copy_skill_dirs(source, dest) == []


def test_overwrites_existing_copy(tmp_path: Path) -> None:
    source = tmp_path / "source"
    dest = tmp_path / "dest"
    dest.mkdir()
    _make_skill(source, "alpha", content="v1")
    copy_skill_dirs(source, dest)

    # Simulate a hand-edit to the source, then re-apply.
    (source / "alpha" / "SKILL.md").write_text("v2", encoding="utf-8")
    copy_skill_dirs(source, dest)

    assert (dest / "alpha" / "SKILL.md").read_text(encoding="utf-8") == "v2"
