"""Request/response models for the onboarding feature.

These describe the HTTP-facing shapes only — they are deliberately loose
(``dict[str, Any]`` for nested upstream payloads like ``system``/``setup``/
``workspaces``/``models``) because that structure is owned by upstream's
``api.onboarding.get_onboarding_status()`` and mirroring every nested field
here would duplicate a shape that already changes independently of this
wrapper. Top-level fields callers actually branch on (``completed``) are
typed; the rest passes through as opaque JSON.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class OnboardingStatus(BaseModel):
    """Mirrors upstream `get_onboarding_status()`'s return shape verbatim."""

    completed: bool
    settings: dict[str, Any]
    system: dict[str, Any]
    setup: dict[str, Any]
    workspaces: dict[str, Any]
    models: Any


class ApplyOnboardingSetupRequest(BaseModel):
    """Mirrors the body `apply_onboarding_setup` expects. All fields are
    optional at this layer — upstream's own function raises `ValueError`
    with a specific message for genuinely required-but-missing fields
    (e.g. "model is required"); duplicating that as pydantic-required
    fields here would produce a generic 422 instead of upstream's precise
    error message.
    """

    provider: str | None = None
    model: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    confirm_overwrite: bool | None = None


class ApplySelfHostedProviderSetupRequest(BaseModel):
    provider: str
    model: str
    api_key: str | None = None
    base_url: str | None = None
    activate: bool | None = None


class ProbeProviderRequest(BaseModel):
    provider: str | None = None
    base_url: str
    api_key: str | None = None


class StartOAuthFlowRequest(BaseModel):
    provider: str


class CancelOAuthFlowRequest(BaseModel):
    flow_id: str
    provider: str | None = None
