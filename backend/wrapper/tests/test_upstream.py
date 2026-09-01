"""Behavioral tests for upstream bootstrap validation helpers. These target
the pure validation functions directly and never touch the module-level
_bootstrapped_root, so they are safe to run alongside other tests that do
bootstrap the real upstream checkout."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from hermes_webui_wrapper.config import Settings
from hermes_webui_wrapper.upstream import (
    _check_for_conflicting_modules,
    _validate_revision,
    _validate_root,
    bootstrap_upstream,
)


def test_validate_root_raises_on_missing_directory(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"

    with pytest.raises(RuntimeError, match="missing or not a directory"):
        _validate_root(missing)


def test_validate_root_raises_on_missing_required_file(tmp_path: Path) -> None:
    root = tmp_path / "upstream"
    (root / "api").mkdir(parents=True)
    (root / "api" / "__init__.py").write_text("")
    # server.py, api/routes.py, api/helpers.py, api/auth.py intentionally absent.

    with pytest.raises(RuntimeError, match="missing required file"):
        _validate_root(root)


def test_check_for_conflicting_modules_raises_for_module_outside_root(tmp_path: Path) -> None:
    expected_root = tmp_path / "upstream"
    (expected_root / "api").mkdir(parents=True)

    other_root = tmp_path / "other"
    (other_root / "api").mkdir(parents=True)
    conflicting_file = other_root / "api" / "__init__.py"
    conflicting_file.write_text("")

    fake_module = types.ModuleType("api")
    fake_module.__file__ = str(conflicting_file)

    original = sys.modules.get("api")
    sys.modules["api"] = fake_module
    try:
        with pytest.raises(RuntimeError, match="conflicting module already imported"):
            _check_for_conflicting_modules(expected_root)
    finally:
        if original is not None:
            sys.modules["api"] = original
        else:
            sys.modules.pop("api", None)


def test_check_for_conflicting_modules_allows_module_inside_root(upstream_root: Path) -> None:
    # Real api.* modules are already imported (bootstrapped from upstream_root)
    # by the integration tests in this suite, so this exercises the allowed
    # in-root case without touching sys.modules.
    _check_for_conflicting_modules(upstream_root)


def test_bootstrap_upstream_disables_bytecode_writes(upstream_root: Path) -> None:
    # Re-bootstrapping against the same root the app already used is a no-op
    # (idempotent path); never point this at a different root, which raises.
    settings = Settings(
        upstream_root=upstream_root,
        runtime_enabled=False,
        frontend_origin="http://localhost:5173",
    )
    bootstrap_upstream(settings)

    assert sys.dont_write_bytecode is True


def test_validate_revision_accepts_exact_match() -> None:
    _validate_revision("deadbeef", "deadbeef")


def test_validate_revision_raises_when_unresolvable() -> None:
    with pytest.raises(RuntimeError, match="unable to resolve upstream checkout revision"):
        _validate_revision("unknown", "deadbeef")


def test_validate_revision_raises_on_mismatch() -> None:
    with pytest.raises(RuntimeError, match="revision mismatch"):
        _validate_revision("cafef00d", "deadbeef")


def test_bootstrap_upstream_idempotent_call_revalidates_revision(upstream_root: Path) -> None:
    # Same-root re-bootstrap must still call _validate_revision, not just
    # re-resolve and skip validation entirely.
    settings = Settings(
        upstream_root=upstream_root,
        runtime_enabled=False,
        frontend_origin="http://localhost:5173",
    )
    bootstrap_upstream(settings)

    bad_settings = Settings(
        upstream_root=upstream_root,
        runtime_enabled=False,
        frontend_origin="http://localhost:5173",
        expected_upstream_revision="0" * 40,
    )
    with pytest.raises(RuntimeError, match="revision mismatch"):
        bootstrap_upstream(bad_settings)
