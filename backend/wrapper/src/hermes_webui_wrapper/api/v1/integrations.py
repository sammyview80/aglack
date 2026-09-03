"""Native integrations endpoints — see
`features/integrations/service.py`'s module docstring for the design and
`../../../../../docs/integrations-plan.md` for the full architecture.

The actual MCP server for `/integrations/mcp` is NOT a route in this
router — it is a real ASGI sub-app (`features/integrations/mcp_server.py`)
mounted directly onto the FastAPI app in `app.py`, ahead of this router,
because the agent's real MCP client needs the actual Streamable HTTP
protocol (session negotiation, SSE), which a plain `APIRouter` route
cannot provide — see that module's own docstring for the bug this fixes
(confirmed live: a bare JSON route silently failed the agent's real
client handshake).

Security note (deliberate, current scope — mirrors every other native
route module's own note): see `features/errors.py`'s `NO_AUTH_GATE_NOTE`.
Revisit the moment any auth layer exists in front of this service.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from hermes_webui_wrapper.api.envelope import service_call
from hermes_webui_wrapper.features.integrations import service


class SetAgentEnabledRequest(BaseModel):
    enabled: bool


def build_router() -> APIRouter:
    router = APIRouter(prefix="/integrations", tags=["integrations"])

    @router.get("/agents")
    async def list_agent_enablement():
        return await service_call(service.list_agent_enablement)

    @router.put("/agents/{agent_slug}")
    async def set_agent_enabled(agent_slug: str, body: SetAgentEnabledRequest):
        return await service_call(service.set_agent_enabled, agent_slug, body.enabled)

    @router.post("/reload")
    async def reload():
        return await service_call(service.reload_mcp)

    return router
