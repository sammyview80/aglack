from __future__ import annotations

from pathlib import Path

from seeder_kit.mcp_config import build_mcp_server_entry, runner_entry_point


def test_runner_entry_point_points_at_real_file() -> None:
    assert runner_entry_point().name == "runner.py"
    assert runner_entry_point().is_file()


def test_build_mcp_server_entry_defaults_to_python3(monkeypatch) -> None:
    monkeypatch.delenv("SEEDER_KIT_RUNNER_PYTHON", raising=False)

    entry = build_mcp_server_entry([Path("/tools")], server_name="my-server")

    assert entry["command"] == "python3"
    assert entry["args"][0] == str(runner_entry_point())
    assert "--server-name" in entry["args"]
    assert "my-server" in entry["args"]
    assert "--tools-dir" in entry["args"]
    assert "/tools" in entry["args"]


def test_build_mcp_server_entry_explicit_python_overrides_env(monkeypatch) -> None:
    monkeypatch.setenv("SEEDER_KIT_RUNNER_PYTHON", "/env/python")

    entry = build_mcp_server_entry([], server_name="s", python_executable="/explicit/python")

    assert entry["command"] == "/explicit/python"


def test_build_mcp_server_entry_reads_env_var(monkeypatch) -> None:
    monkeypatch.setenv("SEEDER_KIT_RUNNER_PYTHON", "/env/python")

    entry = build_mcp_server_entry([], server_name="s")

    assert entry["command"] == "/env/python"


def test_build_mcp_server_entry_multiple_tool_dirs_all_present() -> None:
    entry = build_mcp_server_entry(
        [Path("/global"), Path("/agent")], server_name="s"
    )

    assert entry["args"].count("--tools-dir") == 2
    assert "/global" in entry["args"]
    assert "/agent" in entry["args"]


def test_build_mcp_server_entry_with_agent_id_appends_flag_and_value() -> None:
    entry = build_mcp_server_entry([Path("/tools")], server_name="s", agent_id="pm")

    args = entry["args"]
    assert "--agent-id" in args
    assert args[args.index("--agent-id") + 1] == "pm"
    assert args.count("--agent-id") == 1


def test_build_mcp_server_entry_without_agent_id_is_byte_identical_to_pre_change_shape(
    monkeypatch,
) -> None:
    """Regression guard: omitting `agent_id` must produce EXACTLY the args
    list this function produced before the parameter existed — no
    `--agent-id` flag, no `None`/empty placeholder, same order."""
    monkeypatch.delenv("SEEDER_KIT_RUNNER_PYTHON", raising=False)

    entry = build_mcp_server_entry(
        [Path("/global"), Path("/agent")], server_name="hermes-seeder-pm"
    )

    assert entry == {
        "command": "python3",
        "args": [
            str(runner_entry_point()),
            "--server-name",
            "hermes-seeder-pm",
            "--tools-dir",
            "/global",
            "--tools-dir",
            "/agent",
        ],
    }
    assert "--agent-id" not in entry["args"]
