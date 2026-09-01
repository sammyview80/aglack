"""Tests for the parts of `runner.py` that don't require the optional
`mcp` package — argument parsing. `build_server`/`cli_main` import `mcp`
lazily inside their own bodies specifically so this module stays
importable and testable without that dependency installed; a real
end-to-end server test belongs in an environment with `seeder-kit[mcp]`
installed, not this base test run.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from seeder_kit.runner import _parse_args


def test_single_tools_dir() -> None:
    args = _parse_args(["--tools-dir", "/a"])

    assert args.tools_dir == [Path("/a")]
    assert args.server_name == "seeder-kit"


def test_multiple_tools_dirs_accumulate() -> None:
    args = _parse_args(["--tools-dir", "/a", "--tools-dir", "/b"])

    assert args.tools_dir == [Path("/a"), Path("/b")]


def test_custom_server_name() -> None:
    args = _parse_args(["--tools-dir", "/a", "--server-name", "custom"])

    assert args.server_name == "custom"


def test_missing_tools_dir_errors() -> None:
    with pytest.raises(SystemExit):
        _parse_args([])
