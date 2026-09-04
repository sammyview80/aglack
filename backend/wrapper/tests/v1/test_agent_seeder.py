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


def test_apply_agent_without_soul_md_does_not_inherit_root_soul(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, agent_name: str
) -> None:
    """`create_profile_api(..., clone_config=True)` clones `SOUL.md` along
    with `config.yaml`/`.env` (`_CLONE_CONFIG_FILES` in
    `../upstream/api/profiles.py`) so a newly seeded agent inherits a
    reachable model provider — but that same clone would silently leave
    the ROOT's identity in place for an agent with no `soul.md` of its
    own (soul is optional per `seeder_kit`). Every consumer of a missing
    SOUL.md treats "file absent" as no soul at all (empty string), not an
    error, so the fix must delete the cloned file, not invent placeholder
    text or leave the root's identity in place."""
    from api.profiles import get_hermes_home_for_profile

    root = tmp_path / "seeder"
    _write_tool(root / "tools" / "global_tool.py", "global_tool")
    _write_skill(root / "skills" / "global_skill", "global_skill")
    agent_dir = _agent_dir(root, "simple", agent_name)
    _write_tool(agent_dir / "tools" / "widget_tool.py", "widget_tool")
    _write_skill(agent_dir / "skills" / "widget_skill", "widget_skill")
    # Deliberately no soul.md for this agent.
    monkeypatch.setattr(agent_seeder_service, "_default_seeder_root", lambda: root)

    root_name = agent_seeder_service._resolve_root_profile_name()
    root_soul_path = get_hermes_home_for_profile(root_name) / "SOUL.md"
    root_soul_path.write_text(
        "You are Hermes Agent, ... created by Nous Research\n", encoding="utf-8"
    )

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]
    assert entry["soul_updated"] is False

    agent_soul_path = get_hermes_home_for_profile(agent_name) / "SOUL.md"
    assert not agent_soul_path.exists()


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


def test_apply_seeds_root_profile_bundled_skills_once(
    client: TestClient,
    synthetic_seeder_tree: Path,
    agent_name: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`_create_profile_if_missing` clones a new agent from the root
    profile (`clone_from=root_name, clone_config=True`) — upstream's own
    `create_profile()` then copies the root's `skills/` dir into the
    clone via `shutil.copytree`. That only actually delivers bundled
    skills if the ROOT profile's own `skills/` dir has them, which
    upstream's `create_profile_api` never seeds on this (non-`None`
    `clone_from`) path. `_ensure_root_profile_has_bundled_skills` covers
    that gap directly on the root — this pins down that it fires when the
    root looks unseeded, and does NOT fire again once seeded, since
    `seed_profile_skills` shells out a subprocess with up to a 60s
    timeout and must not pay that cost on every agent-creation call."""
    import shutil
    import sys
    import types

    from api.profiles import get_hermes_home_for_profile, list_profiles_api

    root_name = next(p["name"] for p in list_profiles_api() if p.get("is_default"))
    root_home = get_hermes_home_for_profile(root_name)

    # `HERMES_HOME` is session-scoped (see ../conftest.py) — the real ROOT
    # profile is shared across every test in this session. This test must
    # leave the root's `skills/` dir exactly as it found it, so seeding it
    # here can't leak into any other test's `list_profiles_api()` calls
    # (upstream computes per-skill stats the moment `skills/` exists at
    # all — see `_compute_profile_skills_stats` — which needs the `agent`
    # package: present in the real built image, not necessarily in every
    # local/dev checkout of this repo).
    root_skills_dir = root_home / "skills"
    backup_dir = root_home / "skills.bak-test-restore"
    had_existing_skills = root_skills_dir.exists()
    if had_existing_skills:
        shutil.move(str(root_skills_dir), str(backup_dir))

    try:
        calls: list[Path] = []

        def _fake_seed_profile_skills(profile_path: Path, *, quiet: bool = False) -> None:
            calls.append(Path(profile_path))
            # Mimic the real helper actually populating skills/, so the
            # "already seeded" check on a later apply sees a non-empty dir.
            skill_dir = Path(profile_path) / "skills" / "bundled_skill"
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: bundled_skill\ndescription: test\n---\n", encoding="utf-8"
            )

        fake_hermes_cli = types.ModuleType("hermes_cli")
        fake_hermes_cli_profiles = types.ModuleType("hermes_cli.profiles")
        fake_hermes_cli_profiles.seed_profile_skills = _fake_seed_profile_skills
        fake_hermes_cli.profiles = fake_hermes_cli_profiles
        monkeypatch.setitem(sys.modules, "hermes_cli", fake_hermes_cli)
        monkeypatch.setitem(sys.modules, "hermes_cli.profiles", fake_hermes_cli_profiles)

        # `list_profiles_api()` (called on every apply, to resolve the root
        # profile name) computes each profile's skill stats the moment its
        # `skills/` dir exists at all — see `_compute_profile_skills_stats`
        # — via `agent.skill_utils`, a module that ships inside the real
        # built image (part of `hermes_cli`/`agent`) but isn't vendored
        # into this source checkout. Stub it minimally so seeding the root
        # here doesn't fail an UNRELATED upstream code path that has
        # nothing to do with what this test is pinning down.
        if "agent" not in sys.modules or not hasattr(sys.modules["agent"], "skill_utils"):
            fake_agent = types.ModuleType("agent")
            fake_agent_skill_utils = types.ModuleType("agent.skill_utils")
            fake_agent_skill_utils.iter_skill_index_files = lambda *a, **k: iter(())
            fake_agent_skill_utils.parse_frontmatter = lambda content: ({}, content)
            fake_agent_skill_utils.skill_matches_platform = lambda frontmatter: True
            fake_agent.skill_utils = fake_agent_skill_utils
            monkeypatch.setitem(sys.modules, "agent", fake_agent)
            monkeypatch.setitem(sys.modules, "agent.skill_utils", fake_agent_skill_utils)

        # Root starts unseeded (no skills dir at all) — first apply must
        # seed it exactly once.
        client.post("/api/wrapper/v1/agent-seeder/simple/apply")
        assert calls == [root_home]
        assert (root_skills_dir / "bundled_skill" / "SKILL.md").is_file()

        # A second, distinct agent created against the now-seeded root
        # must NOT trigger another seed_profile_skills call.
        second_agent = f"{agent_name}-second"
        second_agent_dir = _agent_dir(synthetic_seeder_tree, "simple", second_agent)
        second_agent_dir.mkdir(parents=True, exist_ok=True)
        (second_agent_dir / "soul.md").write_text(f"# {second_agent}\n", encoding="utf-8")

        response = client.post(f"/api/wrapper/v1/agent-seeder/simple/apply/{second_agent}")
        assert response.status_code == 200, response.text
        assert calls == [root_home]
    finally:
        shutil.rmtree(root_skills_dir, ignore_errors=True)
        if had_existing_skills:
            shutil.move(str(backup_dir), str(root_skills_dir))


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


def test_apply_mcp_servers_entry_carries_this_agents_own_agent_id(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """The `hermes-seeder` stdio entry is what gives an agent's tool
    subprocess real per-agent identity: `--agent-id` must be immediately
    followed by THIS agent's own resolved slug (never another agent's,
    never absent), so `seeder_kit.runner` can inject it as `_agent_id` for
    the `open_browser`/`close_browser` tool modules."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    (_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "browser.enabled").write_text(
        "", encoding="utf-8"
    )

    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    home = get_hermes_home_for_profile(agent_name)
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    args = config["mcp_servers"]["hermes-seeder"]["args"]
    assert args.count("--agent-id") == 1
    assert args[args.index("--agent-id") + 1] == agent_name


def test_apply_mcp_servers_entry_carries_agent_id_even_without_browser_marker(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """`agent_id` is passed unconditionally (see `_apply_mcp_tools`'s own
    comment) — an agent WITHOUT `browser.enabled` still gets its own slug,
    which is harmless for tool modules that never read `_agent_id`."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    home = get_hermes_home_for_profile(agent_name)
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    args = config["mcp_servers"]["hermes-seeder"]["args"]
    assert args[args.index("--agent-id") + 1] == agent_name


# --- browser: config.yaml block (opt-in per-agent capability) ---


def test_apply_does_not_write_browser_block_without_the_marker_file(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """The default fixture's agent has no `browser.enabled` marker — the
    `browser:` block must not appear at all, and the result must report
    `browser_enabled: False`."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]
    assert entry["browser_enabled"] is False

    home = get_hermes_home_for_profile(agent_name)
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert "browser" not in config


def test_apply_writes_browser_block_when_agent_opts_in(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """`browser.enabled` present in this agent's own seeder-tree folder ->
    a `browser:` config.yaml block is written, keyed to THIS agent's own
    slug — never a permanent cdp_url/port, only identity (see
    `_apply_browser_capability`'s own doc comment)."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    (_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "browser.enabled").write_text(
        "", encoding="utf-8"
    )

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]
    assert entry["browser_enabled"] is True

    home = get_hermes_home_for_profile(agent_name)
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert config["browser"] == {
        "enabled": True,
        "profile_id": agent_name,
        "persistent": True,
    }
    # Never merged into the unrelated mcp_servers entry — a separate
    # top-level key.
    assert "browser" not in config.get("mcp_servers", {})


def test_apply_browser_block_is_separate_from_mcp_servers_entry(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """An agent that opts into BOTH tools (mcp_servers.hermes-seeder,
    written unconditionally by this fixture's tool dirs) AND the browser
    capability must end up with both top-level keys, independently."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    (_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "browser.enabled").write_text(
        "", encoding="utf-8"
    )

    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    home = get_hermes_home_for_profile(agent_name)
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert "hermes-seeder" in config["mcp_servers"]
    assert config["browser"]["profile_id"] == agent_name


def test_apply_skips_agent_md_when_no_agent_md_file(
    client: TestClient, synthetic_seeder_tree: Path
) -> None:
    """No agent.md file at all in this fixture's agent folder — the seeder
    must skip it silently, not error."""
    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]

    assert entry["agent_md_updated"] is False
    assert "agent_md_skipped_reason" not in entry


def test_apply_auto_creates_agent_workspace_and_writes_agent_md(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """The gap this whole feature exists to close: a newly seeded agent
    gets a real `<agent_workspaces_root>/<slug>/` directory automatically
    (conftest.py sets HERMES_WEBUI_DEFAULT_WORKSPACE for test isolation),
    so agent.md actually applies on the FIRST apply — no manual workspace
    config needed, unlike before this behavior existed."""
    (_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "agent.md").write_text(
        "# instructions\n", encoding="utf-8"
    )

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]

    assert entry["agent_md_updated"] is True
    assert entry["workspace_created"].endswith(f"/{agent_name}")

    workspace_dir = Path(entry["workspace_created"])
    assert workspace_dir.is_dir()
    assert (workspace_dir / "AGENTS.md").read_text(encoding="utf-8") == "# instructions\n"


def test_apply_skips_agent_md_when_workspace_root_env_unset(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail-closed path: outside a real container (or any env that hasn't
    set HERMES_WEBUI_DEFAULT_WORKSPACE), _ensure_agent_workspace can't
    resolve a root to create the agent's directory under, so agent.md is
    skipped with a reason — same as if a workspace were never configured
    at all."""
    monkeypatch.delenv("HERMES_WEBUI_DEFAULT_WORKSPACE", raising=False)
    (_agent_dir(synthetic_seeder_tree, "simple", agent_name) / "agent.md").write_text(
        "# instructions\n", encoding="utf-8"
    )

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]

    assert entry["agent_md_updated"] is False
    assert "workspace" in entry["agent_md_skipped_reason"].lower()
    assert "workspace_created" not in entry


def test_apply_does_not_overwrite_an_already_configured_workspace(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str, tmp_path: Path
) -> None:
    """An existing profile's hand-configured workspace must never be
    silently replaced by the auto-created one — same "never clobber
    what's already set" rule every other seeder step follows."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    client.post(f"/api/wrapper/v1/agent-seeder/simple/apply/{agent_name}")

    hand_configured = tmp_path / "hand-configured-workspace"
    hand_configured.mkdir()
    home = get_hermes_home_for_profile(agent_name)
    config_path = home / "config.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    config["workspace"] = str(hand_configured)
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")

    response = client.post(f"/api/wrapper/v1/agent-seeder/simple/apply/{agent_name}")
    entry = response.json()["data"]

    assert "workspace_created" not in entry
    final_config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert final_config["workspace"] == str(hand_configured)


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


def test_agent_workspaces_root_derives_from_default_workspace_env_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never a second, independently-hardcoded '/workspace' default — the
    per-agent workspaces root is always the PARENT of whatever
    HERMES_WEBUI_DEFAULT_WORKSPACE actually points at (set by the real
    container's boot script to e.g. /workspace/default), so a per-agent
    directory always lands as a real sibling of the default profile's own
    workspace."""
    from hermes_webui_wrapper.config import resolve_agent_workspaces_root

    monkeypatch.setenv("HERMES_WEBUI_DEFAULT_WORKSPACE", "/workspace/default")

    assert resolve_agent_workspaces_root() == Path("/workspace")


def test_agent_workspaces_root_raises_when_env_var_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail closed outside a real container rather than guessing a path —
    same convention as Settings.from_env()'s HERMES_FRONTEND_ORIGIN check."""
    from hermes_webui_wrapper.config import resolve_agent_workspaces_root

    monkeypatch.delenv("HERMES_WEBUI_DEFAULT_WORKSPACE", raising=False)

    with pytest.raises(RuntimeError, match="HERMES_WEBUI_DEFAULT_WORKSPACE"):
        resolve_agent_workspaces_root()


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


# --- Connected-provider bundled-skill exclusion ---


def test_exclude_connected_provider_bundled_skills_removes_github_auth_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GitHub connected via OpenConnector for this workspace -> the
    bundled github-* skills that instruct the agent to set up direct
    git/gh CLI auth must not remain seeded, while an unrelated bundled
    skill (e.g. a comfyui-style path) and the unrelated
    github/codebase-inspection sub-skill are left untouched."""
    skills_dir = tmp_path / "profile" / "skills"
    for subpath in (
        "github/github-auth",
        "github/github-issue-to-pr",
        "github/codebase-inspection",
        "comfyui",
    ):
        skill_path = skills_dir / subpath
        skill_path.mkdir(parents=True, exist_ok=True)
        (skill_path / "SKILL.md").write_text(
            f"---\nname: {subpath.rsplit('/', maxsplit=1)[-1]}\ndescription: test\n---\n",
            encoding="utf-8",
        )

    monkeypatch.setattr(
        agent_seeder_service, "_connected_provider_ids", lambda: {"github"}
    )

    agent_seeder_service._exclude_connected_provider_bundled_skills(skills_dir)

    assert not (skills_dir / "github" / "github-auth").exists()
    assert not (skills_dir / "github" / "github-issue-to-pr").exists()
    assert (skills_dir / "github" / "codebase-inspection" / "SKILL.md").is_file()
    assert (skills_dir / "comfyui" / "SKILL.md").is_file()


def test_exclude_connected_provider_bundled_skills_noop_when_nothing_connected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No connections at all (unset workspace, gateway unreachable, or
    simply nothing connected yet) must be a soft no-op — nothing is
    removed."""
    skills_dir = tmp_path / "profile" / "skills"
    github_auth = skills_dir / "github" / "github-auth"
    github_auth.mkdir(parents=True, exist_ok=True)
    (github_auth / "SKILL.md").write_text("---\nname: github-auth\n---\n", encoding="utf-8")

    monkeypatch.setattr(agent_seeder_service, "_connected_provider_ids", lambda: set())

    agent_seeder_service._exclude_connected_provider_bundled_skills(skills_dir)

    assert github_auth.is_dir()


def test_connected_provider_ids_soft_no_ops_on_relay_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`relay_mcp_call` raises (e.g. no integrations token delivered into
    this container yet — the common case outside a fully-wired workspace)
    -- this must never propagate and break agent seeding, just report no
    connected providers."""
    def _raise(_body):
        raise RuntimeError("gateway unreachable")

    monkeypatch.setattr(
        "hermes_webui_wrapper.features.integrations.service.relay_mcp_call", _raise
    )

    assert agent_seeder_service._connected_provider_ids() == set()


# --- Model-configuration inheritance (a seeded agent must be able to chat) ---


def _configure_root_model(model_provider: str = "openai", default_model: str = "fake-model") -> None:
    """Writes a model section into the root/default profile's config.yaml
    directly (the state onboarding would normally produce), resolved via
    the same root-name lookup the seeder itself uses."""
    from api.profiles import get_hermes_home_for_profile

    from hermes_webui_wrapper.features.profile_yaml import load_profile_config, save_profile_config

    root_name = agent_seeder_service._resolve_root_profile_name()
    config_path = get_hermes_home_for_profile(root_name) / "config.yaml"
    config = load_profile_config(config_path)
    config["model"] = {"provider": model_provider, "default": default_model}
    save_profile_config(config_path, config)


def test_apply_new_profile_inherits_root_model_configuration(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """The gap this fix closes: without a model, a seeded agent's profile
    cannot start a chat turn at all. A newly created profile must clone
    the root profile's already-configured model settings."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    _configure_root_model(model_provider="openai", default_model="fake-model")

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]
    assert entry["profile_created"] is True

    home = get_hermes_home_for_profile(agent_name)
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert config["model"]["provider"] == "openai"
    assert config["model"]["default"] == "fake-model"


def test_apply_before_onboarding_still_creates_agent_without_model(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """Seeding before onboarding (root profile has no model configured
    yet) is a legitimate order — this must be a soft no-op, not a hard
    failure of profile creation.

    `HERMES_HOME` is session-scoped (see `agent_name` fixture docstring),
    so an earlier test in this module may have already called
    `_configure_root_model` on the shared root profile. Arrange and
    verify the "no model configured" precondition explicitly here rather
    than assuming it, so this test provably exercises the pre-onboarding
    path instead of possibly passing via the already-configured one."""
    from api.profiles import get_hermes_home_for_profile

    from hermes_webui_wrapper.features.profile_yaml import load_profile_config, save_profile_config

    root_name = agent_seeder_service._resolve_root_profile_name()
    config_path = get_hermes_home_for_profile(root_name) / "config.yaml"
    config = load_profile_config(config_path)
    config.pop("model", None)
    save_profile_config(config_path, config)
    assert "model" not in load_profile_config(config_path)

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    assert response.status_code == 200, response.text
    entry = response.json()["data"]["applied"][0]
    assert entry["profile_created"] is True
    assert entry["agent"] == agent_name


def test_reapply_does_not_overwrite_agent_model_changed_after_first_apply(
    client: TestClient, synthetic_seeder_tree: Path, agent_name: str
) -> None:
    """Idempotency / never-clobber guarantee: once a profile exists, the
    seeder must never re-clone or otherwise reset its model config, even
    if the root profile's own model changes later."""
    import yaml
    from api.profiles import get_hermes_home_for_profile

    _configure_root_model(model_provider="openai", default_model="fake-model")
    client.post("/api/wrapper/v1/agent-seeder/simple/apply")

    home = get_hermes_home_for_profile(agent_name)
    config_path = home / "config.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    config["model"] = {"provider": "anthropic", "default": "user-changed-model"}
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")

    # Root's model changes after the agent's own was hand-edited.
    _configure_root_model(model_provider="google", default_model="root-changed-model")

    response = client.post("/api/wrapper/v1/agent-seeder/simple/apply")
    entry = response.json()["data"]["applied"][0]
    assert entry["profile_created"] is False

    final_config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert final_config["model"]["provider"] == "anthropic"
    assert final_config["model"]["default"] == "user-changed-model"
