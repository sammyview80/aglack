"""Native agent-history endpoints — per-agent (per-profile) chat history,
read-only. Calls `features/agent_history/service.py` directly instead of
proxying through the catch-all stdlib-handler-emulation route (see that
module's own docstring for the profile-matching/security rules).

Every handler goes through the shared `envelope.service_call` (threadpool
hop + FeatureError -> error-envelope mapping — see its own docstring).

Security note (deliberate, current scope — mirrors `api/v1/agent_config.py`'s
own note): see `features/errors.py`'s `NO_AUTH_GATE_NOTE`. Unlike the other
three route modules, these routes are read-only and never mutate
config.yaml/SOUL.md/AGENTS.md — but without a gate, any caller can still
read every agent's chat transcripts for the workspace, which is its own
exposure distinct from the shared note.
Revisit the moment any auth layer exists in front of this service.
"""
from __future__ import annotations

from fastapi import APIRouter

from hermes_webui_wrapper.api.envelope import service_call
from hermes_webui_wrapper.features.agent_history import service


def build_router() -> APIRouter:
    router = APIRouter(prefix="/agent-history", tags=["agent-history"])

    @router.get("/agents")
    async def list_agents():
        return await service_call(service.list_agents)

    @router.get("/agents/{name}/sessions")
    async def list_sessions(name: str, limit: str | None = None, offset: str | None = None):
        return await service_call(service.list_sessions, name, limit, offset)

    @router.get("/agents/{name}/sessions/{session_id}/messages")
    async def list_messages(
        name: str, session_id: str, limit: str | None = None, offset: str | None = None
    ):
        return await service_call(service.list_messages, name, session_id, limit, offset)

    return router
