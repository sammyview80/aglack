"""Behavioral tests for the native agent-config routes
(`api/v1/agent_config.py`) — exercises the real upstream `api.profiles`
functions against an isolated tmp HERMES_HOME (see ../conftest.py), not
mocks, so these prove the actual upstream integration works end to end.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hermes_webui_wrapper.app import create_app


@pytest.fixture()
def client() -> TestClient:
    app = create_app(runtime_enabled=False)
    with TestClient(app) as test_client:
        yield test_client


def _create_profile(client: TestClient, name: str) -> None:
    response = client.post("/api/profile/create", json={"name": name})
    assert response.status_code == 200, response.text


def test_get_soul_unknown_profile_returns_404_error_envelope(client: TestClient) -> None:
    response = client.get("/api/wrapper/v1/agent-config/does-not-exist/soul")

    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "agent_config_profile_not_found"


def test_update_soul_unknown_profile_returns_404_error_envelope(client: TestClient) -> None:
    response = client.put(
        "/api/wrapper/v1/agent-config/does-not-exist/soul",
        json={"content": "# New Soul\n"},
    )

    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "agent_config_profile_not_found"


def test_get_soul_returns_seeded_default_for_freshly_created_profile(client: TestClient) -> None:
    """create_profile_api seeds a default SOUL.md on creation (best-effort,
    via hermes_cli.default_soul when importable) — this route must surface
    whatever ends up on disk for that profile, not assume it's empty."""
    _create_profile(client, "roundtrip-fresh")

    response = client.get("/api/wrapper/v1/agent-config/roundtrip-fresh/soul")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["profile"] == "roundtrip-fresh"
    assert isinstance(body["data"]["content"], str)


def test_update_soul_then_get_soul_roundtrips(client: TestClient) -> None:
    """The behavioral core of this feature: update an existing profile's
    identity after creation, then read the same content back."""
    _create_profile(client, "roundtrip-update")

    update_response = client.put(
        "/api/wrapper/v1/agent-config/roundtrip-update/soul",
        json={"content": "# Custom Soul\nI am a custom agent.\n"},
    )
    assert update_response.status_code == 200
    update_body = update_response.json()
    assert update_body["ok"] is True
    assert update_body["data"]["profile"] == "roundtrip-update"

    get_response = client.get("/api/wrapper/v1/agent-config/roundtrip-update/soul")
    assert get_response.status_code == 200
    get_body = get_response.json()
    assert get_body["data"]["content"] == "# Custom Soul\nI am a custom agent.\n"


def test_update_soul_overwrites_existing_content_unconditionally(client: TestClient) -> None:
    """No skip-if-exists guard — every PUT call replaces the prior
    content, proving this isn't accidentally a create-once seed."""
    _create_profile(client, "roundtrip-overwrite")

    client.put(
        "/api/wrapper/v1/agent-config/roundtrip-overwrite/soul",
        json={"content": "# First\n"},
    )
    second = client.put(
        "/api/wrapper/v1/agent-config/roundtrip-overwrite/soul",
        json={"content": "# Second\n"},
    )
    assert second.status_code == 200

    get_response = client.get("/api/wrapper/v1/agent-config/roundtrip-overwrite/soul")
    assert get_response.json()["data"]["content"] == "# Second\n"


def test_update_soul_is_native_not_proxied_through_dispatch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of api/v1/agent_config.py existing is to bypass
    dispatch()/FakeHandler for this feature — prove it, the same way
    test_onboarding.py proves it for its own native routes."""
    _create_profile(client, "roundtrip-native-check")

    def _fail_dispatch(*_args, **_kwargs):
        raise AssertionError("dispatch() must not be called for native agent-config routes")

    monkeypatch.setattr("hermes_webui_wrapper.app.dispatch", _fail_dispatch)

    response = client.get("/api/wrapper/v1/agent-config/roundtrip-native-check/soul")

    assert response.status_code == 200


def _configure_workspace(name: str, workspace_dir) -> None:
    """Write a `workspace` key into the profile's config.yaml — see
    service.py's module docstring: create_profile_api never sets one, so
    the AGENTS.md endpoints must fail closed until this is done."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    home = get_hermes_home_for_profile(name)
    config_path = home / "config.yaml"
    existing = {}
    if config_path.exists():
        existing = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    existing["workspace"] = str(workspace_dir)
    config_path.write_text(yaml.safe_dump(existing, sort_keys=False), encoding="utf-8")


def test_get_agent_instructions_without_configured_workspace_returns_400(
    client: TestClient,
) -> None:
    _create_profile(client, "agents-md-no-workspace")

    response = client.get("/api/wrapper/v1/agent-config/agents-md-no-workspace/agents-md")

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "agent_config_workspace_not_configured"


def test_update_agent_instructions_then_get_roundtrips(client: TestClient, tmp_path) -> None:
    _create_profile(client, "agents-md-roundtrip")
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()
    _configure_workspace("agents-md-roundtrip", workspace_dir)

    update_response = client.put(
        "/api/wrapper/v1/agent-config/agents-md-roundtrip/agents-md",
        json={"content": "# Custom instructions\n"},
    )
    assert update_response.status_code == 200, update_response.text
    assert update_response.json()["data"]["path"] == str(workspace_dir / "AGENTS.md")

    get_response = client.get("/api/wrapper/v1/agent-config/agents-md-roundtrip/agents-md")
    assert get_response.status_code == 200
    body = get_response.json()
    assert body["data"]["content"] == "# Custom instructions\n"
    assert body["data"]["workspace"] == str(workspace_dir)


def test_update_agent_instructions_missing_workspace_dir_returns_400(
    client: TestClient, tmp_path
) -> None:
    _create_profile(client, "agents-md-missing-dir")
    missing_dir = tmp_path / "does-not-exist-on-disk"
    _configure_workspace("agents-md-missing-dir", missing_dir)

    response = client.put(
        "/api/wrapper/v1/agent-config/agents-md-missing-dir/agents-md",
        json={"content": "# x\n"},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "agent_config_workspace_missing"


def test_update_soul_rejects_symlinked_target(client: TestClient, tmp_path) -> None:
    """Mirrors upstream's own memory-write symlink hardening
    (api/routes.py::_handle_memory_write) — a symlink planted at SOUL.md
    must not let a write clobber an arbitrary file outside the profile."""
    _create_profile(client, "roundtrip-symlink")

    from api.profiles import get_hermes_home_for_profile

    home = get_hermes_home_for_profile("roundtrip-symlink")
    soul_path = home / "SOUL.md"
    outside_target = tmp_path / "outside.txt"
    outside_target.write_text("do not touch\n", encoding="utf-8")
    soul_path.unlink(missing_ok=True)
    soul_path.symlink_to(outside_target)

    response = client.put(
        "/api/wrapper/v1/agent-config/roundtrip-symlink/soul",
        json={"content": "# Malicious\n"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "agent_config_symlink_rejected"
    assert outside_target.read_text(encoding="utf-8") == "do not touch\n"


def test_traversal_shaped_profile_name_returns_404_not_root_soul(
    client: TestClient,
) -> None:
    """Regression test for a bug in `_require_known_profile`: it was
    missing the `_PROFILE_ID_RE` pre-check that
    `agent_history/service.py`'s own version already has (see that
    module's `test_traversal_shaped_profile_name_returns_404`, which uses
    the same `%2e%2e` traversal-shaped name).
    `get_hermes_home_for_profile()` falls back to the BASE Hermes home for
    any name that isn't a valid profile id, so `home.is_dir()` alone
    (always true for the base home) would incorrectly accept the name and
    let a caller read/write the ROOT profile's own SOUL.md under a fake
    identity."""
    from api.profiles import get_hermes_home_for_profile

    root_home = get_hermes_home_for_profile("default")
    root_soul_path = root_home / "SOUL.md"
    original_root_soul = (
        root_soul_path.read_text(encoding="utf-8") if root_soul_path.exists() else None
    )

    get_response = client.get("/api/wrapper/v1/agent-config/%2e%2e/soul")

    assert get_response.status_code == 404
    get_body = get_response.json()
    assert get_body["ok"] is False
    assert get_body["error"]["code"] == "agent_config_profile_not_found"

    put_response = client.put(
        "/api/wrapper/v1/agent-config/%2e%2e/soul",
        json={"content": "# Malicious\n"},
    )

    assert put_response.status_code == 404
    put_body = put_response.json()
    assert put_body["ok"] is False
    assert put_body["error"]["code"] == "agent_config_profile_not_found"

    assert (
        root_soul_path.read_text(encoding="utf-8") if root_soul_path.exists() else None
    ) == original_root_soul
