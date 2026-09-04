"""Request models for the commands feature.

HTTP-facing shapes only. Response payloads (command/bundle catalogs, the
resolved MoA/bundle config) are owned by upstream's `api.commands` and pass
through as opaque JSON rather than being re-typed here (same reasoning as
`features/onboarding/schemas.py`).
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ResolveBundleRequest(BaseModel):
    """Body for `POST /commands/bundles/resolve`. `command` is deliberately
    not constrained beyond `str` — upstream's `resolve_bundle_command`
    raises its own ValueError for an empty/malformed command, which the
    service maps to a 400 with upstream's exact message (a pydantic
    constraint would produce a generic 422 instead).

    Wire field is `agent`, not `profile` — every other per-workspace proxy
    namespace (chat, and this route's own gateway proxy) uses `?agent=` as
    the caller-facing name (turned into the `hermes_profile` cookie for
    routes that read cookies); this route never reads that cookie itself
    (native FastAPI, not the proxied dispatcher — see service.py's own
    docstring), but the WIRE name still needs to match so a frontend
    caller sends one consistent param name everywhere. `model_config`'s
    `populate_by_name` lets the Python-side attribute stay `profile`
    (clearer internally — it binds a Hermes *profile*) while only the
    JSON key is renamed."""

    model_config = ConfigDict(populate_by_name=True)

    command: str
    profile: str | None = Field(default=None, alias="agent")


class ExecCommandRequest(BaseModel):
    """Body for `POST /commands/exec`. Same permissive `command` rule and
    `agent`-wire-name-for-`profile`-attribute rule as `ResolveBundleRequest`."""

    model_config = ConfigDict(populate_by_name=True)

    command: str
    profile: str | None = Field(default=None, alias="agent")
