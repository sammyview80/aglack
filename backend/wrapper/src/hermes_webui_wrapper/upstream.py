"""Fail-closed bootstrap that makes the pinned upstream `api` package
importable in-process, without ever mutating upstream source on disk."""

from __future__ import annotations

import importlib
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

_REQUIRED_RELATIVE_FILES = (
    "server.py",
    "api/__init__.py",
    "api/routes.py",
    "api/helpers.py",
    "api/auth.py",
)

_bootstrapped_root: Path | None = None


@dataclass(frozen=True)
class UpstreamInfo:
    owner: str
    revision: str


def _validate_root(root: Path) -> None:
    if not root.exists() or not root.is_dir():
        raise RuntimeError("upstream checkout is missing or not a directory")
    for relative in _REQUIRED_RELATIVE_FILES:
        if not (root / relative).is_file():
            raise RuntimeError(
                f"upstream checkout is missing required file: {relative}"
            )


def _check_for_conflicting_modules(root: Path) -> None:
    expected_api_dir = (root / "api").resolve()
    for name, module in list(sys.modules.items()):
        if module is None or (name != "api" and not name.startswith("api.")):
            continue
        candidate = getattr(module, "__file__", None) or next(
            iter(getattr(module, "__path__", []) or []), None
        )
        if candidate is None:
            continue
        candidate_path = Path(candidate).resolve()
        try:
            candidate_path.relative_to(expected_api_dir)
        except ValueError:
            raise RuntimeError(
                f"conflicting module already imported: {name} "
                "(resolves outside the selected upstream checkout)"
            ) from None


def _resolve_revision(root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        )
    except Exception:
        return "unknown"
    revision = result.stdout.strip()
    return revision or "unknown"


def _validate_revision(actual: str, expected: str) -> None:
    if actual == "unknown":
        raise RuntimeError(
            "unable to resolve upstream checkout revision (expected "
            f"{expected}); refusing to bootstrap an unpinned checkout"
        )
    if actual != expected:
        raise RuntimeError(
            f"upstream checkout revision mismatch: expected {expected}, got {actual}"
        )


def bootstrap_upstream(settings) -> UpstreamInfo:
    """Validate, import, and pin the upstream `api` package for this process.

    Idempotent only when called again with the same resolved root; a
    different second root raises.
    """
    global _bootstrapped_root

    root = settings.upstream_root.resolve()

    if _bootstrapped_root is not None:
        if root != _bootstrapped_root:
            raise RuntimeError(
                "upstream already bootstrapped from a different root in this process"
            )
        revision = _resolve_revision(root)
        _validate_revision(revision, settings.expected_upstream_revision)
        return UpstreamInfo(owner=settings.upstream_owner, revision=revision)

    _validate_root(root)
    _validate_revision(_resolve_revision(root), settings.expected_upstream_revision)
    _check_for_conflicting_modules(root)

    # This process treats upstream as read-only; never litter its tree with
    # __pycache__. Process-wide is fine here — this executable owns its
    # interpreter.
    sys.dont_write_bytecode = True

    root_str = str(root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    importlib.invalidate_caches()

    api_module = importlib.import_module("api")
    api_file = getattr(api_module, "__file__", None)
    if api_file is None:
        raise RuntimeError("imported 'api' package has no __file__")
    imported_api_dir = Path(api_file).resolve().parent
    expected_api_dir = (root / "api").resolve()
    if imported_api_dir != expected_api_dir:
        raise RuntimeError(
            "imported 'api' package resolved outside the selected upstream checkout"
        )

    final_revision = _resolve_revision(root)
    _validate_revision(final_revision, settings.expected_upstream_revision)

    _bootstrapped_root = root
    return UpstreamInfo(owner=settings.upstream_owner, revision=final_revision)
