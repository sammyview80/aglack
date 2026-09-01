"""Onboarding feature service — calls upstream's `api.onboarding` /
`api.oauth` functions directly instead of routing through the catch-all
stdlib-handler-emulation proxy (`transport/dispatcher.py`).

Why this exists (the "optimized" path): every other upstream endpoint goes
through `app.py`'s catch-all route, which builds a `FakeHandler`, spins up a
worker thread per request, and replays upstream's raw `server.py` dispatch
logic. That path exists because upstream's handlers are written directly
against `BaseHTTPRequestHandler` (send_response/send_header/wfile...) and
can't be called any other way in general. But `api.onboarding`'s functions
(`get_onboarding_status`, `apply_onboarding_setup`, `probe_provider_endpoint`,
...) and `api.oauth`'s onboarding OAuth functions are plain functions that
take a dict and return a dict — no handler object involved at all. Calling
them directly from a native FastAPI route skips the FakeHandler/thread/
dispatch machinery entirely for this one feature.

Every function here is synchronous and potentially blocking (file I/O,
YAML parsing, a live HTTP probe in `probe_provider`) — callers in
`api/v1/onboarding.py` MUST run these via `fastapi.concurrency.run_in_threadpool`
rather than awaiting them directly, so a slow probe never blocks the event
loop for other tenants' requests.

As with `transport/dispatcher.py`, no upstream symbol is imported at module
import time — every function below imports `api.onboarding` / `api.oauth`
lazily, after `bootstrap_upstream()` has already run for this process (see
`upstream.py`).
"""
from __future__ import annotations

from typing import Any


class OnboardingError(Exception):
    """Raised for any onboarding failure this feature's routes must map to
    an HTTP error. `status_code` mirrors upstream `routes.py`'s own mapping
    for these exact endpoints (ValueError -> 400, RuntimeError -> 500,
    KeyError -> 404) rather than inventing a new one, so behavior stays
    identical to what the proxied catch-all route already did for these
    paths.
    """

    def __init__(self, code: str, message: str, status_code: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _wrap(code: str, fn, *args, **kwargs):
    """Call an upstream onboarding/oauth function, translating its plain
    ValueError/RuntimeError/KeyError into `OnboardingError` with the same
    status-code mapping `api/routes.py` already uses for these endpoints.
    """
    try:
        return fn(*args, **kwargs)
    except ValueError as exc:
        raise OnboardingError(code, str(exc), 400) from exc
    except KeyError as exc:
        raise OnboardingError(code, str(exc).strip("'\"") or "not found", 404) from exc
    except RuntimeError as exc:
        raise OnboardingError(code, str(exc), 500) from exc


def get_status() -> dict[str, Any]:
    from api.onboarding import get_onboarding_status

    return _wrap("onboarding_status_failed", get_onboarding_status)


def apply_setup(body: dict[str, Any]) -> dict[str, Any]:
    from api.onboarding import apply_onboarding_setup

    return _wrap("onboarding_setup_failed", apply_onboarding_setup, body)


def apply_self_hosted_setup(body: dict[str, Any]) -> dict[str, Any]:
    from api.onboarding import apply_self_hosted_provider_setup

    return _wrap("onboarding_self_hosted_setup_failed", apply_self_hosted_provider_setup, body)


def complete() -> dict[str, Any]:
    from api.onboarding import complete_onboarding

    return _wrap("onboarding_complete_failed", complete_onboarding)


def probe_provider(provider: str | None, base_url: str, api_key: str | None) -> dict[str, Any]:
    from api.onboarding import probe_provider_endpoint

    # probe_provider_endpoint itself never raises for a bad/unreachable
    # base_url — it returns {"ok": False, "error": ..., "detail": ...} — so
    # there is nothing for _wrap to translate here; call it directly.
    return probe_provider_endpoint(provider or "", base_url, api_key)


def start_oauth_flow(provider: str) -> dict[str, Any]:
    from api.oauth import start_onboarding_oauth_flow

    return _wrap("oauth_start_failed", start_onboarding_oauth_flow, {"provider": provider})


def poll_oauth_flow(flow_id: str) -> dict[str, Any]:
    from api.oauth import poll_onboarding_oauth_flow

    return _wrap("oauth_poll_failed", poll_onboarding_oauth_flow, flow_id)


def cancel_oauth_flow(flow_id: str, provider: str | None) -> dict[str, Any]:
    from api.oauth import cancel_onboarding_oauth_flow

    body = {"flow_id": flow_id, "provider": provider}
    return _wrap("oauth_cancel_failed", cancel_onboarding_oauth_flow, body)
