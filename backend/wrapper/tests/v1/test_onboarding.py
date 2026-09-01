"""Behavioral tests for the native onboarding routes
(`api/v1/onboarding.py`) — exercises the real upstream `api.onboarding`
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
