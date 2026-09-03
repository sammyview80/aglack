"""Integrations feature service — the wrapper's half of the tenancy
design in `../../../../../docs/integrations-plan.md` and
`../../../../../docs/integrations-poc-findings.md`.

Two independent jobs:

1. `relay_mcp_call` — the ONLY thing inside this container allowed to hold
   the workspace's integrations bearer. It reads the bearer from a file
   (never an env var, never `config.yaml` — see
   `config.resolve_integrations_token_path`'s doc comment) and forwards
   one already-formed JSON-RPC body to the gateway's
   `/workspaces/:id/mcp` tenancy proxy — which does ALL the sanitization
   (allowlist, connection-name stripping) on the gateway side (see
   `rust_gateway/src/integrations/mcp_proxy.rs`). This function does no
   sanitization of its own; it is a relay, not a second enforcement point.
2. `set_agent_enabled` — writes (or removes) the `mcp_servers.integrations`
   entry in one agent profile's `config.yaml`, using the exact same
   `mutate_profile_config` helper `agent_seeder/service.py` already uses
   for its own `mcp_servers` entry (see that module's `_apply_mcp_tools`)
   — same file-locking-free, load/mutate/save mechanics, not a second
   competing implementation.

Security note (mirrors every other native route module's own note — see
`features/errors.py`'s `NO_AUTH_GATE_NOTE`): these routes have no auth gate
today. `relay_mcp_call` additionally depends on
`INTEGRATIONS_WORKSPACE_ID`/`GATEWAY_INTERNAL_URL`/the token file existing
— none of which are wired by anything yet (see `config.py`'s doc comments
on those three resolvers) — so this function cannot succeed until task #4
(delivering the token file + these env vars into a real container) is
built. It is written and tested against that not-yet-existing wiring
now so task #4 has a working consumer to plug into, not a second thing to
design from scratch.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from hermes_webui_wrapper.features.errors import FeatureError
from hermes_webui_wrapper.features.profile_yaml import load_profile_config, mutate_profile_config

_MCP_SERVER_NAME = "integrations"


class IntegrationsError(FeatureError):
    """This feature's `FeatureError` — see `features/errors.py`."""


def _read_bearer(token_path: Path) -> str:
    try:
        bearer = token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise IntegrationsError(
            "integrations_token_missing",
            f"No integrations token at {token_path} — this workspace has no "
            "connected integrations yet, or the token has not been delivered "
            "into this container (see docs/integrations-plan.md, task #4).",
            409,
        ) from exc
    except OSError as exc:
        raise IntegrationsError(
            "integrations_token_unreadable", str(exc), 500
        ) from exc
    if not bearer:
        raise IntegrationsError(
            "integrations_token_empty",
            f"Integrations token file at {token_path} is empty.",
            500,
        )
    return bearer


def relay_mcp_call(body: dict[str, Any]) -> dict[str, Any]:
    """Forward one JSON-RPC request `body` to the gateway's tenancy proxy
    for THIS container's own workspace, using this container's own
    integrations bearer. Returns the parsed JSON response body verbatim —
    callers (the route layer) return it as-is, not re-wrapped in this
    wrapper's own envelope, since the gateway's proxy already speaks plain
    JSON-RPC and re-wrapping would break an MCP client's expectations.

    Deliberately does NOT catch or reinterpret the gateway's own error
    responses (e.g. `batch_not_allowed`, `tool_not_allowed`) — those are
    the gateway's sanitization surface (see `mcp_proxy.rs`), and this
    relay must not duplicate or second-guess that logic.
    """
    from hermes_webui_wrapper.config import (
        resolve_gateway_internal_url,
        resolve_integrations_token_path,
        resolve_integrations_workspace_id,
    )

    bearer = _read_bearer(resolve_integrations_token_path())
    gateway_url = resolve_gateway_internal_url()
    workspace_id = resolve_integrations_workspace_id()

    try:
        response = httpx.post(
            f"{gateway_url}/workspaces/{workspace_id}/mcp",
            json=body,
            headers={"Authorization": f"Bearer {bearer}"},
            timeout=30.0,
        )
    except httpx.HTTPError as exc:
        raise IntegrationsError(
            "integrations_gateway_unreachable", str(exc), 502
        ) from exc

    if response.status_code >= 400:
        # Non-2xx from the gateway is a real failure, not a JSON-RPC-shaped
        # payload to hand back verbatim — map its own `{"ok": false,
        # "error": {"code", "message"}}` envelope (see `rust_gateway/src/
        # response.rs`) when parseable, falling back to a generic code/
        # message for a non-JSON or differently-shaped error body (e.g. an
        # HTML error page from a proxy in front of the gateway).
        try:
            payload = response.json()
            err = payload.get("error") if isinstance(payload, dict) else None
        except ValueError:
            err = None
        if not isinstance(err, dict):
            err = {}
        raise IntegrationsError(
            err.get("code", "integrations_gateway_error"),
            err.get("message", f"Gateway returned HTTP {response.status_code}"),
            response.status_code,
        )

    try:
        return response.json()
    except ValueError as exc:
        raise IntegrationsError(
            "integrations_gateway_invalid_response",
            f"Gateway returned non-JSON body (status {response.status_code}): {exc}",
            502,
        ) from exc


def set_agent_enabled(agent_slug: str, enabled: bool) -> dict[str, Any]:
    """Flip the `mcp_servers.integrations.enabled` flag in one agent
    profile's `config.yaml`, WITHOUT touching any other agent's profile —
    the whole point of per-agent enable/disable (see
    docs/integrations-plan.md's "Enable/disable per agent" section). The
    entry's `url` always points at THIS container's own wrapper relay
    (`/api/wrapper/v1/integrations/mcp`), never at the gateway or
    OpenConnector directly — Hermes' MCP client only ever talks to this
    container's own loopback address for this server, matching the plan's
    "container never dials OpenConnector directly" rule.
    """
    from api.profiles import get_hermes_home_for_profile

    profile_home = get_hermes_home_for_profile(agent_slug)
    if not profile_home.is_dir():
        raise IntegrationsError(
            "integrations_profile_not_found",
            f"No profile {agent_slug!r} exists yet.",
            404,
        )

    config_path = profile_home / "config.yaml"

    def _set_entry(cfg: dict) -> None:
        mcp_servers = cfg.setdefault("mcp_servers", {})
        mcp_servers[_MCP_SERVER_NAME] = {
            "url": "http://127.0.0.1:8787/api/wrapper/v1/integrations/mcp",
            "enabled": enabled,
        }

    try:
        mutate_profile_config(config_path, _set_entry)
    except ValueError as exc:
        raise IntegrationsError("integrations_config_unreadable", str(exc), 500) from exc
    except OSError as exc:
        raise IntegrationsError("integrations_config_write_failed", str(exc), 500) from exc

    return {"agent_slug": agent_slug, "enabled": enabled}


def list_agent_enablement() -> list[dict[str, Any]]:
    """Every profile in this container and whether its
    `mcp_servers.integrations.enabled` flag is currently set — the read
    counterpart to `set_agent_enabled`, so a frontend reloading the page
    does not lose the toggle state it just set (see
    `api/v1/integrations.py`'s `GET /agents` route and
    `frontend/src/features/integrations/hooks/use-agent-integrations.ts`,
    the one caller). A profile with no `config.yaml` yet, or none whose
    `mcp_servers` has an `integrations` entry, reports `enabled: False` —
    never toggled is the same observable state as explicitly disabled.

    Deliberately does NOT use upstream's `list_profiles_api()` — that
    function's own docstring says its result is "cached for a short TTL"
    and "busted on profile create/delete", but a profile created through
    the wrapper's `/api/profile/create` catch-all route (a different code
    path than upstream's own create handler) was confirmed live to NOT
    reliably bust that cache: querying `list_profiles_api()` immediately
    after creating a profile returned only the pre-existing `default` row,
    missing the one just created. Rather than depend on a cache-busting
    contract this wrapper does not fully control, this scans the
    filesystem directly: `<HERMES_HOME>` itself is the `default` profile's
    home, and `<HERMES_HOME>/profiles/<name>/` holds every other profile
    (see `get_hermes_home_for_profile`'s own resolution rule) — the same
    ground truth `get_hermes_home_for_profile` itself reads from, so this
    can never disagree with it.
    """
    from api.profiles import get_hermes_home_for_profile

    default_home = get_hermes_home_for_profile("default")
    names = ["default"]
    profiles_dir = default_home / "profiles"
    if profiles_dir.is_dir():
        names.extend(sorted(p.name for p in profiles_dir.iterdir() if p.is_dir()))

    result: list[dict[str, Any]] = []
    for name in names:
        config_path = get_hermes_home_for_profile(name) / "config.yaml"
        try:
            config = load_profile_config(config_path)
        except ValueError:
            # Corrupt config.yaml for this one profile must not fail the
            # whole listing for every other profile — report it as
            # disabled (fail safe: never claim a broken profile has
            # integrations enabled) rather than raising.
            config = {}
        entry = config.get("mcp_servers", {}).get(_MCP_SERVER_NAME, {})
        result.append({"agent_slug": name, "enabled": bool(entry.get("enabled", False))})
    return result


def reload_mcp() -> dict[str, Any]:
    """Trigger upstream's real MCP reconnect path via the SAME allowlisted
    command dispatch a user's `/reload-mcp` chat command goes through
    (`api.commands.execute_agent_command`) — NOT by importing
    `tools.mcp_tool` directly, per the corrected design in
    `docs/integrations-plan.md`'s wrapper contract (a Codex review finding
    against an earlier draft that called the internal functions directly).
    """
    from api.commands import execute_agent_command

    try:
        summary = execute_agent_command("reload-mcp")
    except KeyError as exc:
        raise IntegrationsError("integrations_reload_unsupported", str(exc), 500) from exc
    except RuntimeError as exc:
        raise IntegrationsError("integrations_reload_failed", str(exc), 500) from exc

    return {"summary": summary}
