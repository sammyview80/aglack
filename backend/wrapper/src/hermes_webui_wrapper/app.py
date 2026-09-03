"""ASGI application: FastAPI wrapper hosting the wrapper's own `/api/wrapper/v1`
namespace, with everything else proxied verbatim into the pinned upstream
stdlib request-handling code via the transport adapter.

No upstream source is imported at module import time (other than through the
lazy bootstrap path); `create_app()` resolves settings, bootstraps upstream
once, and wires the catch-all route last so the wrapper's own routes always
take precedence.
"""
from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse

from hermes_webui_wrapper.api.router import build_api_router
from hermes_webui_wrapper.config import Settings
from hermes_webui_wrapper.runtime import start_runtime, stop_runtime
from hermes_webui_wrapper.transport.dispatcher import UpstreamBindings, dispatch, load_bindings
from hermes_webui_wrapper.transport.handler import (
    FakeHandler,
    align_loopback_proxy_host,
    drain,
    headers_from_raw,
    normalize_buffered_body_headers,
)

_CATCH_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


def create_app(settings: Settings | None = None, runtime_enabled: bool | None = None) -> FastAPI:
    resolved_settings = settings if settings is not None else Settings.from_env()
    resolved_runtime_enabled = (
        runtime_enabled if runtime_enabled is not None else resolved_settings.runtime_enabled
    )

    bindings: UpstreamBindings = load_bindings(resolved_settings)

    # A real MCP server (not a plain FastAPI route) — see
    # features/integrations/mcp_server.py's module docstring for why: the
    # agent's own MCP client needs the actual Streamable HTTP protocol
    # (session negotiation, SSE), not bare JSON in/out. `build_mcp_app()`
    # is a factory (fresh `FastMCP` instance per `create_app()` call, NOT
    # a module-level singleton) — see that module's own doc comment for
    # the second real bug this works around: a shared session manager can
    # only be `.run()` once per instance, which broke every test the
    # moment `create_app()` ran more than once in the same process.
    from hermes_webui_wrapper.features.integrations.mcp_server import build_mcp_app

    mcp_app, mcp_lifespan = build_mcp_app()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # `mcp_lifespan()` MUST be entered for the mounted MCP sub-app
        # (below) to serve any request at all — see that function's own
        # doc comment for the real gotcha this works around. Wrapping the
        # existing start_runtime/stop_runtime pair inside it, not the
        # reverse; order between the two doesn't matter, only that both
        # run for the life of the process.
        async with mcp_lifespan():
            if resolved_runtime_enabled:
                start_runtime()
            try:
                yield
            finally:
                if resolved_runtime_enabled:
                    stop_runtime()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[resolved_settings.frontend_origin],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )
    app.include_router(build_api_router(bindings.info, resolved_settings.service_name))

    # Mounted at the PARENT path, not `.../integrations/mcp` directly —
    # see `build_mcp_app`'s own doc comment for the real trailing-slash
    # trap that mounting at the exact leaf path hits. Registered AFTER
    # `include_router` above (so `/agents` and `/reload`, already claimed
    # by that router, keep precedence over this catch-all-ish Mount) and
    # BEFORE the catch-all route below (so `/mcp` itself reaches FastMCP,
    # not the passthrough proxy).
    app.mount("/api/wrapper/v1/integrations", mcp_app)

    @app.api_route("/{full_path:path}", methods=_CATCH_ALL_METHODS)
    async def catch_all(request: Request, full_path: str) -> StreamingResponse:
        parsed = urlparse(f"/{full_path}?{request.url.query}" if request.url.query else f"/{full_path}")
        body = await request.body()
        headers_msg = headers_from_raw(request.headers.raw)
        normalize_buffered_body_headers(headers_msg, body)
        align_loopback_proxy_host(headers_msg)

        client_host, client_port = request.client or ("127.0.0.1", 0)
        client_address = (client_host, client_port)

        loop = asyncio.get_running_loop()
        handler = FakeHandler(
            loop=loop,
            method=request.method,
            path=request.url.path + (f"?{request.url.query}" if request.url.query else ""),
            headers=headers_msg,
            body=body,
            client_address=client_address,
            scheme=request.url.scheme,
        )

        def _run_dispatch() -> None:
            dispatch(handler, parsed, request.method, bindings)

        thread = threading.Thread(target=_run_dispatch, daemon=True)
        thread.start()

        await handler._headers_future

        status_code = handler._status_code or 200
        raw_headers = [
            (key.encode("latin-1"), value.encode("latin-1"))
            for key, value in handler._headers_list
        ]
        response = StreamingResponse(
            drain(handler),
            status_code=status_code,
        )
        response.raw_headers = raw_headers
        return response

    return app


app = create_app()
