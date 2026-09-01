"""Native onboarding endpoints — calls `features/onboarding/service.py`
directly instead of proxying through the catch-all stdlib-handler-emulation
route (see `service.py`'s module docstring for why this is the "optimized"
path for this specific feature).

Every upstream call is synchronous and potentially blocking (file I/O, a
live HTTP probe) — routed through `run_in_threadpool` so a slow call never
blocks the event loop for other requests/tenants.

Security note (deliberate, current scope — see `docs/onboarding.md`): these
routes have NO auth gate today, unlike upstream's own
`_onboarding_gate_allows` (which restricts unauthenticated setup/oauth/
complete/probe calls to local/private network origins). This wrapper has no
session/login layer yet at all (see rust_gateway's own "no auth yet"
checkpoint note) — adding a gate here ahead of that would be a false sense
of security, not a real one. Revisit this the moment any auth layer exists
in front of this service.
"""
from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from hermes_webui_wrapper.api.envelope import error, success
from hermes_webui_wrapper.features.onboarding import service
from hermes_webui_wrapper.features.onboarding.schemas import (
    ApplyOnboardingSetupRequest,
    ApplySelfHostedProviderSetupRequest,
    CancelOAuthFlowRequest,
    ProbeProviderRequest,
    StartOAuthFlowRequest,
)


async def _call(fn: Callable[..., Any], *args: Any) -> JSONResponse:
    """Run a blocking `features/onboarding/service.py` function in a
    threadpool (see that module's own docstring for why every call here
    must go through `run_in_threadpool`, never be awaited directly) and
    map the shared envelope: `service.OnboardingError` -> `error(...)`,
    anything else -> `success(data)`.

    Every route below except `probe` follows exactly this shape — `probe`
    stays hand-written (not routed through this helper) because
    `probe_provider_endpoint` never raises at all; its own `{"ok": bool,
    ...}` result IS the success data, not something this helper's
    exception-mapping has any role in (see the `probe` handler's own
    comment).
    """
    try:
        data = await run_in_threadpool(fn, *args)
    except service.OnboardingError as exc:
        return error(exc.code, exc.message, exc.status_code)
    return success(data)


def build_router() -> APIRouter:
    router = APIRouter(prefix="/onboarding", tags=["onboarding"])

    @router.get("/status")
    async def status():
        return await _call(service.get_status)

    @router.post("/setup")
    async def setup(body: ApplyOnboardingSetupRequest):
        return await _call(service.apply_setup, body.model_dump(exclude_none=True))

    @router.post("/setup/self-hosted")
    async def setup_self_hosted(body: ApplySelfHostedProviderSetupRequest):
        return await _call(service.apply_self_hosted_setup, body.model_dump(exclude_none=True))

    @router.post("/complete")
    async def complete():
        return await _call(service.complete)

    @router.post("/probe")
    async def probe(body: ProbeProviderRequest):
        data = await run_in_threadpool(
            service.probe_provider, body.provider, body.base_url, body.api_key
        )
        # probe_provider_endpoint never raises (see service.py) — it always
        # returns a dict with its own {"ok": bool, ...} shape. Pass it
        # through as `data` rather than re-mapping its internal `ok` onto
        # this envelope's `ok` — a probe that found the endpoint unreachable
        # is still a SUCCESSFUL probe call (this route did its job and
        # reported a result), not a wrapper-level error. NOT routed through
        # `_call` — there is no exception for it to map.
        return success(data)

    @router.post("/oauth/start")
    async def oauth_start(body: StartOAuthFlowRequest):
        return await _call(service.start_oauth_flow, body.provider)

    @router.get("/oauth/poll")
    async def oauth_poll(flow_id: str):
        return await _call(service.poll_oauth_flow, flow_id)

    @router.post("/oauth/cancel")
    async def oauth_cancel(body: CancelOAuthFlowRequest):
        return await _call(service.cancel_oauth_flow, body.flow_id, body.provider)

    return router
