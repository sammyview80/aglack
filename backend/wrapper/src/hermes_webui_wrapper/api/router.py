"""Assembles the wrapper's own `/api/wrapper/v1` namespace. Nothing here
touches upstream request-handling; this router only exists so the wrapper
can expose its own identity/health surface alongside the proxied upstream
routes."""
from __future__ import annotations

from fastapi import APIRouter

from hermes_webui_wrapper.api.v1 import system
from hermes_webui_wrapper.upstream import UpstreamInfo


def build_api_router(info: UpstreamInfo, service_name: str) -> APIRouter:
    router = APIRouter(prefix="/api/wrapper/v1")
    router.include_router(system.build_router(info, service_name))
    return router
