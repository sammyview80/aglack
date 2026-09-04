"""Native slash-command endpoints — calls `features/commands/service.py`
directly instead of proxying through the catch-all stdlib-handler-emulation
route (see that module's docstring for the profile-binding rules: the
caller passes the target profile explicitly, and the service reproduces
the `set_request_profile`/`clear_request_profile` pair the proxied
dispatcher would otherwise derive from the `hermes_profile` cookie).

Wire param name is `agent` (query string on every route below, matching
`?agent=` everywhere else a frontend caller names a Hermes profile — chat,
and this route's own gateway proxy), never `profile` — this route never
reads the `hermes_profile` cookie itself (it's native FastAPI, not the
proxied dispatcher), so the gateway's cookie injection is a no-op for this
specific namespace; the wire name still has to match chat's convention so
one frontend client passes one consistent param everywhere. Internally
this stays named `profile` (clearer — it binds a Hermes *profile*).

Every handler goes through the shared `envelope.service_call` (threadpool
hop + FeatureError -> error-envelope mapping — see its own docstring).

Security note (deliberate, current scope — mirrors `api/v1/agent_seeder.py`'s
own note): see `features/errors.py`'s `NO_AUTH_GATE_NOTE`. `POST /exec` is
NOT read-only — it can trigger real agent-side runtime actions
(`reload-mcp`, `reload-skills`, `codex-runtime`, plus any plugin command)
for whichever profile the caller names, so treat it as the same
sensitivity class as agent-seeder's mutation routes. Revisit the moment
any auth layer exists in front of this service.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

from hermes_webui_wrapper.api.envelope import service_call
from hermes_webui_wrapper.features.commands import service
from hermes_webui_wrapper.features.commands.schemas import (
    ExecCommandRequest,
    ResolveBundleRequest,
)


def build_router() -> APIRouter:
    router = APIRouter(prefix="/commands", tags=["commands"])

    @router.get("")
    async def list_commands(agent: str | None = Query(default=None)):
        return await service_call(service.list_commands, agent)

    @router.get("/bundles")
    async def list_bundles(agent: str | None = Query(default=None)):
        return await service_call(service.list_bundles, agent)

    @router.get("/moa/resolve")
    async def resolve_moa(agent: str | None = Query(default=None)):
        return await service_call(service.resolve_moa, agent)

    @router.post("/bundles/resolve")
    async def resolve_bundle(body: ResolveBundleRequest):
        return await service_call(service.resolve_bundle, body.command, body.profile)

    @router.post("/exec")
    async def exec_command(body: ExecCommandRequest):
        return await service_call(service.exec_command, body.command, body.profile)

    return router
