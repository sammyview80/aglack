"""Shared fixtures for `backend/seeder/tools/*.py` unit tests.

Tool modules are plain sibling files with no package `__init__.py`; the
real host loads each one with `importlib.util.spec_from_file_location`
under a synthetic module name (`seeder_kit/discovery.py::_load_module_from_path`)
WITHOUT adding the tools directory to `sys.path`. `load_tool` mimics that
exact mechanism so these tests exercise the same import path production
uses — including the `_import_sibling` helper the browser tools rely on.

`fake_hermes_cli` installs a stub `hermes_cli` package (plus the four
submodules `_browser_use_llm.py` lazily imports) into `sys.modules` so no
real Hermes install is needed. `browser_use_classes` prefers the REAL
`browser_use` package when importable and otherwise installs dataclass
stand-ins with the confirmed constructor parameter names, so the mapping
tests run in a plain venv too.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from dataclasses import dataclass
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"


def _load_module_like_discovery(path: Path):
    spec = importlib.util.spec_from_file_location(f"_seeder_test_tool_{path.stem}_{id(path)}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def load_tool():
    """`load_tool("browser_task")` -> module object, loaded exactly the way
    `discover_tools_in_dirs` loads it."""

    def _load(stem: str):
        return _load_module_like_discovery(TOOLS_DIR / f"{stem}.py")

    return _load


class FakeAuthError(RuntimeError):
    """Stand-in for `hermes_cli.auth.AuthError` (a RuntimeError subclass)."""


@dataclass
class FakeHermesCli:
    """Handles onto the stub modules so a test can swap behaviour."""

    profiles: types.ModuleType
    runtime_provider: types.ModuleType
    config: types.ModuleType
    auth: types.ModuleType
    calls: list  # every resolve_runtime_provider() invocation


@pytest.fixture
def fake_hermes_cli(monkeypatch, tmp_path) -> FakeHermesCli:
    calls: list = []
    profiles_root = tmp_path / "profiles"
    (profiles_root / "pm").mkdir(parents=True)

    def validate_profile_name(name):
        if name == "default":
            return
        import re

        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", name):
            raise ValueError(f"invalid profile name: {name!r}")

    def get_profile_dir(name):
        return tmp_path if name == "default" else profiles_root / name

    def profile_exists(name):
        return name == "default" or (profiles_root / name).is_dir()

    def resolve_runtime_provider():
        calls.append(dict(__import__("os").environ))
        return {
            "provider": "deepseek",
            "api_mode": "chat_completions",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "sk-TOTALLY-FAKE-SECRET-VALUE-12345",
            "source": "test",
            "requested_provider": "deepseek",
        }

    def load_config():
        return {"model": {"default": "deepseek-chat"}}

    pkg = types.ModuleType("hermes_cli")
    pkg.__path__ = []  # mark as package
    profiles = types.ModuleType("hermes_cli.profiles")
    profiles.validate_profile_name = validate_profile_name
    profiles.get_profile_dir = get_profile_dir
    profiles.profile_exists = profile_exists
    runtime_provider = types.ModuleType("hermes_cli.runtime_provider")
    runtime_provider.resolve_runtime_provider = resolve_runtime_provider
    config = types.ModuleType("hermes_cli.config")
    config.load_config = load_config
    auth = types.ModuleType("hermes_cli.auth")
    auth.AuthError = FakeAuthError

    for name, mod in (
        ("hermes_cli", pkg),
        ("hermes_cli.profiles", profiles),
        ("hermes_cli.runtime_provider", runtime_provider),
        ("hermes_cli.config", config),
        ("hermes_cli.auth", auth),
    ):
        monkeypatch.setitem(sys.modules, name, mod)
        if name != "hermes_cli":
            setattr(pkg, name.split(".")[1], mod)

    return FakeHermesCli(profiles, runtime_provider, config, auth, calls)


@pytest.fixture
def browser_use_classes(monkeypatch):
    """Return the `browser_use` module the code under test will import.
    Real package if installed; otherwise dataclass stand-ins whose field
    names match the confirmed real constructor signatures (`model`,
    `api_key`, `base_url`) — the real classes are dataclasses storing those
    as instance attributes of the same name."""
    try:
        import browser_use  # noqa: F401

        return browser_use
    except ImportError:
        pass

    @dataclass
    class _Chat:
        model: str
        api_key: str | None = None
        base_url: str | None = None

    fake = types.ModuleType("browser_use")
    for cls_name in ("ChatOpenAI", "ChatAnthropic", "ChatDeepSeek", "ChatOpenRouter"):
        setattr(fake, cls_name, type(cls_name, (_Chat,), {}))
    monkeypatch.setitem(sys.modules, "browser_use", fake)
    return fake
