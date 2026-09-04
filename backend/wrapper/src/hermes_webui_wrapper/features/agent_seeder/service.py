"""Agent-seeder feature service — the Hermes-WebUI-specific glue between
the framework-agnostic `seeder_kit` library and upstream's `api.profiles`.

All tree parsing, tool discovery/validation, and skill-copy MECHANICS live
in `seeder_kit` (see `../../../../../seeder_kit/README.md`) — this module's
only job is translating a `seeder_kit.SeederTree`'s content into calls
against upstream Hermes WebUI functions: create a profile, write its
SOUL.md/workspace AGENTS.md (via `features.agent_config.service`, reused
not duplicated), copy its skills into `<profile_home>/skills/`, and write
one `mcp_servers` entry into its `config.yaml`.

The actual seeder CONTENT this wrapper applies by default lives in
`../../../../../seeder/` (a sibling of `upstream/` and `wrapper/`) — see
that folder's own `README.md` for the on-disk tree layout and the
Hermes-specific scope notes (why `agent.md` maps to a workspace-level
AGENTS.md, why profile names get lowercased, etc.).

Every entry point here takes a required `mode` (e.g. `"simple"`,
`"creator"`, `"company"`) — `seeder_kit.parse_tree` scopes which agents
exist to `seeder/modes/<mode>/agents/*` (see that module's own docstring).
This service has NO opinion on which mode names are valid or what
distinguishes them — an unknown/not-yet-populated mode is simply a tree
with zero agents (`apply_all` then returns `{"applied": []}`, not an
error), same as `seeder_kit.parse_tree`'s own contract. `list_modes()`
reports which mode folders actually exist on disk, for a caller (e.g. the
frontend's mode-select screen) that wants to confirm before offering a
mode as a real choice — see `api/v1/agent_seeder.py`'s `GET /modes` route.

For each agent in a mode's tree:

1. Create the profile via `api.profiles.create_profile_api` if it doesn't
   already exist (idempotent — an existing profile is never re-created or
   destroyed). A newly created profile clones the root/default profile's
   `config.yaml`/`.env` (`clone_from=<resolved root name>, clone_config=True`)
   so it inherits an already-configured model provider/credentials —
   otherwise the agent has no model and cannot chat. Root name is resolved
   via `list_profiles_api()`'s `is_default` row, never hardcoded. Soft
   no-op if the root itself has no model configured yet (pre-onboarding).
   Never re-applied to an existing profile. Before cloning, also ensures
   the root profile's own `skills/` dir has hermes-agent's bundled
   defaults seeded at least once (`_ensure_root_profile_has_bundled_skills`)
   — the clone itself then propagates them via upstream's own skills
   copytree, so no per-agent bundled-skill overlay is needed.
2. `_ensure_agent_workspace`: if that profile has no `workspace`/
   `default_workspace` configured yet, create a real directory named
   after the agent under `config.resolve_agent_workspaces_root()` (e.g.
   `/workspace/pm`, sibling of the default profile's own
   `/workspace/default`) and write it into `config.yaml` as `workspace`.
   Never overwrites an already-configured workspace. This is what makes
   step 3 below actually apply for a newly seeded agent, instead of
   always hitting the skip path `create_profile_api` alone would leave it
   in (that function never sets a workspace itself).
3. Overwrite SOUL.md from `soul.md`, via
   `features.agent_config.service.update_soul`. If the agent has no
   `soul.md` of its own AND its profile was just created in step 1
   (never for a pre-existing profile), delete the SOUL.md that step 1's
   clone copied in from the root — otherwise a soul-less agent would
   silently keep the ROOT's identity instead of having none, since a
   missing SOUL.md is what every consumer already treats as "no soul".
4. If a workspace is configured for that profile (from step 2, or already
   set by hand), overwrite its workspace AGENTS.md from `agent.md`, via
   `features.agent_config.service.update_agent_instructions`. Skipped
   (recorded, not an error) only if genuinely still unconfigured (e.g.
   `HERMES_WEBUI_DEFAULT_WORKSPACE` unset outside a real container, so
   step 2 itself couldn't run).
5. Copy every applicable skill folder (global + this agent's own) into
   `<profile_home>/skills/<name>/`, via `seeder_kit.copy_skill_dirs`.
6. Discover this agent's applicable tool directories (global + its own)
   via `seeder_kit.discover_tools_in_dirs` — validating the tool tree
   before anything is written, so a broken tool module is caught at seed
   time — then write one `mcp_servers.hermes-seeder` entry via
   `seeder_kit.build_mcp_server_entry(..., agent_id=agent.slug)`. The
   `--agent-id` this adds is what gives that agent's stdio tool
   subprocess a real, process-level identity — `seeder_kit.runner`
   injects it into every tool call as `arguments["_agent_id"]` (after
   stripping any caller-supplied value), which the global
   `open_browser`/`close_browser` tool modules in `../../seeder/tools/`
   rely on to act only on the calling agent's own browser.
7. Unless this agent's tree entry opts out (`AgentSpec.wants_browser` is
   True by default; a `browser.disabled` marker file makes it False — see
   `seeder_kit.tree`'s own doc comment: every agent gets browser
   automation available by default, an agent that genuinely should never
   touch a browser marks itself), write a SEPARATE top-level `browser:` block into
   `config.yaml` (`_apply_browser_capability`) — `{"enabled": true,
   "profile_id": <this agent's own slug>, "persistent": true}`. Never
   merged into the `mcp_servers` entry above; only IDENTITY is persisted
   here, never a runtime `cdp_url`/port (those are resolved fresh, per
   `open_browser` call, through the gateway's browser route — see
   `features/browser/service.py`).

No upstream symbol is imported at module level — every function below
imports `api.profiles` lazily, after `bootstrap_upstream()` has already
run for this process (same convention as every other `features/*/service.py`).
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from seeder_kit import (
    AgentSpec,
    SeederTree,
    ToolDiscoveryError,
    available_modes,
    build_mcp_server_entry,
    copy_skill_dirs,
    discover_tools_in_dirs,
    parse_tree,
)

from hermes_webui_wrapper.config import resolve_seeder_root
from hermes_webui_wrapper.features.errors import FeatureError
from hermes_webui_wrapper.features.profile_yaml import (
    load_profile_config,
    mutate_profile_config,
)


class AgentSeederError(FeatureError):
    """This feature's `FeatureError` — see `features/errors.py`."""


logger = logging.getLogger(__name__)

_MCP_SERVER_NAME = "hermes-seeder"

# Bundled hermes-agent skill subpaths (relative to `<profile_home>/skills/`)
# that instruct the AGENT to have the USER set up direct `git`/`gh` CLI
# auth on the machine (personal access token, `gh auth login`) -- a real
# conflict confirmed live for `github`: when the provider is ALREADY
# connected for this workspace via OpenConnector (OAuth, rust_gateway's
# tenant-isolated proxy, MCP `list_connections`/`search_actions`/
# `execute_action`), seeding this advice alongside it caused the agent to
# guess GitHub action ids blindly instead of calling `search_actions`
# first, then give up.
#
# Scope was decided by actually reading hermes-agent's bundled content
# (`docker run --rm --entrypoint sh nousresearch/hermes-agent:latest -c
# 'cat /opt/hermes/skills/github/<name>/SKILL.md'`), not guessed: EVERY
# github-* sub-skill except `codebase-inspection` (pygount LOC counting --
# no git/gh auth involved at all) opens with the same "Quick Auth
# Detection" block that reads `GITHUB_TOKEN` out of `.env` or a
# `git-credential-token.py` script and falls back to `gh`/`git` directly --
# `github-issue-to-pr`, `github-pr-workflow`, `github-issues`,
# `github-repo-management`, and `github-code-review` all explicitly depend
# on `github-auth` having been run and none of them ever mention
# OpenConnector or this workspace's own `execute_action` tool. Excluding
# only `github-auth` and leaving the other five in place would still hand
# the agent CLI-auth instructions with nowhere left to get a token from --
# so the whole conflicting set is excluded, and `codebase-inspection`
# (unrelated) is deliberately left in.
_EXCLUDED_BUNDLED_SKILL_SUBPATHS: dict[str, tuple[str, ...]] = {
    "github": (
        "github/github-auth",
        "github/github-issue-to-pr",
        "github/github-pr-workflow",
        "github/github-issues",
        "github/github-repo-management",
        "github/github-code-review",
    ),
}


def _default_seeder_root() -> Path:
    """Kept as this module's own seam (tests monkeypatch it to point apply
    runs at synthetic trees) — real resolution, including the
    `HERMES_SEEDER_ROOT` env override, lives in `config.resolve_seeder_root`."""
    return resolve_seeder_root()


def _load_tree(mode: str) -> SeederTree:
    return parse_tree(_default_seeder_root(), mode=mode)


def list_modes() -> list[str]:
    """Every mode with a `seeder/modes/<name>/` directory on disk — see
    `seeder_kit.available_modes`. Does not imply the mode has any agents
    yet, only that it's a declared mode."""
    return available_modes(_default_seeder_root())


def _resolve_root_profile_name() -> str | None:
    """The root/default profile's actual name, resolved the same way
    `agent_history`/`agent_config` do (`_is_root_profile`/`_profiles_match`)
    — never the hardcoded literal `"default"`, since this checkout may have
    a renamed root profile. Returns `None` only if `list_profiles_api()`
    reports no row at all (should not happen in practice, but this is a
    read path so it fails soft, not hard)."""
    from api.profiles import list_profiles_api

    for p in list_profiles_api():
        if p.get("is_default"):
            return p.get("name")
    return None


def _ensure_root_profile_has_bundled_skills(root_name: str) -> None:
    """Seed the ROOT profile's own `skills/` directory with hermes-agent's
    bundled defaults, if it looks unseeded — see `hermes_cli.profiles.
    seed_profile_skills` (a real, existing upstream helper: idempotent,
    shells out to `tools.skills_sync.sync_skills()` with `HERMES_HOME`
    pointed at the target profile dir, respects the `.no-bundled-skills`
    opt-out marker, has its own 60s subprocess timeout, and returns `None`
    on any failure without raising).

    Why here, not on every seeded agent: `create_profile_api(...,
    clone_from=root_name, clone_config=True)` (used by
    `_create_profile_if_missing` below whenever a root profile exists)
    already clones the root's `skills/` dir via `shutil.copytree` — see
    `../upstream/api/profiles.py`'s `create_profile()`. Upstream
    deliberately skips its own bundled-skill seeding on a clone path (only
    `clone_from is None` triggers it — "Cloned profiles should preserve
    the clone-source behaviour and must not receive a second bundled-skill
    overlay"), trusting the clone SOURCE to already carry them. In this
    system the root profile is created through onboarding, a path that
    never calls `create_profile_api(clone_from=None)` — the only upstream
    path that auto-seeds — so the root's own `skills/` may never have been
    populated with hermes-agent's defaults. Seed the root once here and
    every future clone inherits them for free via upstream's own
    copytree — no per-agent overlay/collision logic to reinvent.

    Guarded to run at most once per "looks unseeded" root: `seed_profile_skills`
    shells out a subprocess with up to a 60s timeout, a real cost this must
    not pay on every single agent-creation call.
    """
    from api.profiles import get_hermes_home_for_profile

    root_home = get_hermes_home_for_profile(root_name)
    root_skills_dir = root_home / "skills"
    try:
        # Cheap, sane "unseeded" check: no skills/ at all, or an empty one.
        # A directory with any entry already in it is treated as seeded —
        # avoids re-shelling out on every seed call once it's populated,
        # by us or by anything else (e.g. SumX's own org-skill seeding).
        if root_skills_dir.is_dir() and any(root_skills_dir.iterdir()):
            return
    except OSError:
        # Unreadable for some reason — treat as "can't tell", not worth a
        # hard failure over; fall through and let seed_profile_skills (or
        # its own failure handling) sort it out.
        pass

    try:
        from hermes_cli.profiles import seed_profile_skills

        seed_profile_skills(root_home, quiet=True)
    except ImportError:
        # `hermes_cli` isn't importable in this context (e.g. some
        # test/dev setups only vendor `api.profiles`, not the full CLI
        # package) — soft no-op, matching this module's "never hard-fail
        # agent creation over a skills nicety" philosophy, and the same
        # defensive style as `../upstream/api/profiles.py`'s own
        # `create_profile_api` (its `clone_from is None` branch).
        logger.debug(
            "seed_profile_skills unavailable — bundled skills not seeded "
            "for root profile %s (hermes_cli not in path)",
            root_name,
        )
    except Exception:
        # seed_profile_skills itself already swallows its own subprocess
        # failures (returns None), but guard here too in case a future
        # upstream version starts raising — a skills nicety must never
        # break agent seeding.
        logger.warning(
            "Bundled skills could not be seeded for root profile %s; "
            "continuing without them",
            root_name,
            exc_info=True,
        )


def _create_profile_if_missing(agent: AgentSpec) -> bool:
    """Returns True if a new profile was created. Idempotent — an existing
    profile is left untouched.

    A brand-new profile clones the root profile's `config.yaml`/`.env` via
    upstream's own `clone_from`/`clone_config` (see `create_profile_api` in
    `../upstream/api/profiles.py`, `_CLONE_CONFIG_FILES`) so it inherits
    the already-configured model provider/credentials — otherwise a seeded
    agent has no model at all and cannot start a chat turn. Cloning the
    `.env` also copies the root profile's API key(s); that is deliberate
    here, not incidental — a per-agent profile needs real credentials to
    talk to its provider, not just the model name. This only ever applies
    to a profile being created for the first time (gated by the `is_dir()`
    check above); re-running the seeder against an existing profile never
    touches its config again, so a user's later model change is never
    clobbered. If the root profile itself has no model configured yet
    (onboarding not run), cloning still succeeds — it just copies whatever
    the root's config.yaml/.env currently contain, so this is a soft
    no-op, not a failure, and the agent is still created.

    Before cloning, ensures the root profile itself has bundled skills
    seeded (`_ensure_root_profile_has_bundled_skills`) — otherwise the
    clone's own skills copytree just propagates the root's emptiness.
    See that helper's docstring for why this is done to the root once,
    rather than per-agent overlay logic."""
    from api.profiles import create_profile_api, get_hermes_home_for_profile

    home = get_hermes_home_for_profile(agent.slug)
    if home.is_dir():
        return False

    root_name = _resolve_root_profile_name()
    try:
        if root_name is not None:
            _ensure_root_profile_has_bundled_skills(root_name)
            create_profile_api(agent.slug, clone_from=root_name, clone_config=True)
        else:
            create_profile_api(agent.slug)
    except FileExistsError:
        # Raced with something else creating it between the is_dir() check
        # and this call — fine, proceed as "already existed".
        pass
    except (ValueError, PermissionError, RuntimeError) as exc:
        raise AgentSeederError("agent_seeder_profile_create_failed", str(exc), 400) from exc
    return True


def _ensure_agent_workspace(agent: AgentSpec, profile_home: Path) -> str | None:
    """Create `<agent_workspaces_root>/<agent.slug>/` on disk and write it
    into this profile's `config.yaml` as `workspace`, if that profile
    doesn't already have one configured. Returns the workspace path
    written, or `None` if nothing was done (an existing profile already
    has its own `workspace`/`default_workspace` — never overwritten,
    same "never clobber what's already configured" rule every other step
    here follows).

    This is what makes `agent.md` -> workspace AGENTS.md (see
    `_apply_agent_instructions`) actually apply for a NEWLY seeded agent
    instead of always hitting the `agent_config_workspace_not_configured`
    skip path — `create_profile_api` itself never sets a workspace (see
    `features/agent_config/service.py`'s own module docstring), so
    without this every seeded agent needed one set by hand first.

    Outside a real container (`HERMES_WEBUI_DEFAULT_WORKSPACE` unset —
    `resolve_agent_workspaces_root()` raises `RuntimeError`), this is a
    soft no-op, not a hard failure of the whole apply: `_apply_agent_instructions`
    already has its own graceful "no workspace configured" skip path for
    exactly this case, and every other step here (soul, skills, tools)
    still needs to run regardless of whether a workspace could be
    auto-created.
    """
    from hermes_webui_wrapper.config import resolve_agent_workspaces_root

    config_path = profile_home / "config.yaml"
    try:
        config = load_profile_config(config_path)
    except ValueError as exc:
        raise AgentSeederError("agent_seeder_config_unreadable", str(exc), 500) from exc

    if config.get("workspace") or config.get("default_workspace"):
        return None

    try:
        workspaces_root = resolve_agent_workspaces_root()
    except RuntimeError:
        return None

    workspace_dir = workspaces_root / agent.slug
    try:
        workspace_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise AgentSeederError("agent_seeder_workspace_create_failed", str(exc), 500) from exc

    def _set_workspace(cfg: dict) -> None:
        cfg["workspace"] = str(workspace_dir)

    try:
        mutate_profile_config(config_path, _set_workspace)
    except ValueError as exc:
        raise AgentSeederError("agent_seeder_config_unreadable", str(exc), 500) from exc
    except OSError as exc:
        raise AgentSeederError("agent_seeder_config_write_failed", str(exc), 500) from exc

    return str(workspace_dir)


def _apply_soul(agent: AgentSpec, profile_home: Path, profile_created: bool) -> bool:
    """Write this agent's own `soul.md` if it has one. If it has none AND
    the profile was just created here, remove the SOUL.md that
    `create_profile_api(..., clone_config=True)` copied in from the root
    profile (`_CLONE_CONFIG_FILES` in `../upstream/api/profiles.py`
    includes `SOUL.md`) — otherwise this agent would silently keep the
    ROOT's identity instead of getting no soul at all. Every consumer of
    a missing SOUL.md (see `../upstream/api/routes.py`'s memory-panel
    read, `soul_file.exists()` else `""`) treats "file absent" as an
    empty soul, not an error, so deleting it is the correct "no soul"
    state — never invent placeholder text, and never touch a
    pre-existing profile's SOUL.md (the never-clobber rule)."""
    from hermes_webui_wrapper.features.agent_config import service as agent_config_service

    content = agent.read_soul()
    if content is None:
        if profile_created:
            soul_path = profile_home / "SOUL.md"
            soul_path.unlink(missing_ok=True)
        return False
    agent_config_service.update_soul(agent.slug, content)
    return True


def _apply_agent_instructions(agent: AgentSpec, result: dict[str, Any]) -> None:
    from hermes_webui_wrapper.features.agent_config import service as agent_config_service

    content = agent.read_agent_instructions()
    if content is None:
        result["agent_md_updated"] = False
        return

    try:
        agent_config_service.update_agent_instructions(agent.slug, content)
        result["agent_md_updated"] = True
    except agent_config_service.AgentConfigError as exc:
        if exc.code in ("agent_config_workspace_not_configured", "agent_config_workspace_missing"):
            result["agent_md_updated"] = False
            result["agent_md_skipped_reason"] = exc.message
        else:
            raise AgentSeederError(
                "agent_seeder_agent_md_failed", exc.message, exc.status_code
            ) from exc


def _connected_provider_ids() -> set[str]:
    """Every provider id (`providers.yaml`'s `id`, e.g. `"github"`)
    currently connected for THIS container's own workspace -- read via the
    SAME relay this wrapper already exposes to agents as the
    `list_connections` MCP tool (`features/integrations/service
    .relay_mcp_call`, the one path this wrapper has to OpenConnector via
    rust_gateway's tenancy proxy -- see that module's docstring), never a
    second, independently-built path to the gateway. `providers.yaml`'s
    `openconnector_service` value IS the `service` field OpenConnector's
    own `list_connections`/`PUT /api/connections/:service` return
    (confirmed against the real API shape in
    docs/integrations-poc-findings.md), so a connected `service` string
    can be compared directly against a provider id with no separate
    mapping table -- true for every provider currently in `providers.yaml`
    (`id` and `openconnector_service` happen to match byte-for-byte there
    today; if that ever diverges for a new provider, this still degrades
    to just not excluding that provider's skills, never to a wrong match).

    Soft no-op (empty set) on ANYTHING going wrong -- no workspace
    configured yet, token/gateway unreachable, malformed response --
    matching this module's "a skills nicety must never break agent
    creation" rule (see `_ensure_root_profile_has_bundled_skills`)."""
    try:
        from hermes_webui_wrapper.features.integrations.service import relay_mcp_call

        response = relay_mcp_call(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "list_connections", "arguments": {}},
            }
        )
        structured = response.get("result", {}).get("structuredContent") or {}
        connections = structured.get("data") or []
        return {
            c.get("service")
            for c in connections
            if isinstance(c, dict) and c.get("service")
        }
    except Exception:
        logger.debug(
            "Could not resolve connected providers for this workspace — "
            "bundled-skill exclusion skipped (nothing excluded)",
            exc_info=True,
        )
        return set()


def _exclude_connected_provider_bundled_skills(dest_skills_dir: Path) -> None:
    """Remove any bundled skill subpath in `_EXCLUDED_BUNDLED_SKILL_SUBPATHS`
    whose provider is connected for this workspace, from an already-seeded
    `<profile_home>/skills/` dir. Runs on EVERY `_apply_skills` call --
    fresh creation (where the clone in `_create_profile_if_missing` already
    delivered hermes-agent's bundled defaults via upstream's own
    `shutil.copytree` of the root's `skills/` dir, see
    `_ensure_root_profile_has_bundled_skills`) and re-seeding of an
    existing profile alike -- so a provider connected AFTER a profile's
    first seed is retroactively excluded the next time this agent is
    re-applied, not just at creation time. Never touches any OTHER bundled
    skill (comfyui, weights-and-biases, `github/codebase-inspection`, or
    any not-yet-connected provider's own skills) -- only the exact
    subpaths listed for a CONNECTED provider are removed."""
    connected = _connected_provider_ids()
    if not connected:
        return
    for provider_id, subpaths in _EXCLUDED_BUNDLED_SKILL_SUBPATHS.items():
        if provider_id not in connected:
            continue
        for subpath in subpaths:
            target = dest_skills_dir / subpath
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)


def _apply_skills(tree: SeederTree, agent: AgentSpec, profile_home: Path) -> list[str]:
    dest_skills_dir = profile_home / "skills"
    dest_skills_dir.mkdir(parents=True, exist_ok=True)

    copied: set[str] = set()
    for source_dir in tree.skill_dirs_for(agent):
        copied.update(copy_skill_dirs(source_dir, dest_skills_dir))

    _exclude_connected_provider_bundled_skills(dest_skills_dir)

    return sorted(copied)


def _apply_browser_capability(agent: AgentSpec, profile_home: Path) -> bool:
    """Write a `browser:` block into this agent's `config.yaml` unless its
    seeder tree entry opts out (`AgentSpec.wants_browser` — True by
    default, False only when `<agent_dir>/browser.disabled` exists; see
    `seeder_kit.tree`'s own doc comment). A SEPARATE top-level key
    from `mcp_servers` (never merged into it) — this is not an MCP server
    entry, just a per-profile capability flag the wrapper's own
    `features/browser/service.py` and the container's browser-manager
    daemon read.

    Shape: `{"enabled": true, "profile_id": agent.slug, "persistent": true}`
    — `profile_id` is this agent's own resolved slug, matching this whole
    feature's design principle that only IDENTITY is persisted here, never
    a runtime `cdp_url`/port (those are resolved fresh on every
    `open_browser` call via the gateway's `/workspaces/:id/browser/...`
    route, never written to disk — see that module's own docstring).

    Uses the SAME `mutate_profile_config`/`load_profile_config` helpers
    every other per-agent `config.yaml` write in this module already uses
    (`_ensure_agent_workspace`, `_apply_mcp_tools`) — no second read/write
    path. An agent whose tree entry opts OUT of this capability is
    left untouched (no `browser:` key written at all, and an existing one
    from a previous apply is never removed here — this function only ever
    adds/refreshes the block for an agent that currently wants it,
    matching `_apply_mcp_tools`'s own "never silently revoke" style for a
    capability that isn't present in the CURRENT tree read).

    Returns whether the block was written.
    """
    if not agent.wants_browser:
        return False

    config_path = profile_home / "config.yaml"

    def _set_browser_block(cfg: dict) -> None:
        cfg["browser"] = {
            "enabled": True,
            "profile_id": agent.slug,
            "persistent": True,
        }

    try:
        mutate_profile_config(config_path, _set_browser_block)
    except ValueError as exc:
        raise AgentSeederError("agent_seeder_config_unreadable", str(exc), 500) from exc
    except OSError as exc:
        raise AgentSeederError("agent_seeder_config_write_failed", str(exc), 500) from exc

    return True


def _apply_mcp_tools(tree: SeederTree, agent: AgentSpec, profile_home: Path) -> dict[str, Any]:
    from hermes_webui_wrapper.config import (
        resolve_gateway_internal_url,
        resolve_integrations_workspace_id,
    )

    tool_dirs = tree.tool_dirs_for(agent)
    try:
        discovered = discover_tools_in_dirs(tool_dirs)
    except ToolDiscoveryError as exc:
        raise AgentSeederError("agent_seeder_tool_discovery_failed", str(exc), 400) from exc

    if not tool_dirs:
        return {"tools_seeded": [], "mcp_server_configured": False}

    config_path = profile_home / "config.yaml"

    # The host's real stdio MCP launcher only passes a safe env allowlist
    # (plus this explicit `mcp_servers.<name>.env` mapping) to the spawned
    # `hermes-seeder-<agent>` subprocess — so the values the browser tool
    # modules need to reach the gateway must be named here explicitly or
    # they never arrive. Resolved via this wrapper's own config.py helpers
    # (fail closed: an unset value at seed time is a real misconfiguration
    # and must surface, not silently produce a broken agent). HERMES_HOME
    # is per-agent: `profile_home` is already the exact resolved home for
    # THIS profile (root or named — see `_apply_agent`). Non-secret values
    # only: never the integrations bearer token or any other secret —
    # this mapping is written to a plain config.yaml.
    runner_env = {
        "GATEWAY_INTERNAL_URL": resolve_gateway_internal_url(),
        "INTEGRATIONS_WORKSPACE_ID": resolve_integrations_workspace_id(),
        "HERMES_HOME": str(profile_home),
    }

    def _set_mcp_server(cfg: dict) -> None:
        mcp_servers = cfg.setdefault("mcp_servers", {})
        # `agent_id=agent.slug` for EVERY agent, unconditionally (not only
        # `wants_browser` ones): this entry is already built fresh per
        # agent, so the identity is real and free; `seeder_kit.runner`
        # injects it as `arguments["_agent_id"]` and a tool module that
        # doesn't read the key is unaffected (see `seeder_kit/discovery.py`).
        # Gating it on `wants_browser` would couple this generic MCP entry
        # to one specific capability for no safety gain — the browser tool
        # modules themselves and the gateway route are the real gates.
        mcp_servers[_MCP_SERVER_NAME] = build_mcp_server_entry(
            tool_dirs,
            server_name=f"{_MCP_SERVER_NAME}-{agent.slug}",
            agent_id=agent.slug,
            env=runner_env,
        )

    try:
        mutate_profile_config(config_path, _set_mcp_server)
    except ValueError as exc:
        raise AgentSeederError("agent_seeder_config_unreadable", str(exc), 500) from exc
    except OSError as exc:
        raise AgentSeederError("agent_seeder_config_write_failed", str(exc), 500) from exc

    return {
        "tools_seeded": sorted(t.name for t in discovered),
        "mcp_server_configured": True,
    }


def _apply_root_profile(tree: SeederTree) -> dict[str, Any] | None:
    """Give the root/default Hermes profile the SAME global tools/skills
    (including browser automation) every named seeder-tree agent already
    gets — a REAL gap found live: `apply_all`/`apply_one` only ever
    iterate `tree.agents` (the `seeder/modes/<mode>/agents/*` folders,
    e.g. `PM`/`CEO`), so the root profile (the one a brand-new workspace's
    default chat targets before any mode is ever selected) never went
    through `_apply_mcp_tools`/`_apply_browser_capability` at all —
    confirmed live: a real root profile's `config.yaml` had zero
    `mcp_servers` entries, not even the base `hermes-seeder` one, let
    alone `browser:`.

    Root profile has no `AgentSpec` of its own (it is not a
    `seeder/modes/<mode>/agents/<name>/` folder) — a MINIMAL synthetic one
    is built here (`tools_dir=None`, `skills_dir=None`) so it flows
    through `tree.tool_dirs_for`/`tree.skill_dirs_for` exactly like every
    other agent: those already return ONLY the global dirs when an
    agent's own per-agent dirs are `None` (see `seeder_kit/tree.py`), so
    the root profile correctly gets every GLOBAL tool/skill (including
    `open_browser`/`close_browser`/`browser_task`,
    `skills/org-browser-use/`) and nothing agent-specific — there is no
    per-agent content for a profile that isn't a named seeder-tree agent.

    Deliberately reuses `_apply_mcp_tools`/`_apply_browser_capability`/
    `_apply_skills` UNCHANGED rather than a parallel reimplementation —
    those functions only ever need `agent.slug`/`agent.tools_dir`/
    `agent.skills_dir`/`agent.wants_browser`, all of which a synthetic
    `AgentSpec` supplies correctly.

    Returns `None` (not an error) if the root profile cannot be resolved
    yet (`_resolve_root_profile_name` returns `None` — e.g. onboarding
    has not run) or does not exist on disk yet — matches this module's
    existing "soft no-op, not a failure" convention for a not-yet-ready
    root (see `_create_profile_if_missing`'s own docstring)."""
    from api.profiles import get_hermes_home_for_profile

    root_name = _resolve_root_profile_name()
    if root_name is None:
        return None

    profile_home = get_hermes_home_for_profile(root_name)
    if not profile_home.is_dir():
        return None

    root_agent = AgentSpec(
        folder_name=root_name,
        slug=root_name,
        path=profile_home,
        soul_path=None,
        agent_instructions_path=None,
        tools_dir=None,
        skills_dir=None,
        wants_browser=True,
    )

    result: dict[str, Any] = {"agent": root_name, "display_name": root_name, "is_root_profile": True}
    result["skills_seeded"] = _apply_skills(tree, root_agent, profile_home)
    result.update(_apply_mcp_tools(tree, root_agent, profile_home))
    result["browser_enabled"] = _apply_browser_capability(root_agent, profile_home)
    return result


def _apply_agent(tree: SeederTree, agent: AgentSpec) -> dict[str, Any]:
    from api.profiles import get_hermes_home_for_profile

    result: dict[str, Any] = {"agent": agent.slug, "display_name": agent.folder_name}

    profile_created = _create_profile_if_missing(agent)
    result["profile_created"] = profile_created
    profile_home = get_hermes_home_for_profile(agent.slug)

    workspace_created = _ensure_agent_workspace(agent, profile_home)
    if workspace_created:
        result["workspace_created"] = workspace_created

    result["soul_updated"] = _apply_soul(agent, profile_home, profile_created)
    _apply_agent_instructions(agent, result)

    result["skills_seeded"] = _apply_skills(tree, agent, profile_home)
    result.update(_apply_mcp_tools(tree, agent, profile_home))
    result["browser_enabled"] = _apply_browser_capability(agent, profile_home)

    return result


def apply_all(mode: str) -> dict[str, Any]:
    """Apply every agent found in `mode`'s tree, PLUS the root/default
    profile (see `_apply_root_profile`'s own doc comment for the real gap
    this closes — the root profile is not itself a seeder-tree agent, so
    it needs its own explicit application, not just tree iteration).
    Returns one result entry per agent, in tree order, with the root
    profile's entry LAST (`is_root_profile: true`) when it applies —
    appended, never prepended, so existing callers that only look at
    `applied[0]` for "the first real agent" (if any do) are unaffected.
    A single agent's (or the root profile's) failure raises immediately
    (fail closed on the whole apply) rather than silently skipping it and
    reporting partial success. A mode with no declared agents (including
    one that doesn't exist on disk at all) still applies the root profile
    — the root profile's own tools/skills are independent of which mode
    was selected, since it is never itself part of any mode's tree."""
    tree = _load_tree(mode)
    applied = [_apply_agent(tree, agent) for agent in tree.agents]
    root_result = _apply_root_profile(tree)
    if root_result is not None:
        applied.append(root_result)
    return {"applied": applied}


def apply_one(mode: str, folder_name: str) -> dict[str, Any]:
    tree = _load_tree(mode)
    agent = tree.agent_by_folder_name(folder_name)
    if agent is None:
        raise AgentSeederError(
            "agent_seeder_agent_not_in_tree",
            f"No seeder/modes/{mode}/agents/{folder_name}/ directory found.",
            404,
        )
    return _apply_agent(tree, agent)
