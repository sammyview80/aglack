"""A REAL MCP server, not a plain JSON-forwarding endpoint — this exists
because of a bug found live: the agent's own MCP client
(`/opt/hermes/tools/mcp_tool.py`) uses the real `mcp` Python SDK's
Streamable HTTP transport, which does full session negotiation over
`Mcp-Session-Id` and SSE, not a bare "POST JSON, get JSON back" request.
An earlier version of this wrapper's `/integrations/mcp` route was that
bare JSON endpoint; the agent's real client silently failed to connect to
it (`/reload-mcp` reported "No MCP servers connected" even though the
config entry was correct) — confirmed live, not assumed.

Built on `mcp.server.fastmcp.FastMCP` (the SDK's own high-level server,
the same one seeder_kit's `runner.py` uses for the stdio side) rather than
hand-rolling the wire protocol a second time. `stateless_http=True`: no
session needs to persist across requests for our use case (every call is
independent — see `service.relay_mcp_call`).

`build_mcp_app()` is a FACTORY, deliberately NOT a module-level singleton
— a second real bug found live: `FastMCP`'s `session_manager.run()` can
only be entered ONCE per `FastMCP` instance ("StreamableHTTPSessionManager
.run() can only be called once per instance"). `create_app()` (`app.py`)
can run more than once in the same process — every wrapper test does
exactly this, constructing a fresh app per test via `TestClient` — so a
shared module-level `FastMCP` object would work for the FIRST such call
and raise for every one after it (confirmed live: this broke ~78 existing
tests the moment it was a singleton). A fresh `FastMCP` (and therefore a
fresh, never-yet-run session manager) per `build_mcp_app()` call fixes
this for both tests and the one real call `create_app()` makes in
production.

Exposes only tools `mcp_proxy.rs`'s gateway-side allowlist permits
(`ALLOWED_TOOLS` in `rust_gateway/src/integrations/mcp_proxy.rs`) —
adding a tool here without also adding it to that allowlist would just
get every call to it rejected by the gateway, so the two lists must be
kept in sync by hand for now (no shared schema between the two
processes/languages). Currently: `list_connections`, `execute_action`,
`find_action` (added to fix agents guessing `execute_action` ids — see
`find_action`'s own doc comment below), and `search_connection` (an
in-memory substring filter over `list_connections`'s own result — see its
doc comment below).
"""
from __future__ import annotations

import functools
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable, Coroutine, TypeVar

import anyio
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette

from hermes_webui_wrapper.features.integrations.service import (
    IntegrationsError,
    relay_mcp_call,
)

_T = TypeVar("_T", bound=dict[str, Any])

# Connection fields `search_connection` substring-matches against — exactly
# the id/name/service triple its doc comment promises, nothing more.
#
# Deliberately NOT `connectionName`: the gateway (`mcp_proxy.rs`) strips any
# client-supplied `connectionName` and overwrites it with
# `workspace_connection_name(workspace_id)` (`ws-{workspace_id}`), and
# `route.rs` matches remote connections on that same single per-workspace
# value — so every connection `list_connections` returns for a workspace
# carries the SAME `connectionName`. Filtering on it would make any query
# that happens to hit the workspace id (e.g. "ws") match every connection,
# which is worse than useless for a search tool.
#
# Deliberately NOT `provider_id`/`providerId` either: those belong to the
# gateway's REST `ConnectionSummaryOut` (`GET /integrations/connections`),
# not to OpenConnector's MCP `list_connections` response this tool relays,
# so they never appear in the rows being filtered here.
_SEARCH_CONNECTION_FIELDS: tuple[str, ...] = (
    "id",
    "name",
    "service",
)


def _tool_error_boundary(
    fn: Callable[..., Coroutine[Any, Any, _T]]
) -> Callable[..., Coroutine[Any, Any, dict[str, Any]]]:
    """Wraps one `@mcp.tool()` body so a gateway-side failure surfaces to
    the calling agent as the SAME `{"ok": false, "error": {code, message}}`
    shape `_unwrap` already returns for an in-band gateway error, and that
    `backend/seeder/skills/org-integrations/SKILL.md` teaches agents to
    expect — rather than an uncaught `IntegrationsError` propagating up
    through FastMCP's own tool-call machinery as an opaque failure. After
    Bug WR-01's fix, `relay_mcp_call` raises `IntegrationsError` for every
    non-2xx gateway response, not just network failures, so every tool
    that calls it needs this same boundary; one shared decorator instead
    of repeating identical try/except in each of the 3 tool bodies below.
    """

    @functools.wraps(fn)
    async def wrapped(*args: Any, **kwargs: Any) -> dict[str, Any]:
        try:
            return await fn(*args, **kwargs)
        except IntegrationsError as exc:
            return {"ok": False, "error": {"code": exc.code, "message": exc.message}}

    return wrapped


def _unwrap(response: dict[str, Any]) -> dict[str, Any]:
    """`relay_mcp_call`'s return value is OpenConnector's own MCP
    `tools/call` response envelope (`{"result": {"structuredContent": ...}}`
    on success, `{"error": {...}}` on a transport-level failure — see
    `mcp_proxy.rs`'s own note that MCP errors come back as HTTP 200 with
    `ok:false` INSIDE the body). FastMCP tool functions return their
    result directly (it wraps that in ITS OWN `structuredContent` for the
    real client), so this unwraps one layer rather than double-nesting
    OpenConnector's response inside FastMCP's response inside the
    client's own parsing.
    """
    if "error" in response:
        return {"ok": False, "error": response["error"]}
    result = response.get("result", {})
    structured = result.get("structuredContent")
    if structured is not None:
        return structured
    return result


def build_mcp_app() -> tuple[Starlette, Callable[[], "AsyncIterator[None]"]]:
    """Returns `(asgi_app, lifespan)` — `app.py` mounts `asgi_app` at
    `/api/wrapper/v1/integrations` (its OWN default `streamable_http_path`
    of `/mcp` then supplies the exact final segment, giving the real URL
    `/api/wrapper/v1/integrations/mcp`) and enters `lifespan()` for the
    life of the process. A fresh, independent `FastMCP` instance every
    call — see this module's own doc comment for why that matters.

    Deliberately NOT `streamable_http_path="/"` mounted directly at the
    full `.../integrations/mcp` path — confirmed live this is a real,
    silent trap: a request to that exact path with no trailing slash does
    not match a `Mount` whose own sub-route is bare `/` (Starlette's
    mount-then-redirect-for-trailing-slash logic only fires when NO OTHER
    route in the app matches first) — it falls through to whatever
    catch-all route comes after the mount instead of ever reaching
    FastMCP, with no error indicating why. Mounting at the PARENT path
    and letting the sub-app supply a real, non-root leaf segment (`/mcp`)
    avoids the ambiguity entirely — this is the standard, documented way
    to mount a `FastMCP` app, not a workaround specific to this project.
    """
    mcp = FastMCP(name="integrations", stateless_http=True)

    @mcp.tool()
    @_tool_error_boundary
    async def list_connections(service: str | None = None) -> dict[str, Any]:
        """List this workspace's connected integration providers,
        optionally filtered to one provider's service id (e.g. "github")."""
        arguments: dict[str, Any] = {}
        if service:
            arguments["service"] = service
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "list_connections", "arguments": arguments},
        }
        response = await anyio.to_thread.run_sync(relay_mcp_call, body)
        return _unwrap(response)

    @mcp.tool()
    @_tool_error_boundary
    async def search_connection(query: str, limit: int = 20) -> dict[str, Any]:
        """Search this workspace's CONNECTED providers by case-insensitive
        substring match against each connection's id, name, and service,
        returning at most `limit` matches as `{"ok": true, "data": [...]}`.

        Searches only what `list_connections` returns for THIS workspace —
        a small set — never the full provider catalog (that is the
        gateway's separate `GET /integrations/catalog?search=` feature).
        It relays exactly one `list_connections` call and filters the
        result in memory here, so it stays fast regardless of how large
        `providers.yaml` or the catalog grows, and needs no caching or
        pagination of its own.
        """
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "list_connections", "arguments": {}},
        }
        response = await anyio.to_thread.run_sync(relay_mcp_call, body)
        listed = _unwrap(response)
        if listed.get("ok") is False:
            # A gateway/transport failure is a real failure — surface it
            # as-is rather than masking it as "zero matches".
            return listed

        connections = listed.get("data")
        if connections is None:
            connections = listed.get("connections", [])
        if not isinstance(connections, list):
            connections = []

        needle = query.strip().lower()
        # `limit <= 0` means "return nothing" — checked up front so the cap
        # is enforced BEFORE the first append, never after it (a `limit=0`
        # call previously returned one match because the append ran before
        # the length check).
        if not needle or limit <= 0:
            return {"ok": True, "data": []}

        matches: list[dict[str, Any]] = []
        for connection in connections:
            if len(matches) >= limit:
                break
            if not isinstance(connection, dict):
                continue
            haystack = [
                connection.get(key)
                for key in _SEARCH_CONNECTION_FIELDS
                if isinstance(connection.get(key), str)
            ]
            if any(needle in value.lower() for value in haystack):
                matches.append(connection)
        return {"ok": True, "data": matches}

    @mcp.tool()
    @_tool_error_boundary
    async def execute_action(
        action_id: str, input: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Execute one connected provider's action by id, e.g.
        `github.get_current_user`. `input` is the action's own argument
        object — consult the provider's action docs for its shape."""
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "execute_action",
                "arguments": {"actionId": action_id, "input": input or {}},
            },
        }
        response = await anyio.to_thread.run_sync(relay_mcp_call, body)
        return _unwrap(response)

    @mcp.tool()
    @_tool_error_boundary
    async def find_action(service: str, query: str, limit: int = 5) -> dict[str, Any]:
        """Single-call replacement for the first two steps of the
        `search_actions` -> `get_action_guide` -> `execute_action` flow
        documented in `backend/seeder/skills/org-integrations/SKILL.md`.

        WHY this exists: confirmed live this session, from real agent
        transcripts — agents repeatedly SKIP `search_actions`/
        `get_action_guide` and call `execute_action` with a GUESSED action
        id (e.g. `search_repositories` instead of the real
        `github.search_repositories`, or `github.list_repositories`, which
        doesn't exist at all), burning turns on `unknown_action`, and in
        observed cases giving up and using an unrelated method (web search)
        instead of the already-connected provider. Composio's own `search`
        CLI solves exactly this by returning the real tool slug AND its
        schema/pitfalls in ONE call — no separate "guess an id, get an
        error" step exists to skip. `find_action` mirrors that shape here:
        it calls OpenConnector's own `search_actions` (the real catalog
        match — 146 real GitHub actions with real descriptions, confirmed
        live; NOT a new matching engine built here) for `query`, then
        fetches `get_action_guide` for the top few hits so the caller gets
        a verified `service.action_name` id AND its input schema in one
        round trip — enough to call `execute_action` correctly without a
        second tool call.

        Note: at the time this tool was added, `search_actions` and
        `get_action_guide` were not yet separate FastMCP tools in this
        file (only `list_connections`/`execute_action` were) even though
        `mcp_proxy.rs`'s `ALLOWED_TOOLS` already listed them — so this
        calls OpenConnector's `search_actions`/`get_action_guide` methods
        directly via `relay_mcp_call`, following the exact same
        JSON-RPC-body-then-relay pattern `execute_action` above uses,
        rather than delegating to sibling tool functions that don't exist.

        Deliberately does NOT replace `search_actions`/`get_action_guide`
        as independently callable tools — both remain available for a
        caller that only needs one half of this. This tool is an additive
        reliability wrapper, never a new search implementation.
        """
        search_body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "search_actions",
                "arguments": {"service": service, "query": query, "limit": limit},
            },
        }
        search_response = await anyio.to_thread.run_sync(relay_mcp_call, search_body)
        search_result = _unwrap(search_response)
        if search_result.get("ok") is False:
            # A transport/gateway-level failure (see `_unwrap`) is a real
            # failure — surface it as-is rather than masking it as "zero
            # matches", which would send the caller straight back to
            # guessing an action id.
            return search_result

        candidates = search_result.get("data")
        if candidates is None:
            candidates = search_result.get("actions", [])
        if not isinstance(candidates, list):
            candidates = []

        if not candidates:
            # Zero matches is a legitimate, clean "no such action" signal —
            # not an error. The caller should try a different query or fall
            # back to its own non-provider method, not retry blindly.
            return {"ok": True, "data": []}

        # Only fetch a full guide (real input schema) for the top FEW
        # matches, never every hit `search_actions` returned:
        # `get_action_guide` is a second upstream round trip per action, so
        # enriching a long tail of low-relevance matches would multiply
        # upstream calls for no benefit to the caller, who only needs a
        # handful of well-ranked candidates to choose from. Capped at 3
        # regardless of the caller's own `limit` — a deliberate,
        # conservative bound, not tied 1:1 to how many matches exist.
        top_candidates = candidates[: min(limit, 3)]

        enriched: list[dict[str, Any]] = []
        for candidate in top_candidates:
            # The real, OpenConnector-returned id — NEVER reconstructed
            # from `service`/`query`/candidate name here. Reconstructing
            # this string is exactly the failure mode (`unknown_action`
            # from a guessed id) this tool exists to eliminate.
            action_id = (
                candidate.get("id")
                or candidate.get("action_id")
                or candidate.get("actionId")
            )
            if not action_id:
                # An unexpected candidate shape from OpenConnector must not
                # crash the whole call — skip it, keep the rest.
                continue

            guide_body = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "get_action_guide",
                    "arguments": {"actionId": action_id},
                },
            }
            guide_response = await anyio.to_thread.run_sync(relay_mcp_call, guide_body)
            guide_result = _unwrap(guide_response)
            guide_ok = guide_result.get("ok") is True

            enriched.append(
                {
                    "action_id": action_id,
                    "name": candidate.get("name"),
                    "description": candidate.get("description"),
                    "input_schema": guide_result.get("data", guide_result) if guide_ok else None,
                    "guide_error": None if guide_ok else guide_result.get("error"),
                }
            )

        return {"ok": True, "data": enriched}

    # `streamable_http_app()` must be called before `mcp.session_manager`
    # is ever accessed — the SDK creates the session manager lazily inside
    # that call ("Session manager can only be accessed after calling
    # streamable_http_app()", confirmed live).
    app = mcp.streamable_http_app()

    @asynccontextmanager
    async def lifespan() -> AsyncIterator[None]:
        """MUST be entered for the life of the process, or every request
        to the mounted MCP app hangs/fails — confirmed live: `app.mount(...)`
        alone does NOT start a mounted ASGI sub-app's own lifespan when the
        OUTER FastAPI app defines its own custom `lifespan=` (as `app.py`
        does, for `start_runtime`/`stop_runtime`) — a plain `Mount` does
        not automatically compose lifespans in that case, a real,
        well-known ASGI gotcha, not assumed from documentation alone.
        """
        async with mcp.session_manager.run():
            yield

    return app, lifespan
