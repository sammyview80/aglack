"""Shared read/write helpers for a Hermes profile's `config.yaml`.

Both `agent_config` (reads `workspace`/`default_workspace` keys) and
`agent_seeder` (merges in an `mcp_servers` entry) need the same
load-a-yaml-mapping-or-fail-closed logic; this keeps it in one place. The
helpers deliberately raise plain built-in exceptions (`ValueError` for a
file that exists but doesn't parse to a mapping, `OSError` passed through
from the filesystem) rather than any feature's own `FeatureError` subclass
— each caller translates to its own error code (`agent_config_*` /
`agent_seeder_*`) so API error codes stay feature-scoped and stable.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable


def load_profile_config(config_path: Path) -> dict[str, Any]:
    """Return `config_path` parsed as a YAML mapping.

    A missing file is `{}` (a profile with no config.yaml yet is a normal
    state, not an error). A file that exists but fails to parse raises
    `ValueError` — fail closed rather than silently treating a corrupt
    config as empty and clobbering it on a later write. A file that parses
    to a non-mapping (e.g. a bare list or string) is treated as `{}`,
    matching upstream's own lenient handling of malformed config.yaml.
    """
    if not config_path.exists():
        return {}
    import yaml

    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Could not parse {config_path}: {exc}") from exc
    return data if isinstance(data, dict) else {}


def save_profile_config(config_path: Path, config: dict[str, Any]) -> None:
    """Write `config` back as YAML, preserving key order (`sort_keys=False`
    — a hand-edited config.yaml shouldn't get alphabetized on the first
    programmatic write). Raises `OSError` on write failure."""
    import yaml

    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")


def mutate_profile_config(config_path: Path, mutator: Callable[[dict], None]) -> dict:
    """Load `config_path`, apply `mutator` in place, save it back, and
    return the resulting mapping. Propagates `load_profile_config`'s
    `ValueError`/`save_profile_config`'s `OSError` unchanged — each caller
    keeps translating those to its own `FeatureError` code/message at the
    call site, only the load/mutate/save mechanics live here."""
    config = load_profile_config(config_path)
    mutator(config)
    save_profile_config(config_path, config)
    return config
