"""Behavioral tests for the native onboarding routes
(`api/v1/onboarding.py`) — exercises the real upstream `api.onboarding`
functions against an isolated tmp HERMES_HOME (see ../conftest.py), not
mocks, so these prove the actual upstream integration works end to end.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hermes_webui_wrapper.app import create_app


@pytest.fixture()
def client() -> TestClient:
    app = create_app(runtime_enabled=False)
    with TestClient(app) as test_client:
        yield test_client


def test_status_returns_envelope_with_completed_flag(client: TestClient) -> None:
    response = client.get("/api/wrapper/v1/onboarding/status")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert "completed" in body["data"]
    assert "setup" in body["data"]
    assert "providers" in body["data"]["setup"]


def test_status_is_native_not_proxied_through_dispatch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of api/v1/onboarding.py existing is to bypass
    dispatch()/FakeHandler for this feature — prove it, the same way
    test_app.py proves it for the wrapper's own health route."""

    def _fail_dispatch(*_args, **_kwargs):
        raise AssertionError("dispatch() must not be called for native onboarding routes")

    monkeypatch.setattr("hermes_webui_wrapper.app.dispatch", _fail_dispatch)

    response = client.get("/api/wrapper/v1/onboarding/status")

    assert response.status_code == 200


def test_setup_with_missing_model_returns_400_error_envelope(client: TestClient) -> None:
    """Upstream's apply_onboarding_setup raises ValueError("model is
    required") for a supported provider with no model — service.py must
    map that to a 400 in this envelope, mirroring api/routes.py's own
    ValueError -> bad(handler, str(e)) (400) mapping for this exact
    endpoint."""
    response = client.post(
        "/api/wrapper/v1/onboarding/setup",
        json={"provider": "openrouter", "api_key": "sk-test-key"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "onboarding_setup_failed"
    assert "model" in body["error"]["message"]


def test_setup_with_unsupported_provider_marks_onboarding_complete(client: TestClient) -> None:
    """Upstream's apply_onboarding_setup treats an unsupported provider id
    as "already configured via the CLI" and just completes onboarding —
    not an error. Confirms service.py passes this through as a success,
    not accidentally converting it into an error."""
    response = client.post(
        "/api/wrapper/v1/onboarding/setup",
        json={"provider": "some-unsupported-provider-id", "model": "whatever"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["completed"] is True


def test_probe_unreachable_url_returns_success_envelope_with_ok_false_data(
    client: TestClient,
) -> None:
    """probe_provider_endpoint itself never raises for an unreachable
    base_url — it returns {"ok": False, "error": "..."} as DATA. This route
    call succeeded (200, envelope ok=true); the probe's own result inside
    `data` reports the actual reachability failure. Confirms these two
    "ok" concepts are not conflated (see api/v1/onboarding.py's `probe`
    docstring)."""
    response = client.post(
        "/api/wrapper/v1/onboarding/probe",
        json={"base_url": "http://127.0.0.1:1/nope", "provider": "custom"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["ok"] is False
    assert "error" in body["data"]


def test_oauth_poll_unknown_flow_id_returns_404_error_envelope(client: TestClient) -> None:
    """Upstream's poll_onboarding_oauth_flow raises KeyError("OAuth flow
    not found") for an unknown flow_id — service.py maps KeyError -> 404,
    mirroring api/routes.py's own mapping for this endpoint."""
    response = client.get(
        "/api/wrapper/v1/onboarding/oauth/poll", params={"flow_id": "does-not-exist"}
    )

    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "oauth_poll_failed"


def test_oauth_start_with_unsupported_provider_returns_400_error_envelope(
    client: TestClient,
) -> None:
    response = client.post(
        "/api/wrapper/v1/onboarding/oauth/start", json={"provider": "not-a-real-provider"}
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "oauth_start_failed"


def test_complete_marks_onboarding_completed(client: TestClient) -> None:
    response = client.post("/api/wrapper/v1/onboarding/complete")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["completed"] is True


def _written_provider(upstream_root: "Path") -> str:
    import os

    import yaml

    from api.onboarding import _get_config_path

    config_path = _get_config_path()
    return yaml.safe_load(Path(config_path).read_text(encoding="utf-8"))["model"]["provider"]


def _hermes_cli_importable() -> bool:
    try:
        import hermes_cli.auth  # noqa: F401
    except ImportError:
        return False
    return True


@pytest.mark.skipif(
    not _hermes_cli_importable(),
    reason=(
        "hermes_cli is not installed in this venv, so the registry-backed "
        "provider rewrite can only be verified where hermes_cli ships (the "
        "Docker image) — this is an environment limitation, not a disabled "
        "assertion. See test_map_provider_id_* for the pure-logic coverage."
    ),
)
def test_setup_with_onboarding_openai_id_writes_hermes_cli_registry_id(
    client: TestClient, upstream_root: "Path"
) -> None:
    """Upstream's onboarding catalog advertises the provider id "openai",
    but `hermes_cli.auth.PROVIDER_REGISTRY` (the thing that actually runs a
    turn) only knows it as "openai-api" — a config.yaml with "openai" makes
    every chat turn fail with `AuthError: Unknown provider 'openai'`, which
    surfaces to the user as a misleading "no API key found" message. Prove
    service.py rewrites it to the id `hermes_cli` actually accepts."""
    response = client.post(
        "/api/wrapper/v1/onboarding/setup",
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "api_key": "sk-test-key",
            "confirm_overwrite": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert _written_provider(upstream_root) == "openai-api"


def test_setup_with_already_valid_provider_is_passed_through_unchanged(
    client: TestClient, upstream_root: "Path"
) -> None:
    """A provider id already valid in both catalogs (e.g. "anthropic") must
    not be touched by the reconciliation helper."""
    response = client.post(
        "/api/wrapper/v1/onboarding/setup",
        json={
            "provider": "anthropic",
            "model": "claude-sonnet-4.6",
            "api_key": "sk-ant-test-key",
            "confirm_overwrite": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert _written_provider(upstream_root) == "anthropic"


def test_setup_with_unmapped_provider_is_passed_through_unchanged(
    client: TestClient, upstream_root: "Path"
) -> None:
    """"ollama" has no verified `hermes_cli` registry equivalent (only
    "ollama-cloud" exists, which is a different provider) — the
    reconciliation helper must not invent a mapping for it."""
    response = client.post(
        "/api/wrapper/v1/onboarding/setup",
        json={
            "provider": "ollama",
            "model": "qwen3:32b",
            "base_url": "http://localhost:11434/v1",
            "confirm_overwrite": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert _written_provider(upstream_root) == "ollama"


def test_map_provider_id_maps_openai_when_registry_has_openai_api() -> None:
    from hermes_webui_wrapper.features.onboarding.service import _map_provider_id

    assert _map_provider_id("openai", {"openai-api", "anthropic"}) == "openai-api"


def test_map_provider_id_leaves_openai_unchanged_when_registry_lacks_openai_api() -> None:
    from hermes_webui_wrapper.features.onboarding.service import _map_provider_id

    assert _map_provider_id("openai", {"anthropic"}) == "openai"


def test_map_provider_id_leaves_anthropic_and_ollama_unchanged() -> None:
    from hermes_webui_wrapper.features.onboarding.service import _map_provider_id

    registry = {"openai-api", "anthropic", "xai"}
    assert _map_provider_id("anthropic", registry) == "anthropic"
    assert _map_provider_id("ollama", registry) == "ollama"
