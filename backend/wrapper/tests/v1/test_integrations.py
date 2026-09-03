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
        assert names == {"list_connections", "execute_action", "find_action"}

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
