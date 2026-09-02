"""Native agent-seeder endpoints — calls `features/agent_seeder/service.py`
directly (see that module's own docstring for the full `seeder/` tree
contract, mode scoping, and what applying it does).

Route shape: `mode` is a required path segment
(`/agent-seeder/{mode}/apply`, not a query param or a default) — it names
which `seeder/modes/<mode>/` tree to apply, matching how `agent_name` is
already a path segment on the single-agent variant. `GET /agent-seeder/modes`
lists which modes actually exist on disk, for a caller (e.g. the
frontend's mode-select screen) that wants to confirm before offering a
mode as a real, clickable choice rather than hardcoding a mode list on
both ends.

Every handler goes through the shared `envelope.service_call` (threadpool
hop + FeatureError -> error-envelope mapping — see its own docstring).

Security note (deliberate, current scope — mirrors `api/v1/onboarding.py`'s
own note): see `features/errors.py`'s `NO_AUTH_GATE_NOTE`. This is also a
provisioning action with real side effects (creates profiles, writes
config.yaml/SOUL.md/AGENTS.md) — revisit the moment any auth layer exists
in front of this service, before exposing it beyond local/trusted use.
"""
from __future__ import annotations

from fastapi import APIRouter

from hermes_webui_wrapper.api.envelope import service_call
from hermes_webui_wrapper.features.agent_seeder import service


def build_router() -> APIRouter:
    router = APIRouter(prefix="/agent-seeder", tags=["agent-seeder"])

    @router.get("/modes")
    async def list_modes():
        return await service_call(service.list_modes)

    @router.post("/{mode}/apply")
    async def apply_all(mode: str):
        return await service_call(service.apply_all, mode)

    @router.post("/{mode}/apply/{agent_name}")
    async def apply_one(mode: str, agent_name: str):
        return await service_call(service.apply_one, mode, agent_name)

    return router
