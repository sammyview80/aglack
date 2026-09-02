"""Native onboarding endpoints — calls `features/onboarding/service.py`
directly instead of proxying through the catch-all stdlib-handler-emulation
route (see `service.py`'s module docstring for why this is the "optimized"
path for this specific feature).

Every upstream call is synchronous and potentially blocking (file I/O, a
live HTTP probe) — routed through `run_in_threadpool` so a slow call never
blocks the event loop for other requests/tenants.

Security note (deliberate, current scope — see `docs/onboarding.md`): see
`features/errors.py`'s `NO_AUTH_GATE_NOTE`, unlike upstream's own
`_onboarding_gate_allows` (which restricts unauthenticated setup/oauth/
complete/probe calls to local/private network origins) (see rust_gateway's
own "no auth yet" checkpoint note) — adding a gate here ahead of that would
be a false sense of security, not a real one. Revisit this the moment any
auth layer exists in front of this service.
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

from hermes_webui_wrapper.api.envelope import service_call, success
from hermes_webui_wrapper.features.onboarding import service
from hermes_webui_wrapper.features.onboarding.schemas import (
    ApplyOnboardingSetupRequest,
    ApplySelfHostedProviderSetupRequest,
    CancelOAuthFlowRequest,
    ProbeProviderRequest,
    StartOAuthFlowRequest,
)

# Every route below except `probe` goes through the shared
# `envelope.service_call` (threadpool hop + FeatureError -> error-envelope
# mapping — see its own docstring). `probe` stays hand-written because
# `probe_provider_endpoint` never raises at all; its own `{"ok": bool, ...}`
# result IS the success data, not something exception-mapping has any role
# in (see the `probe` handler's own comment).


def build_router() -> APIRouter:
    router = APIRouter(prefix="/onboarding", tags=["onboarding"])

    @router.get("/status")
    async def status():
        return await service_call(service.get_status)

    @router.post("/setup")
    async def setup(body: ApplyOnboardingSetupRequest):
        return await service_call(service.apply_setup, body.model_dump(exclude_none=True))

    @router.post("/setup/self-hosted")
    async def setup_self_hosted(body: ApplySelfHostedProviderSetupRequest):
        return await service_call(service.apply_self_hosted_setup, body.model_dump(exclude_none=True))

    @router.post("/complete")
    async def complete():
        return await service_call(service.complete)

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
        # `service_call` — there is no exception for it to map.
        return success(data)

    @router.post("/oauth/start")
    async def oauth_start(body: StartOAuthFlowRequest):
        return await service_call(service.start_oauth_flow, body.provider)

    @router.get("/oauth/poll")
    async def oauth_poll(flow_id: str):
        return await service_call(service.poll_oauth_flow, flow_id)

    @router.post("/oauth/cancel")
    async def oauth_cancel(body: CancelOAuthFlowRequest):
        return await service_call(service.cancel_oauth_flow, body.flow_id, body.provider)

    return router
