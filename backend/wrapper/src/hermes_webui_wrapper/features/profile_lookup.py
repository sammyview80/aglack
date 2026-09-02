"""Shared profile-name-to-home-directory lookup, used by both
`agent_config` and `agent_history`.

`get_hermes_home_for_profile()` falls back to the BASE Hermes home for any
name that isn't a valid profile id (its own docstring's path-traversal
rejection mechanism), so that home always exists on disk. Checking
`home.is_dir()` alone, without first validating the name shape, would
incorrectly accept a malformed/traversal-shaped name as if it resolved to
the root profile. `known_profile_home` applies the stricter of the two
checks the two features used to duplicate (`_PROFILE_ID_RE` pre-check, then
the filesystem-existence check) and returns `None` for anything that fails
either — callers raise their own feature-specific `FeatureError` subclass
and error code at the call site; this module knows nothing about
`agent_config_*` / `agent_history_*` codes.
"""
from __future__ import annotations

from pathlib import Path


def known_profile_home(name: str) -> Path | None:
    """Return the resolved home directory for an existing, validly-named
    profile, or `None` if the name is malformed/traversal-shaped or does
    not resolve to a profile that actually exists on disk."""
    from api.profiles import _is_root_profile, _PROFILE_ID_RE, get_hermes_home_for_profile

    if _is_root_profile(name):
        return get_hermes_home_for_profile(name)

    if not name or not _PROFILE_ID_RE.fullmatch(name):
        return None

    home = get_hermes_home_for_profile(name)
    if not home.is_dir():
        return None
    return home
