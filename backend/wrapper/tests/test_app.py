"""Behavioral tests for the FastAPI wrapper app: route precedence, wrapper
health endpoint, and real upstream passthrough for GET/OPTIONS."""
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


def test_wrapper_health_returns_identity_without_leaking_paths(client: TestClient) -> None:
    response = client.get("/api/wrapper/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "hermes-webui-wrapper"
    assert "upstream_owner" in body
    assert "upstream_revision" in body
    assert str(Path.home()) not in response.text
    assert "/Users/" not in response.text


def test_upstream_health_proxied_through_catch_all(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert "status" in response.json()


def test_unknown_path_returns_404_not_found(client: TestClient) -> None:
    response = client.get("/this-route-does-not-exist")

    assert response.status_code == 404
    assert response.json()["error"] == "not found"


def test_wrapper_route_takes_precedence_over_dispatch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _fail_dispatch(*_args, **_kwargs):
        raise AssertionError("dispatch() must not be called for wrapper's own routes")

    monkeypatch.setattr("hermes_webui_wrapper.app.dispatch", _fail_dispatch)

    response = client.get("/api/wrapper/v1/health")

    assert response.status_code == 200


def test_options_unknown_path_returns_cors_preflight_headers(client: TestClient) -> None:
    response = client.options(
        "/some/unknown/path",
        headers={"Origin": "http://testserver"},
    )

    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Methods"] == "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    assert response.headers["Access-Control-Allow-Headers"] == "Content-Type, Authorization"


def test_options_api_path_returns_cors_preflight_headers(client: TestClient) -> None:
    response = client.options(
        "/api/health/agent",
        headers={"Origin": "http://testserver"},
    )

    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Methods"] == "GET, POST, PUT, PATCH, DELETE, OPTIONS"
