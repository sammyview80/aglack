"""Behavioral tests for the native agent-history routes
(`api/v1/agent_history.py`) — exercises the real upstream `api.profiles`/
`api.models` functions against an isolated tmp HERMES_HOME (see
../conftest.py), not mocks. Sessions are built directly via upstream's own
`api.models.Session` (constructed with a `profile` tag and saved), which
mirrors how real per-agent sessions land on disk without requiring a live
chat turn through the catch-all proxy.
"""
from __future__ import annotations

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


def _make_session(profile: str, *, messages=None, last_message_at=None):
    from api.config import SESSION_DIR
    from api.models import Session

    SESSION_DIR.mkdir(parents=True, exist_ok=True)

    now = time.time()
    session = Session(
        profile=profile,
        title=f"session for {profile}",
        messages=messages or [{"role": "user", "content": "hi", "timestamp": now}],
    )
    session.save()
    if last_message_at is not None:
        session.updated_at = last_message_at
    return session


def test_list_agents_returns_created_profile(client: TestClient) -> None:
    _create_profile(client, "history-agent-one")

    response = client.get("/api/wrapper/v1/agent-history/agents")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    names = [agent["name"] for agent in body["data"]["agents"]]
    assert "history-agent-one" in names


def test_list_agents_reports_is_working_false_by_default(client: TestClient) -> None:
    _create_profile(client, "history-agent-idle")
    _make_session("history-agent-idle")

    response = client.get("/api/wrapper/v1/agent-history/agents")

    assert response.status_code == 200
    agents_by_name = {a["name"]: a for a in response.json()["data"]["agents"]}
    assert agents_by_name["history-agent-idle"]["is_working"] is False


def test_list_agents_reports_is_working_true_for_a_streaming_session(
    client: TestClient,
) -> None:
    """Sidebar busy-dot signal — the whole point of the `is_working` field
    added to `list_agents()`. Simulates a real in-flight turn the same way
    upstream itself detects one: a session with `active_stream_id` set,
    plus that same stream id present in the live `STREAMS` registry (see
    `_active_stream_ids()`/`_is_streaming_session()` in
    `api/models.py`) — not a fake/synthetic flag on the wrapper side."""
    from api.config import STREAMS, STREAMS_LOCK

    _create_profile(client, "history-agent-busy")
    _create_profile(client, "history-agent-idle-sibling")
    stream_id = "test-stream-history-agent-busy"
    session = _make_session("history-agent-busy")
    session.active_stream_id = stream_id
    session.save()
    _make_session("history-agent-idle-sibling")

    with STREAMS_LOCK:
        STREAMS[stream_id] = object()
    try:
        response = client.get("/api/wrapper/v1/agent-history/agents")
    finally:
        with STREAMS_LOCK:
            STREAMS.pop(stream_id, None)

    assert response.status_code == 200
    agents_by_name = {a["name"]: a for a in response.json()["data"]["agents"]}
    assert agents_by_name["history-agent-busy"]["is_working"] is True
    assert agents_by_name["history-agent-idle-sibling"]["is_working"] is False


def test_list_sessions_isolates_by_profile(client: TestClient) -> None:
    _create_profile(client, "history-agent-a")
    _create_profile(client, "history-agent-b")
    _make_session("history-agent-a")
    _make_session("history-agent-b")

    response = client.get("/api/wrapper/v1/agent-history/agents/history-agent-a/sessions")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    sessions = body["data"]["sessions"]
    assert len(sessions) == 1


def test_session_projection_is_exactly_five_keys(client: TestClient) -> None:
    _create_profile(client, "history-agent-projection")
    _make_session("history-agent-projection")

    response = client.get(
        "/api/wrapper/v1/agent-history/agents/history-agent-projection/sessions"
    )

    body = response.json()
    sessions = body["data"]["sessions"]
    assert len(sessions) == 1
    assert set(sessions[0].keys()) == {
        "session_id",
        "title",
        "message_count",
        "updated_at",
        "last_message_at",
    }


def test_sessions_limit_is_capped_at_200(client: TestClient) -> None:
    _create_profile(client, "history-agent-limit")

    response = client.get(
        "/api/wrapper/v1/agent-history/agents/history-agent-limit/sessions",
        params={"limit": 500},
    )

    assert response.status_code == 200
    assert response.json()["data"]["limit"] == 200


def test_sessions_negative_limit_returns_400(client: TestClient) -> None:
    _create_profile(client, "history-agent-neg-limit")

    response = client.get(
        "/api/wrapper/v1/agent-history/agents/history-agent-neg-limit/sessions",
        params={"limit": -1},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "agent_history_invalid_limit"


def test_sessions_negative_offset_returns_400(client: TestClient) -> None:
    _create_profile(client, "history-agent-neg-offset")

    response = client.get(
        "/api/wrapper/v1/agent-history/agents/history-agent-neg-offset/sessions",
        params={"offset": -1},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "agent_history_invalid_offset"


def test_messages_returns_projected_messages_for_valid_session(client: TestClient) -> None:
    _create_profile(client, "history-agent-msgs")
    session = _make_session(
        "history-agent-msgs",
        messages=[
            {"role": "user", "content": "hello", "timestamp": 1.0},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "hi "},
                    {"type": "text", "text": "there"},
                    {"type": "tool_use", "name": "whatever"},
                ],
                "timestamp": 2.0,
            },
        ],
    )

    response = client.get(
        f"/api/wrapper/v1/agent-history/agents/history-agent-msgs/sessions/{session.session_id}/messages"
    )

    assert response.status_code == 200
    body = response.json()["data"]
    assert body["total"] == 2
    assert body["messages"] == [
        {"role": "user", "content": "hello", "timestamp": 1.0},
        {"role": "assistant", "content": "hi there", "timestamp": 2.0},
    ]


def test_messages_404s_for_session_owned_by_different_agent(client: TestClient) -> None:
    _create_profile(client, "history-agent-owner")
    _create_profile(client, "history-agent-intruder")
    session = _make_session("history-agent-owner")

    response = client.get(
        f"/api/wrapper/v1/agent-history/agents/history-agent-intruder/sessions/{session.session_id}/messages"
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "agent_history_session_not_found"


def test_unknown_agent_returns_404_for_all_routes(client: TestClient) -> None:
    sessions_response = client.get(
        "/api/wrapper/v1/agent-history/agents/does-not-exist/sessions"
    )
    messages_response = client.get(
        "/api/wrapper/v1/agent-history/agents/does-not-exist/sessions/whatever/messages"
    )

    assert sessions_response.status_code == 404
    assert sessions_response.json()["error"]["code"] == "agent_history_profile_not_found"
    assert messages_response.status_code == 404
    assert messages_response.json()["error"]["code"] == "agent_history_profile_not_found"


def test_agent_history_is_native_not_proxied_through_dispatch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of api/v1/agent_history.py existing is to bypass
    dispatch()/FakeHandler for this feature — prove it, the same way
    test_agent_config.py proves it for its own native routes."""
    _create_profile(client, "history-agent-native-check")

    def _fail_dispatch(*_args, **_kwargs):
        raise AssertionError("dispatch() must not be called for native agent-history routes")

    monkeypatch.setattr("hermes_webui_wrapper.app.dispatch", _fail_dispatch)

    response = client.get("/api/wrapper/v1/agent-history/agents")

    assert response.status_code == 200


def test_invalid_profile_name_returns_404_not_200(client: TestClient) -> None:
    """`get_hermes_home_for_profile()` falls back to the BASE Hermes home for
    any name that isn't a valid profile id, so that home always exists on
    disk. Without validating the name shape first, `home.is_dir()` alone
    would incorrectly accept a bogus name as if it were the root profile."""
    response = client.get("/api/wrapper/v1/agent-history/agents/Not Valid!/sessions")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "agent_history_profile_not_found"


def test_traversal_shaped_profile_name_returns_404(client: TestClient) -> None:
    response = client.get(
        "/api/wrapper/v1/agent-history/agents/%2e%2e/sessions"
    )

    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "agent_history_profile_not_found"


def test_traversal_with_encoded_slash_never_reaches_feature_router(
    client: TestClient,
) -> None:
    # "..%2Fother" decodes to a path containing a slash, so it never matches
    # the /agents/{name}/sessions route; it falls through to the wrapper's
    # catch-all proxy, which returns the upstream's own unenveloped 404 body.
    response = client.get(
        "/api/wrapper/v1/agent-history/agents/..%2Fother/sessions"
    )

    assert response.status_code == 404


def test_malformed_limit_returns_enveloped_400(client: TestClient) -> None:
    _create_profile(client, "history-agent-bad-limit")

    response = client.get(
        "/api/wrapper/v1/agent-history/agents/history-agent-bad-limit/sessions",
        params={"limit": "bad"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "agent_history_invalid_limit"


def test_malformed_offset_returns_enveloped_400(client: TestClient) -> None:
    _create_profile(client, "history-agent-bad-offset")

    response = client.get(
        "/api/wrapper/v1/agent-history/agents/history-agent-bad-offset/sessions",
        params={"offset": "bad"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "agent_history_invalid_offset"


def test_list_sessions_title_and_count_unaffected_by_optimization(
    client: TestClient,
) -> None:
    """Skipping lineage enrichment must not change the projected fields
    state.db overrides still correct (title, message_count) for the
    5-key projection."""
    _create_profile(client, "history-agent-lineage-correctness")
    _make_session(
        "history-agent-lineage-correctness",
        messages=[
            {"role": "user", "content": "hello", "timestamp": time.time()},
            {"role": "assistant", "content": "hi there", "timestamp": time.time()},
        ],
    )

    response = client.get(
        "/api/wrapper/v1/agent-history/agents/history-agent-lineage-correctness/sessions"
    )

    assert response.status_code == 200
    sessions = response.json()["data"]["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["title"] == "session for history-agent-lineage-correctness"
    assert sessions[0]["message_count"] == 2
