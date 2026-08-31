"""Wrapper's own health endpoint. Reports wrapper identity only, never any
upstream request-handling state."""
from __future__ import annotations

from fastapi import APIRouter

from hermes_webui_wrapper.upstream import UpstreamInfo


def build_router(info: UpstreamInfo, service_name: str) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    def health() -> dict:
        return {
            "status": "ok",
            "service": service_name,
            "upstream_owner": info.owner,
            "upstream_revision": info.revision,
        }

    return router
