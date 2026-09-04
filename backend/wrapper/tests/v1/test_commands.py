"""Behavioral tests for the native commands routes (`api/v1/commands.py`)
— exercises the real upstream `api.commands` functions against an isolated
tmp HERMES_HOME (see ../conftest.py), not mocks.

`hermes_cli` may not be installed in the test venv (it ships in the Docker
image — see AGENTS.md "Runtime environment"). Upstream's catalog functions
degrade to empty lists in that case, so the list tests assert only on the
envelope + list shape, exactly as test_onboarding.py tolerates the same
environment limitation.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hermes_webui_wrapper.app import create_app


def _hermes_cli_importable() -> bool:
    """Mirrors test_onboarding.py's own helper of the same name — this
    venv may not have hermes_cli installed (it ships in the Docker image,
    see AGENTS.md "Runtime environment"); tests that need its plugin-
    command runtime specifically are skipped/branched around that gap
    rather than silently asserting the wrong status code."""
    try:
        import hermes_cli.plugins  # noqa: F401
    except ImportError:
        return False
    return True


def _skill_bundles_importable() -> bool:
    """Same environment-gap pattern as `_hermes_cli_importable`, for
    `resolve_bundle_command`'s own dependency (`agent.skill_bundles`,
    separate from hermes_cli) — this venv may not have it either."""
    try:
        import agent.skill_bundles  # noqa: F401
    except ImportError:
        return False
    return True


@pytest.fixture()
def client() -> TestClient:
    app = create_app(runtime_enabled=False)
    with TestClient(app) as test_client:
        yield test_client


def test_list_commands_returns_envelope_with_list(client: TestClient) -> None:
    response = client.get("/api/wrapper/v1/commands")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert isinstance(body["data"], list)


def test_list_bundles_returns_envelope_with_list(client: TestClient) -> None:
    response = client.get("/api/wrapper/v1/commands/bundles")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert isinstance(body["data"], list)


@pytest.mark.skipif(
    not _hermes_cli_importable(),
    reason=(
        "hermes_cli is not installed in this venv, so execute_plugin_command's "
        "own KeyError path (an unrecognized command name) is unreachable — "
        "without hermes_cli it raises RuntimeError('plugin command runtime "
        "unavailable') first (-> 500), same environment limitation "
        "test_onboarding.py documents for its own hermes_cli-dependent tests. "
        "See test_exec_unknown_command_without_hermes_cli_returns_500 for the "
        "counterpart assertion in this environment."
    ),
)
def test_exec_unknown_command_returns_404_error_envelope(client: TestClient) -> None:
    """routes.py's `/api/commands/exec`: `execute_agent_command`'s KeyError
    is ignored (not an agent command), then `execute_plugin_command`'s
    KeyError becomes 404 "Plugin command not found"."""
    response = client.post(
        "/api/wrapper/v1/commands/exec",
        json={"command": "/definitely-not-a-real-command-xyz"},
    )

    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "commands_exec_failed"
    assert body["error"]["message"] == "Plugin command not found"


def test_exec_unknown_command_without_hermes_cli_returns_500(client: TestClient) -> None:
    """Environment counterpart to the skipped test above: without
    hermes_cli, execute_plugin_command raises RuntimeError('plugin command
    runtime unavailable') before it can ever reach its own KeyError check —
    service.py's _wrap must map that to 500, not silently succeed or 404."""
    if _hermes_cli_importable():
        pytest.skip("hermes_cli IS importable here — see the 404 test above instead")

    response = client.post(
        "/api/wrapper/v1/commands/exec",
        json={"command": "/definitely-not-a-real-command-xyz"},
    )

    assert response.status_code == 500
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "commands_exec_failed"


def test_resolve_bundle_with_empty_command_returns_400_error_envelope(
    client: TestClient,
) -> None:
    """Upstream's `resolve_bundle_command` raises ValueError for an empty
    command — service.py maps ValueError -> 400, mirroring routes.py."""
    response = client.post(
        "/api/wrapper/v1/commands/bundles/resolve", json={"command": ""}
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "commands_bundle_resolve_failed"


@pytest.mark.skipif(
    not _skill_bundles_importable(),
    reason=(
        "agent.skill_bundles is not importable in this venv, so "
        "resolve_bundle_command's own KeyError path (an unrecognized "
        "bundle name) is unreachable — without it, resolve_bundle_command "
        "raises RuntimeError('Skill bundle runtime unavailable') first "
        "(-> 500). See the counterpart test below for this environment."
    ),
)
def test_resolve_bundle_unknown_bundle_returns_404_with_fixed_message(
    client: TestClient,
) -> None:
    """routes.py:16549-16550 returns the fixed literal "Bundle command not
    found" for every KeyError here, never the raw bundle name — regression
    test for the bug where service.py's resolve_bundle() forgot to pass
    key_error_message and leaked the raw name instead."""
    response = client.post(
        "/api/wrapper/v1/commands/bundles/resolve",
        json={"command": "/definitely-not-a-real-bundle-xyz"},
    )

    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "commands_bundle_resolve_failed"
    assert body["error"]["message"] == "Bundle command not found"


def test_resolve_bundle_unknown_bundle_without_skill_bundles_returns_500(
    client: TestClient,
) -> None:
    """Environment counterpart to the skipped test above."""
    if _skill_bundles_importable():
        pytest.skip("agent.skill_bundles IS importable here — see the 404 test above instead")

    response = client.post(
        "/api/wrapper/v1/commands/bundles/resolve",
        json={"command": "/definitely-not-a-real-bundle-xyz"},
    )

    assert response.status_code == 500
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "commands_bundle_resolve_failed"


def test_commands_is_native_not_proxied_through_dispatch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of api/v1/commands.py existing is to bypass
    dispatch()/FakeHandler for this feature — prove it, the same way
    test_agent_history.py proves it for its own native routes."""

    def _fail_dispatch(*_args, **_kwargs):
        raise AssertionError("dispatch() must not be called for native commands routes")

    monkeypatch.setattr("hermes_webui_wrapper.app.dispatch", _fail_dispatch)

    response = client.get("/api/wrapper/v1/commands")

    assert response.status_code == 200


def test_profile_binding_is_cleared_after_call() -> None:
    """The service must reproduce the dispatcher's set/clear pair around
    every upstream call and never leak the profile past the call, even
    when the upstream function raises."""
    from api.profiles import get_active_profile_name

    from hermes_webui_wrapper.features.commands.service import _bound_profile

    before = get_active_profile_name()
    with _bound_profile("commands-binding-test"):
        assert get_active_profile_name() == "commands-binding-test"
    assert get_active_profile_name() == before

    with pytest.raises(RuntimeError):
        with _bound_profile("commands-binding-test"):
            raise RuntimeError("boom")
    assert get_active_profile_name() == before
