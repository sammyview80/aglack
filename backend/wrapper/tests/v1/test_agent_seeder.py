"""Behavioral tests for the native agent-seeder routes
(`api/v1/agent_seeder.py`) — exercises the real upstream `api.profiles`
functions against an isolated tmp HERMES_HOME (see ../conftest.py), not
mocks. Uses a SYNTHETIC `seeder/` tree (monkeypatched onto
`features.agent_seeder.service._default_seeder_root`) rather than this repo's real
one, so these tests stay independent of whatever agents/tools/skills
happen to be checked into `seeder/` at any given time.

All agent content lives under `modes/<mode>/agents/...` — see
`seeder_kit.tree`'s own module docstring for why per-agent content is
mode-scoped while global tools/skills are not. Most tests use `"simple"`
as the mode under test; a dedicated section near the bottom covers
mode-scoping itself (two modes at the same root staying independent, an
unknown mode returning an empty list rather than an error, `GET /modes`).
"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hermes_webui_wrapper.app import create_app
from hermes_webui_wrapper.features.agent_seeder import service as agent_seeder_service


@pytest.fixture()
def client() -> TestClient:
    app = create_app(runtime_enabled=False)
    with TestClient(app) as test_client:
        yield test_client


def _write_tool(path: Path, name: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        textwrap.dedent(
            f'''
            TOOL_NAME = "{name}"
            TOOL_DESCRIPTION = "desc"
            TOOL_INPUT_SCHEMA = {{"type": "object", "properties": {{}}}}

            async def handle(arguments):
                return [{{"type": "text", "text": "ok"}}]
            '''
        ),
        encoding="utf-8",
    )


def _write_skill(path: Path, name: str) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test skill\n---\n\n# {name}\n",
        encoding="utf-8",
    )


def _agent_dir(root: Path, mode: str, agent_name: str) -> Path:
    return root / "modes" / mode / "agents" / agent_name


def _make_seeder_tree(root: Path, mode: str, agent_name: str) -> Path:
    """Builds:
        root/
          tools/global_tool.py                    (TOOL_NAME=global_tool)
          skills/global_skill/SKILL.md
          modes/<mode>/agents/<agent_name>/
            soul.md
            tools/widget_tool.py                    (TOOL_NAME=widget_tool)
            skills/widget_skill/SKILL.md
    """
    _write_tool(root / "tools" / "global_tool.py", "global_tool")
    _write_skill(root / "skills" / "global_skill", "global_skill")

    agent_dir = _agent_dir(root, mode, agent_name)
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "soul.md").write_text(
        f"# {agent_name}\nI am the {agent_name} agent.\n", encoding="utf-8"
    )
    _write_tool(agent_dir / "tools" / "widget_tool.py", "widget_tool")
    _write_skill(agent_dir / "skills" / "widget_skill", "widget_skill")

    return root


@pytest.fixture()
def agent_name(request: pytest.FixtureRequest) -> str:
    """A profile name unique to this test function — `HERMES_HOME` is
    session-scoped (see ../conftest.py), so every test in this module
    shares the same on-disk profiles root; reusing a fixed agent name like
    "Widget" across tests would make them collide on the same profile and
    turn "is this the first apply" assertions into order-dependent
    flakes."""
    # Profile names are validated against ^[a-z0-9][a-z0-9_-]{0,63}$ once
    # lowercased (see service._profile_slug_for_agent_dir) — build a slug
    # straight from the test's own nodeid so it's both unique and valid.
    raw = request.node.name
    slug = "".join(c if c.isalnum() else "-" for c in raw).strip("-").lower()
    return f"tw-{slug}"[:60]


@pytest.fixture()
def synthetic_seeder_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, agent_name: str
) -> Path:
    root = _make_seeder_tree(tmp_path / "seeder", "simple", agent_name)
    monkeypatch.setattr(agent_seeder_service, "_default_seeder_root", lambda: root)
    return root


def test_apply_creates_profile_from_agent_folder(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    applied = body["data"]["applied"]
    assert len(applied) == 1
    entry = applied[0]
    assert entry["agent"] == agent_name
    assert entry["display_name"] == agent_name
    assert entry["profile_created"] is True
    assert entry["soul_updated"] is True


def test_apply_writes_soul_content_from_soul_md(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    soul_response = client.get(f"/api/wrapper/v1/agent-config/{agent_name}/soul")
    assert soul_response.status_code == 200
    assert soul_response.json()["data"]["content"] == f"# {agent_name}\nI am the {agent_name} agent.\n"


def test_apply_seeds_global_and_agent_skills(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    from api.profiles import get_hermes_home_for_profile

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]

    assert entry["skills_seeded"] == ["global_skill", "widget_skill"]

    home = get_hermes_home_for_profile(agent_name)
    assert (home / "skills" / "global_skill" / "SKILL.md").is_file()
    assert (home / "skills" / "widget_skill" / "SKILL.md").is_file()


def test_apply_discovers_global_and_agent_tools(
    client: TestClient, synthetic_seeder_tree: Path
) -> None:
    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]

    assert entry["tools_seeded"] == ["global_tool", "widget_tool"]
    assert entry["mcp_server_configured"] is True


def test_apply_writes_mcp_servers_config_entry(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    import yaml
    from api.profiles import get_hermes_home_for_profile

    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    home = get_hermes_home_for_profile(agent_name)
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    entry = config["mcp_servers"]["hermes-seeder"]
    assert entry["args"].count("--tools-dir") == 2
    assert str(synthetic_seeder_tree / "tools") in entry["args"]
    assert str(_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "tools") in entry["args"]


def test_apply_skips_agent_md_when_no_agent_md_file(
    client: TestClient, synthetic_seeder_tree: Path
) -> None:
    """No agent.md file at all in this fixture's agent folder — the seeder
    must skip it silently, not error."""
    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]

    assert entry["agent_md_updated"] is False
    assert "agent_md_skipped_reason" not in entry


def test_apply_skips_agent_md_when_workspace_not_configured_but_reports_reason(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    (_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "agent.md").write_text(
        "# instructions\n", encoding="utf-8"
    )

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]

    assert entry["agent_md_updated"] is False
    assert "workspace" in entry["agent_md_skipped_reason"].lower()


def test_apply_writes_agent_md_when_workspace_is_configured(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str, tmp_path: Path
) -> None:
    import yaml
    from api.profiles import get_hermes_home_for_profile

    (_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "agent.md").write_text(
        "# real instructions\n", encoding="utf-8"
    )
    # First apply creates the profile; configure its workspace, then re-apply.
    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()
    home = get_hermes_home_for_profile(agent_name)
    config_path = home / "config.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    config["workspace"] = str(workspace_dir)
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]

    assert entry["agent_md_updated"] is True
    assert (workspace_dir / "AGENTS.md").read_text(encoding="utf-8") == "# real instructions\n"


def test_apply_is_idempotent_does_not_recreate_existing_profile(
    client: TestClient, synthetic_seeder_tree: Path
) -> None:
    first = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    assert first.json()["data"]["applied"][0]["profile_created"] is True

    second = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    assert second.status_code == 200
    assert second.json()["data"]["applied"][0]["profile_created"] is False


def test_apply_overwrites_soul_on_reapply_even_after_hand_edit(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """Hand-editing the seed source and re-applying must win — SOUL.md has
    no skip-if-exists guard (see agent_config/service.py)."""
    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    (_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "soul.md").write_text(
        "# v2\n", encoding="utf-8"
    )
    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    soul_response = client.get(f"/api/wrapper/v1/agent-config/{agent_name}/soul")
    assert soul_response.json()["data"]["content"] == "# v2\n"


def test_apply_one_targets_single_agent(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    response = client.post(f"/api/wrapper/v1/agent-seeder/simple/apply/{agent_name}")

    assert response.status_code == 200
    assert response.json()["data"]["agent"] == agent_name


def test_apply_one_unknown_agent_returns_404(
    client: TestClient, synthetic_seeder_tree: Path
) -> None:
    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply/does-not-exist")

    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "agent_seeder_agent_not_in_tree"


def test_apply_fails_loud_on_duplicate_tool_name_across_global_and_agent(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """A per-agent tool file reusing a global tool's name must fail the
    whole apply for that agent, not silently shadow one or the other."""
    _write_tool(
        _agent_dir(synthetic_seeder_tree, "simple", agent_name) / "tools" / "collides.py",
        "global_tool",
    )

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "agent_seeder_tool_discovery_failed"
    assert "global_tool" in body["error"]["message"]


def test_apply_with_no_agents_directory_returns_empty_list(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty_root = tmp_path / "empty-seeder"
    empty_root.mkdir()
    monkeypatch.setattr(agent_seeder_service, "_default_seeder_root", lambda: empty_root)

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    assert response.status_code == 200
    assert response.json()["data"]["applied"] == []


def test_seeder_root_env_var_overrides_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """HERMES_SEEDER_ROOT points the whole seeder at a different tree —
    the config knob a deployment (e.g. the Docker image, or a test rig)
    uses instead of relying on the sibling-directory default. Exercised
    through config.resolve_seeder_root (the real resolution path), NOT the
    _default_seeder_root monkeypatch seam every other test here uses."""
    from hermes_webui_wrapper.config import resolve_seeder_root

    override_root = tmp_path / "custom-seeder"
    override_root.mkdir()
    monkeypatch.setenv("HERMES_SEEDER_ROOT", str(override_root))

    assert resolve_seeder_root() == override_root.resolve()

    monkeypatch.delenv("HERMES_SEEDER_ROOT")
    default = resolve_seeder_root()
    assert default.name == "seeder"
    assert default != override_root.resolve()


# ── mode scoping ─────────────────────────────────────────────────────────

def test_apply_scopes_to_the_requested_mode_only(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The core scalability property: two modes at the same root apply
    completely independently — applying "simple" must never touch or
    report "creator"'s agents, and vice versa."""
    root = tmp_path / "seeder"
    _write_tool(root / "tools" / "global_tool.py", "global_tool")
    (_agent_dir(root, "simple", "PM")).mkdir(parents=True)
    (_agent_dir(root, "simple", "PM") / "soul.md").write_text("# PM\n", encoding="utf-8")
    (_agent_dir(root, "creator", "Writer")).mkdir(parents=True)
    (_agent_dir(root, "creator", "Writer") / "soul.md").write_text("# Writer\n", encoding="utf-8")
    monkeypatch.setattr(agent_seeder_service, "_default_seeder_root", lambda: root)

    simple_response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    simple_agents = {a["agent"] for a in simple_response.json()["data"]["applied"]}

    creator_response = client.post("/api/wrapper/v1/agent-seeder/creator/apply")
    creator_agents = {a["agent"] for a in creator_response.json()["data"]["applied"]}

    assert simple_agents == {"pm"}
    assert creator_agents == {"writer"}


def test_apply_unknown_mode_returns_empty_list_not_an_error(
    client: TestClient, synthetic_seeder_tree: Path
) -> None:
    """A mode with no seeder/modes/<mode>/ directory at all is not a
    malformed-request error — it's simply a mode with zero agents (see
    seeder_kit.tree.parse_tree's own contract)."""
    response = client.post("/api/wrapper/v1/agent-seeder/does-not-exist-yet/apply")

    assert response.status_code == 200
    assert response.json()["data"]["applied"] == []


def test_apply_one_unknown_mode_returns_404_same_as_unknown_agent(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """apply_one still needs an agent that exists IN THE REQUESTED MODE —
    an agent that exists in a different mode must not be found."""
    response = client.post(f"/api/wrapper/v1/agent-seeder/does-not-exist-yet/apply/{agent_name}")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "agent_seeder_agent_not_in_tree"


def test_list_modes_reports_declared_modes(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "seeder"
    (root / "modes" / "simple").mkdir(parents=True)
    (root / "modes" / "creator").mkdir(parents=True)
    monkeypatch.setattr(agent_seeder_service, "_default_seeder_root", lambda: root)

    response = client.get("/api/wrapper/v1/agent-seeder/modes")

    assert response.status_code == 200
    assert response.json()["data"] == ["creator", "simple"]


def test_list_modes_empty_when_no_modes_directory(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty_root = tmp_path / "empty-seeder"
    empty_root.mkdir()
    monkeypatch.setattr(agent_seeder_service, "_default_seeder_root", lambda: empty_root)

    response = client.get("/api/wrapper/v1/agent-seeder/modes")

    assert response.status_code == 200
    assert response.json()["data"] == []
