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

from hermes_webui_wrapper.features.errors import FeatureError


class OnboardingError(FeatureError):
    """This feature's `FeatureError` — see `features/errors.py`.
    `status_code` mirrors upstream `routes.py`'s own mapping for these
    exact endpoints (ValueError -> 400, RuntimeError -> 500,
    KeyError -> 404) rather than inventing a new one, so behavior stays
    identical to what the proxied catch-all route already did for these
    paths."""


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


# Upstream's onboarding catalog (`api/onboarding.py`'s `_SUPPORTED_PROVIDER_SETUPS`)
# advertises provider ids that `hermes_cli` (the thing that actually runs a
# turn) does not recognize — e.g. it offers "openai" and "x-ai" as onboarding
# choices, but `hermes_cli.auth.PROVIDER_REGISTRY` only knows them as
# "openai-api" and "xai". `apply_onboarding_setup` itself must keep using the
# *onboarding* id verbatim (it looks up env vars / key-presence via that same
# `_SUPPORTED_PROVIDER_SETUPS` table), so we let it run unmodified and only
# rewrite `model.provider` in config.yaml afterwards. Left uncorrected, a
# chat turn fails with `AuthError: Unknown provider 'openai'. Check 'hermes
# model' for available providers...`, which upstream's own chat surface
# reports to the user as a misleading "no API key found" message — sending
# them chasing a credential that was never the problem. `../upstream/` is
# read-only, so this wrapper is the right place to reconcile the two catalogs.
_ONBOARDING_TO_HERMES_CLI_PROVIDER = {
    "openai": "openai-api",
    "x-ai": "xai",
}


def _map_provider_id(onboarding_provider: str, registry) -> str:
    """Pure decision logic: map `onboarding_provider` to its `hermes_cli`
    registry id, if a mapping exists and the mapped id is present in
    `registry`. Otherwise return `onboarding_provider` unchanged (fail-soft
    guarantee — callers rely on this when `hermes_cli` is absent, e.g. the
    local dev/test venv, where the rewrite is a deliberate no-op).
    """
    mapped = _ONBOARDING_TO_HERMES_CLI_PROVIDER.get(onboarding_provider)
    if not mapped or mapped not in registry:
        return onboarding_provider
    return mapped


def _normalize_provider_in_config(config_path, onboarding_provider: str) -> None:
    """Best-effort: remap `onboarding_provider` to its `hermes_cli`-registry
    equivalent in `config_path`'s `model.provider`. Never raises — a missing
    `hermes_cli` import means we fail soft and leave the onboarding id as-is,
    rather than guess.
    """
    from pathlib import Path

    try:
        from hermes_cli.auth import PROVIDER_REGISTRY
    except ImportError:
        return

    mapped = _map_provider_id(onboarding_provider, PROVIDER_REGISTRY)
    if mapped == onboarding_provider:
        return

    from hermes_webui_wrapper.features.profile_yaml import (
        load_profile_config,
        save_profile_config,
    )

    path = Path(config_path)
    cfg = load_profile_config(path)
    model_cfg = cfg.get("model")
    if not isinstance(model_cfg, dict) or model_cfg.get("provider") != onboarding_provider:
        return
    model_cfg["provider"] = mapped
    save_profile_config(path, cfg)


def apply_setup(body: dict[str, Any]) -> dict[str, Any]:
    from api.onboarding import _get_config_path, apply_onboarding_setup

    result = _wrap("onboarding_setup_failed", apply_onboarding_setup, body)
    if isinstance(result, dict) and result.get("error") == "config_exists":
        return result
    onboarding_provider = str(body.get("provider") or "").strip().lower()
    _normalize_provider_in_config(_get_config_path(), onboarding_provider)
    return result


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
