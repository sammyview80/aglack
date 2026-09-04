"""Behavioral tests for the native integrations routes
(`api/v1/integrations.py`) — exercises the real upstream `api.profiles`
functions against an isolated tmp HERMES_HOME (see ../conftest.py), not
mocks, matching `test_agent_config.py`'s convention.

`relay_mcp_call`'s success path needs a real gateway + real container
token file + `INTEGRATIONS_WORKSPACE_ID`/`GATEWAY_INTERNAL_URL` — none of
which exist in this test process (see `features/integrations/service.py`'s
module docstring: task #4 is not built yet). What IS tested here is every
failure mode that fires before those would even matter: a missing token
file, and each config resolver's own fail-closed behavior. The real
gateway round-trip is covered live in task #6's end-to-end pass, not here.
"""
from __future__ import annotations

import os
import time

import pytest
from fastapi.testclient import TestClient

from hermes_webui_wrapper.app import create_app


@pytest.fixture()
def client() -> TestClient:
    app = create_app(runtime_enabled=False)
    with TestClient(app) as test_client:
        yield test_client


def _create_profile(client: TestClient, name: str) -> None:
    response = client.post("/api/profile/create", json={"name": name})
    assert response.status_code == 200, response.text


def test_set_agent_enabled_unknown_profile_returns_404(client: TestClient) -> None:
    response = client.put(
        "/api/wrapper/v1/integrations/agents/does-not-exist", json={"enabled": True}
    )

    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "integrations_profile_not_found"


def test_set_agent_enabled_writes_mcp_servers_entry_for_that_profile_only(
    client: TestClient,
) -> None:
    from api.profiles import get_hermes_home_for_profile

    _create_profile(client, "writer-enable-test")
    _create_profile(client, "pm-untouched-test")

    response = client.put(
        "/api/wrapper/v1/integrations/agents/writer-enable-test", json={"enabled": True}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["data"] == {"agent_slug": "writer-enable-test", "enabled": True}

    import yaml

    writer_config = yaml.safe_load(
        (get_hermes_home_for_profile("writer-enable-test") / "config.yaml").read_text(
            encoding="utf-8"
        )
    )
    assert writer_config["mcp_servers"]["integrations"]["enabled"] is True
    assert (
        writer_config["mcp_servers"]["integrations"]["url"]
        == "http://127.0.0.1:8787/api/wrapper/v1/integrations/mcp"
    )

    # The other agent's profile must be completely untouched — this is the
    # whole point of per-agent enable/disable (docs/integrations-plan.md's
    # "Enable/disable per agent" section). A fresh profile may not even
    # have a config.yaml yet (mutate_profile_config treats a missing file
    # as `{}` — see profile_yaml.py) — the real assertion is just that
    # THIS route never created or touched one for it.
    pm_config_path = get_hermes_home_for_profile("pm-untouched-test") / "config.yaml"
    if pm_config_path.exists():
        pm_config = yaml.safe_load(pm_config_path.read_text(encoding="utf-8")) or {}
        assert "integrations" not in pm_config.get("mcp_servers", {})


def test_set_agent_enabled_false_after_true_disables_without_removing_entry(
    client: TestClient,
) -> None:
    from api.profiles import get_hermes_home_for_profile

    _create_profile(client, "writer-disable-test")
    client.put(
        "/api/wrapper/v1/integrations/agents/writer-disable-test", json={"enabled": True}
    )

    response = client.put(
        "/api/wrapper/v1/integrations/agents/writer-disable-test", json={"enabled": False}
    )
    assert response.status_code == 200
    assert response.json()["data"] == {
        "agent_slug": "writer-disable-test",
        "enabled": False,
    }

    import yaml

    config = yaml.safe_load(
        (get_hermes_home_for_profile("writer-disable-test") / "config.yaml").read_text(
            encoding="utf-8"
        )
    )
    assert config["mcp_servers"]["integrations"]["enabled"] is False


def test_list_agent_enablement_reflects_set_agent_enabled_and_defaults_false(
    client: TestClient,
) -> None:
    _create_profile(client, "list-enablement-a")
    _create_profile(client, "list-enablement-b")
    client.put(
        "/api/wrapper/v1/integrations/agents/list-enablement-a", json={"enabled": True}
    )

    response = client.get("/api/wrapper/v1/integrations/agents")
    assert response.status_code == 200, response.text
    by_slug = {row["agent_slug"]: row["enabled"] for row in response.json()["data"]}

    assert by_slug["list-enablement-a"] is True
    # Never toggled -> reports False, not absent and not a crash.
    assert by_slug["list-enablement-b"] is False


class TestMcpServer:
    """The real MCP server (`features/integrations/mcp_server.py`), tested
    with the ACTUAL `mcp` SDK client — not a bare `client.post(...)` (a
    plain JSON POST no longer applies here at all: this endpoint is a
    mounted Streamable HTTP ASGI app with real session negotiation, and a
    naive request against it 404s/violates the protocol — see this
    module's history for the bug this replaces). A real `uvicorn` server
    on a real socket is required because the `mcp` SDK's client only
    speaks real HTTP, not an in-process ASGI transport.
    """

    @pytest.fixture()
    def server_url(self):
        import socket
        import threading

        import uvicorn

        from hermes_webui_wrapper.app import create_app

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]

        app = create_app(runtime_enabled=False)
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        try:
            for _ in range(200):
                if server.started:
                    break
                time.sleep(0.01)
            assert server.started, "uvicorn server did not start in time"
            yield f"http://127.0.0.1:{port}/api/wrapper/v1/integrations/mcp"
        finally:
            server.should_exit = True
            thread.join(timeout=5)

    @pytest.mark.anyio
    async def test_real_mcp_client_lists_the_allowlisted_tools(self, server_url) -> None:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()

        names = {tool.name for tool in tools.tools}
        # `open_browser`/`close_browser` are deliberately NOT here — they
        # live as per-agent stdio tool modules in `backend/seeder/tools/`
        # (see `mcp_server.py`'s module docstring).
        assert names == {
            "list_connections",
            "execute_action",
            "find_action",
            "search_connection",
        }

    @pytest.mark.anyio
    async def test_search_connection_filters_list_connections_by_substring(
        self, server_url, monkeypatch
    ) -> None:
        """Proves `search_connection` relays exactly ONE `list_connections`
        call (never a new listing method) and filters its result in memory,
        case-insensitively, across id/name/service, honoring `limit`."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        captured_bodies = []
        connections = [
            {"id": "c1", "service": "github", "connectionName": "ws-1", "configured": True},
            {"id": "c2", "service": "slack", "connectionName": "ws-1", "configured": True},
            {"id": "c3", "service": "gitlab", "name": "GitLab", "configured": True},
        ]

        def fake_relay_mcp_call(body):
            captured_bodies.append(body)
            return {"result": {"structuredContent": {"ok": True, "data": connections}}}

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                all_git = await session.call_tool("search_connection", {"query": "GIT"})
                capped = await session.call_tool(
                    "search_connection", {"query": "git", "limit": 1}
                )
                none = await session.call_tool("search_connection", {"query": "jira"})

        assert all_git.structuredContent == {
            "ok": True,
            "data": [connections[0], connections[2]],
        }
        assert capped.structuredContent == {"ok": True, "data": [connections[0]]}
        assert none.structuredContent == {"ok": True, "data": []}
        assert len(captured_bodies) == 3
        assert all(body["params"]["name"] == "list_connections" for body in captured_bodies)

    @pytest.mark.anyio
    async def test_search_connection_surfaces_gateway_error_not_empty_result(
        self, server_url, monkeypatch
    ) -> None:
        """A transport-level `list_connections` failure must come back as
        the `{"ok": false, "error": ...}` envelope, never as "no matches"."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        def fake_relay_mcp_call(body):
            return {"error": {"code": -32000, "message": "upstream down"}}

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool("search_connection", {"query": "git"})

        assert result.structuredContent == {
            "ok": False,
            "error": {"code": -32000, "message": "upstream down"},
        }

    @pytest.mark.anyio
    async def test_search_connection_limit_zero_or_negative_returns_no_matches(
        self, server_url, monkeypatch
    ) -> None:
        """`limit=0` (and any negative limit) must return ZERO matches. The
        original loop appended a match BEFORE checking the cap, so `limit=0`
        wrongly returned one row; this pins the corrected behaviour."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        connections = [
            {"id": "c1", "service": "github", "connectionName": "ws-1", "configured": True},
            {"id": "c3", "service": "gitlab", "name": "GitLab", "configured": True},
        ]

        def fake_relay_mcp_call(body):
            return {"result": {"structuredContent": {"ok": True, "data": connections}}}

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                zero = await session.call_tool(
                    "search_connection", {"query": "git", "limit": 0}
                )
                negative = await session.call_tool(
                    "search_connection", {"query": "git", "limit": -3}
                )
                two = await session.call_tool(
                    "search_connection", {"query": "git", "limit": 2}
                )

        assert zero.structuredContent == {"ok": True, "data": []}
        assert negative.structuredContent == {"ok": True, "data": []}
        assert two.structuredContent == {"ok": True, "data": connections}

    @pytest.mark.anyio
    async def test_search_connection_ignores_workspace_level_connection_name(
        self, server_url, monkeypatch
    ) -> None:
        """`connectionName` is the gateway-forced per-WORKSPACE name
        (`ws-{workspace_id}`, identical on every connection in the listing),
        so it must NOT be a search field — otherwise a query matching the
        workspace id would return every connection."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        connections = [
            {"id": "c1", "service": "github", "connectionName": "ws-1", "configured": True},
            {"id": "c2", "service": "slack", "connectionName": "ws-1", "configured": True},
        ]

        def fake_relay_mcp_call(body):
            return {"result": {"structuredContent": {"ok": True, "data": connections}}}

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool("search_connection", {"query": "ws-1"})

        assert result.structuredContent == {"ok": True, "data": []}

    @pytest.mark.anyio
    async def test_real_mcp_client_calls_execute_action_through_the_real_relay(
        self, server_url, monkeypatch
    ) -> None:
        """Proves the full real path a real MCP client actually exercises:
        `tools/call` -> FastMCP's own protocol handling -> our
        `execute_action` tool function -> `relay_mcp_call` (mocked here so
        this test needs no real gateway/OpenConnector/network — that full
        chain is verified separately, live, against real infrastructure)."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        captured_bodies = []

        def fake_relay_mcp_call(body):
            captured_bodies.append(body)
            return {
                "result": {
                    "structuredContent": {"ok": True, "data": {"login": "octocat"}}
                }
            }

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "execute_action",
                    {"action_id": "github.get_current_user", "input": {}},
                )

        assert result.structuredContent == {"ok": True, "data": {"login": "octocat"}}
        assert captured_bodies[0]["params"]["name"] == "execute_action"
        assert captured_bodies[0]["params"]["arguments"] == {
            "actionId": "github.get_current_user",
            "input": {},
        }


    @pytest.mark.anyio
    async def test_execute_action_converts_integrations_error_to_clean_envelope(
        self, server_url, monkeypatch
    ) -> None:
        """Bug WR-03 (part 2): once `relay_mcp_call` raises `IntegrationsError`
        (Bug WR-01's fix — any non-2xx gateway response), the tool call must
        not surface an opaque/uncaught failure through FastMCP — it must
        return the same `{"ok": false, "error": {"code", "message"}}` shape
        `SKILL.md` teaches agents to expect."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        from hermes_webui_wrapper.features.integrations.service import IntegrationsError

        def fake_relay_mcp_call(body):
            raise IntegrationsError("tool_not_allowed", "action not permitted", 403)

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "execute_action",
                    {"action_id": "github.get_current_user", "input": {}},
                )

        assert result.structuredContent == {
            "ok": False,
            "error": {"code": "tool_not_allowed", "message": "action not permitted"},
        }
        assert not result.isError

    @pytest.mark.anyio
    async def test_find_action_merges_search_and_guide_for_top_candidates(
        self, server_url, monkeypatch
    ) -> None:
        """Proves `find_action` calls OpenConnector's `search_actions` then
        `get_action_guide` for the top hit and returns a merged result with
        the real (never-reconstructed) action id and its input schema — the
        whole point of the tool (see its own doc comment in
        `mcp_server.py`)."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        captured_bodies = []

        def fake_relay_mcp_call(body):
            captured_bodies.append(body)
            tool_name = body["params"]["name"]
            if tool_name == "search_actions":
                return {
                    "result": {
                        "structuredContent": {
                            "ok": True,
                            "data": [
                                {
                                    "id": "github.search_repositories",
                                    "name": "Search repositories",
                                    "description": "Search GitHub repositories.",
                                }
                            ],
                        }
                    }
                }
            assert tool_name == "get_action_guide"
            assert body["params"]["arguments"]["actionId"] == "github.search_repositories"
            return {
                "result": {
                    "structuredContent": {
                        "ok": True,
                        "data": {"type": "object", "properties": {"query": {"type": "string"}}},
                    }
                }
            }

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "find_action", {"service": "github", "query": "search repos"}
                )

        assert result.structuredContent["ok"] is True
        [action] = result.structuredContent["data"]
        assert action["action_id"] == "github.search_repositories"
        assert action["input_schema"] == {
            "type": "object",
            "properties": {"query": {"type": "string"}},
        }
        assert captured_bodies[0]["params"]["name"] == "search_actions"
        assert captured_bodies[1]["params"]["name"] == "get_action_guide"

    @pytest.mark.anyio
    async def test_find_action_treats_guide_result_missing_ok_key_as_failure(
        self, server_url, monkeypatch
    ) -> None:
        """Bug WR-03 (part 1): a `get_action_guide` result with NO `ok` key
        at all (some error shape other than `{"ok": False, ...}`) must be
        treated as a guide failure — never defaulted to success just
        because the key is absent."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        def fake_relay_mcp_call(body):
            tool_name = body["params"]["name"]
            if tool_name == "search_actions":
                return {
                    "result": {
                        "structuredContent": {
                            "ok": True,
                            "data": [
                                {
                                    "id": "github.search_repositories",
                                    "name": "Search repositories",
                                    "description": "Search GitHub repositories.",
                                }
                            ],
                        }
                    }
                }
            assert tool_name == "get_action_guide"
            # No "ok" key at all — neither True nor False.
            return {"result": {"structuredContent": {"weird_shape": True}}}

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "find_action", {"service": "github", "query": "search repos"}
                )

        [action] = result.structuredContent["data"]
        assert action["input_schema"] is None
        # guide_result has no "error" key either — guide_error surfaces
        # whatever's there (None here), the key assertion is input_schema
        # being None instead of the raw {"weird_shape": True} dict.
        assert action["guide_error"] is None

    @pytest.mark.anyio
    async def test_find_action_returns_clean_empty_result_on_zero_matches(
        self, server_url, monkeypatch
    ) -> None:
        """Zero matches from `search_actions` is a legitimate signal, not an
        error — this proves `find_action` short-circuits without ever
        calling `get_action_guide`."""
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        captured_bodies = []

        def fake_relay_mcp_call(body):
            captured_bodies.append(body)
            return {"result": {"structuredContent": {"ok": True, "data": []}}}

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.mcp_server.relay_mcp_call",
            fake_relay_mcp_call,
        )

        async with streamablehttp_client(server_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "find_action", {"service": "github", "query": "no such thing"}
                )

        assert result.structuredContent == {"ok": True, "data": []}
        assert len(captured_bodies) == 1
        assert captured_bodies[0]["params"]["name"] == "search_actions"


class TestBrowserServiceUnit:
    """Direct unit tests of `features/browser/service.py`'s gateway-calling
    functions — mirrors `TestRelayMcpCallStatusCodeHandling`'s own pattern
    (real resolvers wired via env vars, `httpx.post` mocked as the one
    genuinely external call). This module is the wrapper-side REFERENCE
    for the call shape `backend/seeder/tools/open_browser.py`/
    `close_browser.py` re-implement standalone in their own per-agent
    stdio subprocess (see that service module's docstring for why the
    agent-facing tools no longer live on the HTTP MCP server at all).
    """

    @pytest.fixture()
    def _wired_browser(self, tmp_path, monkeypatch):
        token_path = tmp_path / "integrations.token"
        token_path.write_text("test-bearer", encoding="utf-8")
        monkeypatch.setenv("INTEGRATIONS_TOKEN_PATH", str(token_path))
        monkeypatch.setenv("GATEWAY_INTERNAL_URL", "http://gateway.internal.test")
        monkeypatch.setenv("INTEGRATIONS_WORKSPACE_ID", "ws-test")

    def test_call_browser_route_posts_to_the_expected_gateway_url_with_bearer(
        self, _wired_browser, monkeypatch
    ) -> None:
        import httpx

        from hermes_webui_wrapper.features.browser.service import _call_browser_route

        captured = {}

        def fake_post(url, headers, timeout):
            captured["url"] = url
            captured["headers"] = headers
            content = b'{"cdp_port": 9222}'
            return httpx.Response(200, content=content, request=httpx.Request("POST", url))

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.browser.service.httpx.post", fake_post
        )

        result = _call_browser_route("agent-42", "start")

        assert (
            captured["url"]
            == "http://gateway.internal.test/workspaces/ws-test/browser/agent-42/start"
        )
        assert captured["headers"]["Authorization"] == "Bearer test-bearer"
        assert result == {"cdp_port": 9222}

    def test_cdp_url_from_status_is_a_loopback_address(self) -> None:
        """`cdp_url` points at `127.0.0.1:<port>` — reachable from the SAME
        container the calling agent's own tool-execution context runs in
        (see `_cdp_url_from_status`'s own doc comment) — never any
        gateway-routed address; absent port -> None."""
        from hermes_webui_wrapper.features.browser.service import _cdp_url_from_status

        assert _cdp_url_from_status({"cdp_port": 9333, "status": "running"}) == "http://127.0.0.1:9333"
        assert _cdp_url_from_status({"port": 9222}) == "http://127.0.0.1:9222"
        assert _cdp_url_from_status({"cdpPort": 9111}) == "http://127.0.0.1:9111"
        assert _cdp_url_from_status({"status": "stopped"}) is None

    def test_non_2xx_gateway_response_raises_browser_error_with_mapped_code(
        self, _wired_browser, monkeypatch
    ) -> None:
        import httpx

        from hermes_webui_wrapper.features.browser.service import (
            BrowserError,
            _call_browser_route,
        )

        def fake_post(url, headers, timeout):
            content = b'{"ok": false, "error": {"code": "invalid_bearer", "message": "bad token"}}'
            return httpx.Response(401, content=content, request=httpx.Request("POST", url))

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.browser.service.httpx.post", fake_post
        )

        with pytest.raises(BrowserError) as excinfo:
            _call_browser_route("agent-1", "start")

        assert excinfo.value.code == "invalid_bearer"
        assert excinfo.value.message == "bad token"
        assert excinfo.value.status_code == 401

    def test_non_json_gateway_error_body_still_raises_browser_error_with_status(
        self, _wired_browser, monkeypatch
    ) -> None:
        import httpx

        from hermes_webui_wrapper.features.browser.service import (
            BrowserError,
            _call_browser_route,
        )

        def fake_post(url, headers, timeout):
            return httpx.Response(
                502, content=b"<html>bad gateway</html>", request=httpx.Request("POST", url)
            )

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.browser.service.httpx.post", fake_post
        )

        with pytest.raises(BrowserError) as excinfo:
            _call_browser_route("agent-1", "stop")

        assert excinfo.value.status_code == 502
        assert excinfo.value.code == "browser_gateway_error"


class TestRelayMcpCallStatusCodeHandling:
    """Bug WR-01: `relay_mcp_call` must raise `IntegrationsError` for ANY
    non-2xx gateway response, mapping the gateway's own `{"ok": false,
    "error": {"code", "message"}}` envelope when the body parses as that
    shape, and falling back to a generic code/the raw status code
    otherwise. `httpx.post` (the genuinely external call to the gateway)
    is mocked here — everything else (token file, env resolvers) is real,
    matching this module's own convention.
    """

    @pytest.fixture()
    def _wired_relay(self, tmp_path, monkeypatch):
        """Wires every resolver `relay_mcp_call` needs so the only unknown
        left is the gateway's own HTTP response, which each test mocks."""
        token_path = tmp_path / "integrations.token"
        token_path.write_text("test-bearer", encoding="utf-8")
        monkeypatch.setenv("INTEGRATIONS_TOKEN_PATH", str(token_path))
        monkeypatch.setenv("GATEWAY_INTERNAL_URL", "http://gateway.internal.test")
        monkeypatch.setenv("INTEGRATIONS_WORKSPACE_ID", "ws-test")

    @pytest.mark.parametrize(
        "status_code,json_body,expected_code,expected_message",
        [
            (
                401,
                {"ok": False, "error": {"code": "invalid_bearer", "message": "bad token"}},
                "invalid_bearer",
                "bad token",
            ),
            (
                403,
                {"ok": False, "error": {"code": "tool_not_allowed", "message": "nope"}},
                "tool_not_allowed",
                "nope",
            ),
            (429, None, "integrations_gateway_error", "Gateway returned HTTP 429"),
            (502, None, "integrations_gateway_error", "Gateway returned HTTP 502"),
            (500, None, "integrations_gateway_error", "Gateway returned HTTP 500"),
            (
                400,
                {"error": "just a string not a dict"},
                "integrations_gateway_error",
                "Gateway returned HTTP 400",
            ),
        ],
    )
    def test_non_2xx_raises_integrations_error_with_mapped_or_fallback_code(
        self,
        _wired_relay,
        monkeypatch,
        status_code,
        json_body,
        expected_code,
        expected_message,
    ):
        import httpx

        from hermes_webui_wrapper.features.integrations.service import (
            IntegrationsError,
            relay_mcp_call,
        )

        def fake_post(url, json, headers, timeout):
            if json_body is not None:
                content = __import__("json").dumps(json_body).encode()
                return httpx.Response(status_code, content=content, request=httpx.Request("POST", url))
            # Non-JSON body — e.g. an HTML error page from a proxy, or an
            # empty body for a bare 429/502.
            return httpx.Response(
                status_code, content=b"<html>error</html>", request=httpx.Request("POST", url)
            )

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.service.httpx.post", fake_post
        )

        with pytest.raises(IntegrationsError) as excinfo:
            relay_mcp_call({"jsonrpc": "2.0", "id": 1, "method": "tools/call"})

        assert excinfo.value.code == expected_code
        assert excinfo.value.message == expected_message
        assert excinfo.value.status_code == status_code

    def test_2xx_response_still_returns_parsed_json_unaffected(
        self, _wired_relay, monkeypatch
    ):
        import httpx

        from hermes_webui_wrapper.features.integrations.service import relay_mcp_call

        def fake_post(url, json, headers, timeout):
            content = b'{"result": {"structuredContent": {"ok": true}}}'
            return httpx.Response(200, content=content, request=httpx.Request("POST", url))

        monkeypatch.setattr(
            "hermes_webui_wrapper.features.integrations.service.httpx.post", fake_post
        )

        result = relay_mcp_call({"jsonrpc": "2.0", "id": 1, "method": "tools/call"})
        assert result == {"result": {"structuredContent": {"ok": True}}}


def test_reload_reports_a_clean_error_when_mcp_runtime_is_unavailable(
    client: TestClient,
) -> None:
    """`tools.mcp_tool` (the real MCP client registry) lives in the AGENT
    process, not this wrapper's test environment — see
    `docs/integrations-poc-findings.md`. This proves the failure surfaces
    as a normal envelope error, not an unhandled import crash; the real
    success path is exercised live in task #6, against a real agent
    process with two profiles (one enabled, one disabled) to confirm the
    process-global MCP registry does not leak tools between them — a risk
    flagged, not yet verified, per this feature's service module docstring.
    """
    response = client.post("/api/wrapper/v1/integrations/reload")

    assert response.status_code in (200, 500)
    body = response.json()
    if response.status_code == 500:
        assert body["ok"] is False
        assert body["error"]["code"] == "integrations_reload_failed"
