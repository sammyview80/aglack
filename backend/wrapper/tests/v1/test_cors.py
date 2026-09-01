"""CORS on native /api/wrapper/v1/* routes — same proof rust_gateway's
app.rs tests use: preflight OPTIONS and a real GET both carry
Access-Control-Allow-Origin for the configured frontend origin.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from hermes_webui_wrapper.app import create_app
from hermes_webui_wrapper.config import Settings


def _app_for_origin(origin: str):
    base = Settings.from_env()
    return create_app(
        settings=Settings(
            upstream_root=base.upstream_root,
            runtime_enabled=False,
            frontend_origin=origin,
            expected_upstream_revision=base.expected_upstream_revision,
        ),
        runtime_enabled=False,
    )


def test_preflight_from_configured_frontend_origin_is_allowed() -> None:
    origin = "http://localhost:5173"
    with TestClient(_app_for_origin(origin)) as client:
        response = client.options(
            "/api/wrapper/v1/onboarding/setup",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

    assert response.status_code == 200
    allow_origin = response.headers.get("access-control-allow-origin")
    assert allow_origin == origin


def test_get_response_from_configured_frontend_origin_carries_cors_header() -> None:
    origin = "http://localhost:5173"
    with TestClient(_app_for_origin(origin)) as client:
        response = client.get(
            "/api/wrapper/v1/onboarding/status",
            headers={"Origin": origin},
        )

    assert response.status_code == 200
    allow_origin = response.headers.get("access-control-allow-origin")
    assert allow_origin == origin
