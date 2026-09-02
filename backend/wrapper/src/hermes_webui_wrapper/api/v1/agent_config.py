"""Native agent-config endpoints — calls `features/agent_config/service.py`
directly instead of proxying through the catch-all stdlib-handler-emulation
route (see that module's own docstring for why, and for the current scope:
per-profile SOUL.md plus workspace-level AGENTS.md).

Every handler goes through the shared `envelope.service_call` (threadpool
hop + FeatureError -> error-envelope mapping — see its own docstring).

Security note (deliberate, current scope — mirrors `api/v1/onboarding.py`'s
own note): see `features/errors.py`'s `NO_AUTH_GATE_NOTE` — this module's
own routes carry no further feature-specific risk beyond that shared note.
Revisit the moment any auth layer exists in front of this service.
"""
from __future__ import annotations

from fastapi import APIRouter

from hermes_webui_wrapper.api.envelope import service_call
from hermes_webui_wrapper.features.agent_config import service
from hermes_webui_wrapper.features.agent_config.schemas import (
    UpdateAgentInstructionsRequest,
    UpdateSoulRequest,
)


def build_router() -> APIRouter:
    router = APIRouter(prefix="/agent-config", tags=["agent-config"])

    @router.get("/{name}/soul")
    async def get_soul(name: str):
        return await service_call(service.get_soul, name)

    @router.put("/{name}/soul")
    async def update_soul(name: str, body: UpdateSoulRequest):
        return await service_call(service.update_soul, name, body.content)

    @router.get("/{name}/agents-md")
    async def get_agent_instructions(name: str):
        return await service_call(service.get_agent_instructions, name)

    @router.put("/{name}/agents-md")
    async def update_agent_instructions(name: str, body: UpdateAgentInstructionsRequest):
        return await service_call(service.update_agent_instructions, name, body.content)

    return router
