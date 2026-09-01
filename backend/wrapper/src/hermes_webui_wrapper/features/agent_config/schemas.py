"""Request/response models for the agent-config feature (updating a named
profile's SOUL.md and workspace-level AGENTS.md after creation — see
`service.py`'s module docstring for the current scope and why AGENTS.md is
workspace-level, not profile-level, in this checkout)."""
from __future__ import annotations

from pydantic import BaseModel


class UpdateSoulRequest(BaseModel):
    content: str


class UpdateAgentInstructionsRequest(BaseModel):
    content: str
