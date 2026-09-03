"""Wrapper settings, resolved from the environment. No pydantic dependency."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}

# Must match the pin recorded in ../UPSTREAM.md. Updating the pin requires
# updating both this default and UPSTREAM.md together (see that file's
# "Safely updating the pinned commit" procedure).
_DEFAULT_EXPECTED_UPSTREAM_REVISION = "e168b67e4278df618d1cab61fdb3a8dc55b29a81"


def _parse_bool(value: str, *, default: bool) -> bool:
    normalized = value.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    return default


def _wrapper_project_root() -> Path:
    # This file lives at <wrapper>/src/hermes_webui_wrapper/config.py in an
    # installed source checkout, so the wrapper project root is three
    # parents up. The ONE place this path arithmetic exists — every
    # sibling-directory default (upstream/, seeder/) derives from here
    # rather than re-counting parents from its own file location.
    return Path(__file__).resolve().parents[2]


def _default_upstream_root() -> Path:
    return (_wrapper_project_root().parent / "upstream").resolve()


def resolve_seeder_root() -> Path:
    """The seeder CONTENT tree (`backend/seeder/` — see its README.md).

    `HERMES_SEEDER_ROOT` overrides; the default is the umbrella's sibling
    `seeder/` directory next to `upstream/` (the exact layout both the
    source checkout and the workspace Docker image use — see
    `backend/workspace-image/Dockerfile`). A module-level function rather
    than a `Settings` field because its one consumer
    (`features/agent_seeder/service.py`) resolves it lazily per request —
    `Settings.from_env()` requires `HERMES_FRONTEND_ORIGIN` and constructing
    a full Settings just to get one path would couple seeding to unrelated
    required config.
    """
    override = os.environ.get("HERMES_SEEDER_ROOT")
    if override:
        return Path(override).resolve()
    return (_wrapper_project_root().parent / "seeder").resolve()


def resolve_agent_workspaces_root() -> Path:
    """The parent directory every seeded agent gets its own
    `<root>/<agent-slug>/` workspace under (e.g. `/workspace/pm`,
    `/workspace/writer`, sibling of the default profile's own
    `/workspace/default`) — see `features/agent_seeder/service.py`'s
    `_ensure_agent_workspace`, the one caller.

    Derived from `HERMES_WEBUI_DEFAULT_WORKSPACE`'s own parent directory
    — that env var is what the real workspace container's boot script
    sets to `/workspace/default` (see
    `rust_gateway/src/workspaces/container/boot_script.rs`, built from
    the gateway's own required `WORKSPACE_DEFAULT_PATH`) — rather than a
    second, independently-hardcoded `/workspace` default here, so this
    always agrees with wherever the container's default workspace
    actually lives.

    Fails closed (raises `RuntimeError`) when that env var is unset —
    matches this project's existing convention for required
    container-provided config (see `Settings.from_env()`'s
    `HERMES_FRONTEND_ORIGIN` check for the same pattern) rather than
    silently guessing a path outside a real container.
    """
    default_workspace = os.environ.get("HERMES_WEBUI_DEFAULT_WORKSPACE", "").strip()
    if not default_workspace:
        raise RuntimeError(
            "HERMES_WEBUI_DEFAULT_WORKSPACE is not set — this is set automatically "
            "by the workspace container's boot script (see "
            "rust_gateway/src/workspaces/container/boot_script.rs); set it yourself "
            "for local/standalone wrapper dev if you need per-agent workspace "
            "directories to be created outside a real container."
        )
    return Path(default_workspace).resolve().parent


def resolve_integrations_token_path() -> Path:
    """Where this container's OpenConnector-tenancy bearer lives on disk —
    see `../../../../docs/integrations-plan.md`'s security model and
    `../../../../docs/integrations-poc-findings.md`. Written by the
    gateway via `docker cp` (see `rust_gateway/src/workspaces/container/`,
    task #4 — not yet wired as of this function's introduction), never by
    this process. `INTEGRATIONS_TOKEN_PATH` overrides for local dev; the
    real container default matches the plan's `/run/hermes/integrations.token`.
    """
    override = os.environ.get("INTEGRATIONS_TOKEN_PATH", "").strip()
    if override:
        return Path(override)
    return Path("/run/hermes/integrations.token")


def resolve_gateway_internal_url() -> str:
    """Base URL this container dials to reach the gateway's own
    `/workspaces/:id/mcp` tenancy proxy (see
    `features/integrations/service.py`'s `relay_mcp_call`) — NOT the
    reverse: containers never dial OpenConnector directly. Fails closed
    like `resolve_agent_workspaces_root()` — a missing value here means a
    misconfigured container, not a sensible default to guess.
    """
    value = os.environ.get("GATEWAY_INTERNAL_URL", "").strip()
    if not value:
        raise RuntimeError(
            "GATEWAY_INTERNAL_URL is not set — required for the integrations "
            "MCP relay (features/integrations/service.py) to reach the "
            "gateway's tenancy proxy. Set it to the gateway's address as "
            "reachable FROM INSIDE this container (e.g. "
            "http://host.docker.internal:<gateway-port> on macOS/Windows, "
            "or the host's real address on Linux — see "
            "docs/integrations-plan.md's infra section)."
        )
    return value.rstrip("/")


def resolve_integrations_workspace_id() -> str:
    """This container's OWN workspace id, needed to call
    `GATEWAY_INTERNAL_URL/workspaces/<id>/mcp` — the gateway's tenancy
    proxy is keyed by workspace id in the URL path, and nothing inside a
    container knows its own workspace id today (see boot_script.rs's env
    vars — no `WORKSPACE_ID` among them as of this function's
    introduction). Task #4 (delivering the integrations token into a real
    container) must also thread this through the boot script. Fails
    closed rather than silently guessing or omitting the path segment.
    """
    value = os.environ.get("INTEGRATIONS_WORKSPACE_ID", "").strip()
    if not value:
        raise RuntimeError(
            "INTEGRATIONS_WORKSPACE_ID is not set — this container does not "
            "yet know its own workspace id. See config.py's "
            "resolve_integrations_workspace_id docstring: the gateway's boot "
            "script must set this (not yet wired as of this function's "
            "introduction — see docs/integrations-plan.md, task #4)."
        )
    return value


@dataclass(frozen=True)
class Settings:
    upstream_root: Path
    runtime_enabled: bool
    frontend_origin: str
    service_name: str = "hermes-webui-wrapper"
    upstream_owner: str = "hermes-webui"
    expected_upstream_revision: str = _DEFAULT_EXPECTED_UPSTREAM_REVISION

    @classmethod
    def from_env(cls) -> "Settings":
        upstream_override = os.environ.get("HERMES_WEBUI_UPSTREAM")
        upstream_root = (
            Path(upstream_override).resolve()
            if upstream_override
            else _default_upstream_root()
        )
        runtime_enabled = _parse_bool(
            os.environ.get("HERMES_WRAPPER_RUNTIME_ENABLED", "true"),
            default=True,
        )
        expected_upstream_revision = os.environ.get(
            "HERMES_WEBUI_UPSTREAM_REVISION", _DEFAULT_EXPECTED_UPSTREAM_REVISION
        ).strip()
        frontend_origin = os.environ.get("HERMES_FRONTEND_ORIGIN", "").strip()
        if not frontend_origin:
            raise RuntimeError(
                "HERMES_FRONTEND_ORIGIN is not set — copy backend/wrapper/.env.example "
                "to .env (must match the Vite origin, e.g. http://localhost:5173)"
            )
        return cls(
            upstream_root=upstream_root,
            runtime_enabled=runtime_enabled,
            frontend_origin=frontend_origin,
            expected_upstream_revision=expected_upstream_revision,
        )
