"""Agent-config feature service — updates a named profile's SOUL.md and
workspace-level AGENTS.md after creation, calling upstream's `api.profiles`
functions directly instead of routing through the catch-all
stdlib-handler-emulation proxy (same "optimized path" reasoning as
`features/onboarding/service.py`).

Why SOUL.md + workspace AGENTS.md, not a per-profile AGENTS.md (current
scope): this pinned upstream checkout (see `../../../UPSTREAM.md`) has no
per-profile `AGENTS.md` concept and no writable `profile.yaml` description
field — `profile.yaml` here is only ever read for a `visible: false` flag
(`api/profiles.py::_profile_visible_from_meta`), never written by any
`api.profiles` function. `AGENTS.md` in this checkout is a WORKSPACE-level
file the agent scans from its current working directory
(`api/routes.py`'s `_PROJECT_CONTEXT_CWD_NAMES`), not a profile-identity
file — so `update_agent_instructions` writes it into that profile's
resolved workspace directory, not its home directory. Provider/model/
API-key config for a newly created profile is already handled by
`create_profile_api` itself (`base_url`/`api_key`/`default_model`/
`model_provider` params).

Workspace resolution deliberately does NOT reuse
`api.workspace._profile_default_workspace()` — that function reads the
process-global ACTIVE profile's config via `api.config.get_config()`, plus
a remote-terminal/live-`DEFAULT_WORKSPACE` fallback chain that depends on
already-active process state. None of that is safe to borrow for an
arbitrary, possibly-inactive profile name during a seeding pass over many
profiles at once. Instead, `_resolve_profile_workspace` reads ONLY that
profile's own `config.yaml` (`workspace` / `default_workspace` keys —
the same two keys `_profile_default_workspace` checks first) directly, and
fails closed with a clear error if neither is set, rather than guessing a
directory or silently reading another profile's active state.

Uses `get_hermes_home_for_profile(name)` — a public, side-effect-free
upstream function (reads only the filesystem, never mutates process state
or `os.environ`) that resolves both the root/default profile and any named
profile under `~/.hermes/profiles/<name>` from one call, rejecting path
traversal — see its own docstring in `api/profiles.py`.

As with `features/onboarding/service.py`, no upstream symbol is imported at
module import time — every function below imports `api.profiles` lazily,
after `bootstrap_upstream()` has already run for this process (see
`upstream.py`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from hermes_webui_wrapper.features.errors import FeatureError
from hermes_webui_wrapper.features.profile_yaml import load_profile_config


class AgentConfigError(FeatureError):
    """This feature's `FeatureError` — see `features/errors.py`. Mapping
    convention: upstream `routes.py`'s own ValueError -> 400 /
    RuntimeError -> 500, plus a dedicated 404 for an unknown profile name
    (that case has no single upstream exception type to copy from — no
    equivalent endpoint exists in this checkout's `routes.py`)."""


def _require_known_profile(name: str):
    """Fail closed on a profile name that doesn't exist yet, and return its
    resolved home directory. This feature updates config for an
    ALREADY-created agent/profile (see module docstring) — it must never
    silently create the SOUL.md parent directory for a name nobody asked to
    create via `POST /api/profile/create` first.

    Checked against the filesystem directly (the resolved home directory
    actually existing) rather than `list_profiles_api()` — that function's
    no-`hermes_cli` fallback path only enumerates the default/root profile
    and does not scan `~/.hermes/profiles/` for named profiles created via
    the fallback `_create_profile_fallback`, even though the directory is
    genuinely on disk. Directory existence is the real invariant this
    feature needs; `get_hermes_home_for_profile` already validates the name
    format and rejects path traversal before any filesystem check happens.
    """
    from api.profiles import _is_root_profile, get_hermes_home_for_profile

    home = get_hermes_home_for_profile(name)
    if not (_is_root_profile(name) or home.is_dir()):
        raise AgentConfigError(
            "agent_config_profile_not_found", f"Profile '{name}' does not exist.", 404
        )
    return home


def _reject_symlink(path: Path, error_code: str, label: str) -> None:
    """Mirrors upstream's own memory-write symlink hardening
    (`api/routes.py::_handle_memory_write`) — a symlink planted at a config
    target must not let a write clobber an arbitrary file outside it."""
    if path.is_symlink():
        raise AgentConfigError(error_code, f"Cannot write to a symlinked {label}", 400)


def get_soul(name: str) -> dict[str, Any]:
    home = _require_known_profile(name)
    soul_path = home / "SOUL.md"
    content = soul_path.read_text(encoding="utf-8", errors="replace") if soul_path.exists() else ""
    return {"profile": name, "content": content}


def update_soul(name: str, content: str) -> dict[str, Any]:
    """Overwrite SOUL.md for an existing profile. Always writes — there is
    no skip-if-exists guard here, unlike `create_profile`'s own one-time
    seeding of a default SOUL.md at creation."""
    home = _require_known_profile(name)
    soul_path = home / "SOUL.md"
    _reject_symlink(soul_path, "agent_config_symlink_rejected", "SOUL.md")
    try:
        soul_path.parent.mkdir(parents=True, exist_ok=True)
        soul_path.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise AgentConfigError("agent_config_soul_write_failed", str(exc), 500) from exc
    return {"profile": name, "path": str(soul_path)}


def _resolve_profile_workspace(name: str, home: Path) -> Path:
    """Read ONLY this profile's own `config.yaml` `workspace` /
    `default_workspace` keys — see module docstring for why this
    deliberately does not call `api.workspace._profile_default_workspace()`
    (that function reads process-global ACTIVE profile state, unsafe for an
    arbitrary/inactive profile name). Fails closed (raises) if neither key
    is set, rather than guessing a directory."""
    config_path = home / "config.yaml"
    try:
        data = load_profile_config(config_path)
    except ValueError as exc:
        raise AgentConfigError(
            "agent_config_workspace_config_unreadable", str(exc), 500
        ) from exc
    workspace_value = data.get("workspace") or data.get("default_workspace")

    if not workspace_value:
        raise AgentConfigError(
            "agent_config_workspace_not_configured",
            f"Profile '{name}' has no 'workspace' or 'default_workspace' set in "
            f"config.yaml — set one (e.g. via profile creation or the workspace "
            f"API) before writing workspace-level AGENTS.md.",
            400,
        )

    return Path(str(workspace_value)).expanduser()


def get_agent_instructions(name: str) -> dict[str, Any]:
    home = _require_known_profile(name)
    workspace = _resolve_profile_workspace(name, home)
    agents_path = workspace / "AGENTS.md"
    content = agents_path.read_text(encoding="utf-8", errors="replace") if agents_path.exists() else ""
    return {"profile": name, "workspace": str(workspace), "content": content}


def update_agent_instructions(name: str, content: str) -> dict[str, Any]:
    """Overwrite the profile's WORKSPACE-level AGENTS.md (the file this
    checkout's agent actually scans from its current working directory —
    see module docstring). Always writes, no skip-if-exists guard."""
    home = _require_known_profile(name)
    workspace = _resolve_profile_workspace(name, home)
    if not workspace.is_dir():
        raise AgentConfigError(
            "agent_config_workspace_missing",
            f"Profile '{name}'s configured workspace does not exist on disk: {workspace}",
            400,
        )
    agents_path = workspace / "AGENTS.md"
    _reject_symlink(agents_path, "agent_config_symlink_rejected", "AGENTS.md")
    try:
        agents_path.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise AgentConfigError("agent_config_agents_md_write_failed", str(exc), 500) from exc
    return {"profile": name, "path": str(agents_path)}
