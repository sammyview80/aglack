"""Assembles the wrapper's own `/api/wrapper/v1` namespace. Nothing here
touches upstream request-handling directly; native routes call into
`features/*/service.py`, which itself calls upstream's `api.*` functions
lazily (post-bootstrap) — see `api/v1/onboarding.py` for the pattern new
feature routers should follow."""
from __future__ import annotations

from fastapi import APIRouter

from hermes_webui_wrapper.api.v1 import agent_config, agent_seeder, onboarding, system
from hermes_webui_wrapper.upstream import UpstreamInfo


def build_api_router(info: UpstreamInfo, service_name: str) -> APIRouter:
    router = APIRouter(prefix="/api/wrapper/v1")
    router.include_router(system.build_router(info, service_name))
    router.include_router(onboarding.build_router())
    router.include_router(agent_config.build_router())
    router.include_router(agent_seeder.build_router())
    return router
