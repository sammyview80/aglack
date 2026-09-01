"""Wrapper settings, resolved from the environment. No pydantic dependency."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}

# Must match the pin recorded in ../UPSTREAM.md. Updating the pin requires
# updating both this default and UPSTREAM.md together (see that file's
# "Safely updating the pinned commit" procedure).
_DEFAULT_EXPECTED_UPSTREAM_REVISION = "e168b67e4278df618d1cab61fdb3a8dc55b29a81"


def _parse_bool(value: str, *, default: bool) -> bool:
    normalized = value.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    return default


def _wrapper_project_root() -> Path:
    # This file lives at <wrapper>/src/hermes_webui_wrapper/config.py in an
    # installed source checkout, so the wrapper project root is three
    # parents up. The ONE place this path arithmetic exists — every
    # sibling-directory default (upstream/, seeder/) derives from here
    # rather than re-counting parents from its own file location.
    return Path(__file__).resolve().parents[2]


def _default_upstream_root() -> Path:
    return (_wrapper_project_root().parent / "upstream").resolve()


def resolve_seeder_root() -> Path:
    """The seeder CONTENT tree (`backend/seeder/` — see its README.md).

    `HERMES_SEEDER_ROOT` overrides; the default is the umbrella's sibling
    `seeder/` directory next to `upstream/` (the exact layout both the
    source checkout and the workspace Docker image use — see
    `backend/workspace-image/Dockerfile`). A module-level function rather
    than a `Settings` field because its one consumer
    (`features/agent_seeder/service.py`) resolves it lazily per request —
    `Settings.from_env()` requires `HERMES_FRONTEND_ORIGIN` and constructing
    a full Settings just to get one path would couple seeding to unrelated
    required config.
    """
    override = os.environ.get("HERMES_SEEDER_ROOT")
    if override:
        return Path(override).resolve()
    return (_wrapper_project_root().parent / "seeder").resolve()


@dataclass(frozen=True)
class Settings:
    upstream_root: Path
    runtime_enabled: bool
    frontend_origin: str
    service_name: str = "hermes-webui-wrapper"
    upstream_owner: str = "hermes-webui"
    expected_upstream_revision: str = _DEFAULT_EXPECTED_UPSTREAM_REVISION

    @classmethod
    def from_env(cls) -> "Settings":
        upstream_override = os.environ.get("HERMES_WEBUI_UPSTREAM")
        upstream_root = (
            Path(upstream_override).resolve()
            if upstream_override
            else _default_upstream_root()
        )
        runtime_enabled = _parse_bool(
            os.environ.get("HERMES_WRAPPER_RUNTIME_ENABLED", "true"),
            default=True,
        )
        expected_upstream_revision = os.environ.get(
            "HERMES_WEBUI_UPSTREAM_REVISION", _DEFAULT_EXPECTED_UPSTREAM_REVISION
        ).strip()
        frontend_origin = os.environ.get("HERMES_FRONTEND_ORIGIN", "").strip()
        if not frontend_origin:
            raise RuntimeError(
                "HERMES_FRONTEND_ORIGIN is not set — copy backend/wrapper/.env.example "
                "to .env (must match the Vite origin, e.g. http://localhost:5173)"
            )
        return cls(
            upstream_root=upstream_root,
            runtime_enabled=runtime_enabled,
            frontend_origin=frontend_origin,
            expected_upstream_revision=expected_upstream_revision,
        )
