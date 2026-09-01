# seeder/

A declarative CONTENT tree describing MCP tools, skills, and identity
content for Hermes profiles ("agents"), scoped by MODE (simple, creator,
company, ...). This folder is pure data — no code lives here. The library
that parses and runs this content is
[`../seeder_kit/`](../seeder_kit/README.md); the code that applies it to
real Hermes profiles is
[`../wrapper/src/hermes_webui_wrapper/features/agent_seeder/`](../wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py).

```
seeder/
  tools/                     global MCP tools — every agent, in EVERY mode, gets these
    update_soul.py
  skills/                    global skills — every agent, in EVERY mode, gets these
    tickoff_agent/SKILL.md
  modes/
    simple/                  the only mode with real content today
      agents/
        PM/                  one subfolder per Hermes profile to create/update
          soul.md            -> PM's SOUL.md (always overwritten on apply)
          agent.md            -> PM's workspace AGENTS.md (only written if a
                               workspace is already configured for PM — see
                               "Why agent.md is workspace-level" below)
          tools/              PM-only MCP tools, additive to the global ones
          skills/             PM-only skills, additive to the global ones
            task_assign/SKILL.md
    creator/                 declared modes with no agents yet are valid —
    company/                 not errors, just empty (see "Modes" below)
```

Applying this tree happens through the wrapper's native API — `mode` is a
required path segment:

```
GET  /api/wrapper/v1/agent-seeder/modes                  # which modes exist on disk
POST /api/wrapper/v1/agent-seeder/<mode>/apply            # every agent in that mode
POST /api/wrapper/v1/agent-seeder/<mode>/apply/<name>     # just one
```

## Modes

A mode is just a folder name under `modes/` — this project has no fixed
list of valid mode names baked in anywhere (not in `seeder_kit`, not in
the wrapper). `seeder/modes/<name>/agents/` either exists (with zero or
more agents) or it doesn't; either way, applying it never errors — an
unknown or not-yet-populated mode simply seeds nothing
(`{"applied": []}`). `GET /agent-seeder/modes` reports which mode
directories actually exist, so a caller (e.g. the frontend's mode-select
screen) can confirm a mode is real before presenting it as a clickable
choice rather than hardcoding a mode list on both ends.

**Adding a second real mode** is purely additive — create
`seeder/modes/<name>/agents/<Agent>/...` following the same per-agent
layout as `simple/agents/PM/` above. No changes needed to `seeder_kit` or
the wrapper's service/router code; both are already mode-parametric.

Global `tools/` and `skills/` at the tree root are NOT mode-scoped — they
apply to every agent in every mode, since a tool/skill useful to one
agent's identity is not usually specific to which mode created that
agent. A tool/skill that only makes sense for one mode belongs under that
mode's own agent folder(s) instead, same as any other per-agent content.

## How it fits together

```
 seeder/                    seeder_kit/                       wrapper/
 (this folder — content)    (library — mechanics)             (Hermes-specific glue)
 ─────────────────────      ──────────────────────             ──────────────────────
 tools/*.py            ──▶  discovery.py: validates,      ──▶  features/agent_seeder/
 skills/<n>/SKILL.md         merges, runs as MCP server         service.py: calls
 modes/<mode>/agents/...     tree.py: parses the layout,          api.profiles /
                             scoped by mode                        features.agent_config
                             skills.py: copies skill dirs           to actually create/
                             mcp_config.py: builds config             update profiles
                             runner.py: the MCP server
                              process itself
```

`seeder_kit` has no idea what a "Hermes profile" is, and no idea which
mode names are valid — it only knows how to read this folder layout (given
a mode name) and discover/run tools from it. The wrapper's `agent_seeder`
feature is the translation layer that turns "agent PM exists in simple
mode's tree" into "profile `pm` exists with this SOUL.md, these skills,
and this `config.yaml` entry."

## Tool file contract (see `seeder_kit`'s own README for full detail)

```python
TOOL_NAME = "my_tool"
TOOL_DESCRIPTION = "One-line description."
TOOL_INPUT_SCHEMA = {"type": "object", "properties": {...}, "required": [...]}

async def handle(arguments: dict) -> list[dict]:
    return [{"type": "text", "text": "..."}]
```

`handle` runs inside a separate `seeder_kit.runner` subprocess, NOT inside
the `wrapper` process — a tool that needs the wrapper's own native API
(e.g. `update_soul.py` calling `PUT /api/wrapper/v1/agent-config/{name}/soul`)
must do so over HTTP (`HERMES_WRAPPER_URL`, default
`http://127.0.0.1:8787`), never by importing `hermes_webui_wrapper.*`
directly.

## Skill file contract

```
skills/<skill-name>/SKILL.md
```

Matches the real Hermes Agent skill-loader shape (file literally named
`SKILL.md`). Applying the seeder copies every global skill folder plus
that agent's own skill folders into `<profile_home>/skills/<name>/`,
overwriting any existing copy — skills are seeder-owned content, edit the
source file here and re-apply, don't hand-edit the copy on a running
profile.

## Why `agent.md` is workspace-level, not profile-level

This project pins a specific upstream Hermes WebUI checkout (see
`../UPSTREAM.md`). That pinned checkout has **no per-profile `AGENTS.md`
concept** — `AGENTS.md` there is a file the agent scans from its current
working directory (its *workspace*), the same way it scans `CLAUDE.md` or
`.cursorrules`. So `agent.md` becomes `<workspace>/AGENTS.md`, not
`<profile_home>/AGENTS.md`.

A freshly created profile has no workspace configured by default — until
you set `workspace` or `default_workspace` in that profile's
`config.yaml`, applying `agent.md` is a no-op reported as
`agent_md_updated: false` with an `agent_md_skipped_reason`, not an error
and not a guess at a directory.

If a future advance of the pinned upstream commit adds a real per-profile
`AGENTS.md` concept, `../wrapper/.../features/agent_config/service.py`'s
`update_agent_instructions` is the one place to change.

## Profile name vs. folder name

Hermes profile names must match `^[a-z0-9][a-z0-9_-]{0,63}$` (lowercase
only). A seeder agent folder name is meant to be human-readable
(`modes/simple/agents/PM/`) — `seeder_kit.tree.slugify` lowercases it to
get the actual profile slug (`pm`); the original folder name is kept as
`display_name` in apply results. Two folder names that lowercase to the
same slug (`PM` and `pm`) will collide on one profile within the SAME
mode — a `PM` in `simple` and a `PM` in `creator` are unrelated profiles
by design (they'd both slug to `pm`, so don't declare the same agent name
in two modes unless you actually want them to share one profile).

## Idempotency

Applying twice never destroys a profile or its hand edits to files this
tree doesn't own:

- **Profile creation** — skipped if the profile already exists.
- **`soul.md` / `agent.md`** — always overwritten from the seed source on
  every apply. Edit the file here, not the running profile's copy, if you
  want a change to survive the next apply.
- **Skills** — always re-copied from the seed source, overwriting the
  previous copy.
- **`mcp_servers: hermes-seeder` config.yaml entry** — always rewritten
  from the current tool-directory set. Any OTHER key already in that
  profile's `config.yaml` is preserved.

## Running the aggregator manually

```bash
pip install "seeder-kit[mcp]"
hermes-seeder-runner --tools-dir /path/to/seeder/tools \
                      --tools-dir /path/to/seeder/modes/simple/agents/PM/tools
```

The `command` written into a seeded profile's `config.yaml` defaults to
plain `python3` (resolved via `PATH` wherever Hermes Agent actually
launches it). Override with `SEEDER_KIT_RUNNER_PYTHON` if your deployment
needs an explicit interpreter path.
