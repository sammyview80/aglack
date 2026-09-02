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
    org-tool-use/SKILL.md    company-mode tool-naming/restrictions reference (harmless
                             no-op for simple/creator agents that never read it)
    org-comm-protocol/SKILL.md  company-mode message-tagging/retry protocol,
                             identical across 5 of the 6 company agents —
                             PM overrides it with its own richer copy (see
                             "Company mode" below)
    org-routing/SKILL.md     company-mode generic routing-mechanic skeleton,
                             identical across 5 of the 6 company agents —
                             PM overrides it with its own standalone copy
                             (see "Company mode" below)
  modes/
    simple/                  agents/PM/ — the minimal single-agent mode
      agents/
        PM/                  one subfolder per Hermes profile to create/update
          soul.md            -> PM's SOUL.md (always overwritten on apply)
          agent.md            -> PM's workspace AGENTS.md (only written if a
                               workspace is already configured for PM — see
                               "Why agent.md is workspace-level" below)
          tools/              PM-only MCP tools, additive to the global ones
          skills/             PM-only skills, additive to the global ones
            task_assign/SKILL.md
    creator/                 declared mode with no agents yet — valid, not an
                             error (see "Modes" below)
    company/                 six org-wide singleton agents: CEO, CFO, PM,
                             Builder, Persona, Librarian (see "Company mode"
                             below)
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

## Company mode

`modes/company/agents/` ports the six org-wide singleton agents from an
earlier, separate Hermes ERP prototype (`hermano/backend`'s
`api/{ceo,cfo,pm,builder,persona,librarian}_defaults/`) into this
project's seeder tree shape: CEO, CFO, PM, Builder, Persona, Librarian.
Each is a full role — identity (`soul.md`), operating instructions
(`agent.md`), and its own `skills/` (routing, reporting, communication
protocol, and role-specific procedures like `weekly-review` or
`financial-review`).

**What ported and what didn't:**

- Tool names dropped the source prototype's `mcp__hermes_webui__` prefix
  (that prefix is specific to upstream's own MCP tool bridge, which this
  project's `seeder_kit` tools don't use) — every `org_*`/`kanban_*`/
  `brain_*` tool name is now bare, matching this project's plain
  `TOOL_NAME` convention. See `skills/org-tool-use/SKILL.md` (global) for
  the naming rule every company-mode agent's `agent.md` points to.
- The seventh source role, **Department Head**, is NOT included as a
  seeded agent — it was never a singleton in the source prototype (one
  per department, created dynamically by Builder), and this project has
  no dynamic department/head-creation mechanism to seed it against (see
  `CHECKPOINT4.md`/`CHECKPOINT5.md`: cross-agent trigger/kanban
  infrastructure is explicitly out of scope).
- Three skills were candidates for the global `skills/` tier; each was
  checked with `seeder_kit`, not assumed:
  - `org-tool-use` — identical across every role in the source. Promoted
    to global as-is.
  - `org-comm-protocol` — byte-identical across 5 of the 6 roles (Builder/
    CEO/CFO/Librarian/Persona). Promoted to global. **PM is the
    exception**: its source copy has an extra section (the trigger-trace-
    cycle detection PM/Head need, the other 5 roles don't) — PM keeps its
    own copy at `modes/company/agents/PM/skills/org-comm-protocol/SKILL.md`,
    which overrides the global one for PM specifically (per-agent skills
    copy AFTER global ones and win on a name collision — see
    "Idempotency" below).
  - `org-routing` — NOT byte-identical (each role's remit description and
    routing table genuinely differ), but 5 of the 6 roles (Builder/CEO/
    CFO/Librarian/Persona) share the exact same surrounding mechanic
    (self-check framing, the mediate-or-go-direct procedure, the "what
    this doesn't cover" closing). That shared mechanic was extracted to
    the global `skills/org-routing/SKILL.md`; each of those 5 agents keeps
    only its own genuinely-different content (remit + routing table +
    role-specific notes) in a small per-agent
    `skills/org-remit/SKILL.md`, which the global skill explicitly
    delegates to for steps 1-2. **PM is the exception again**: its routing
    logic is woven into its own Phase A/B dispatch flow and defers the
    routing table to `question-routing` instead of repeating it — a
    structurally different shape, not just longer content — so PM keeps
    its own full, standalone `org-routing/SKILL.md`, unchanged, which
    overrides the global one for PM specifically.

  Verify with `seeder_kit.copy_skill_dirs`/`parse_tree` before assuming a
  skill is safe to dedupe or split: only promote whole-file content to
  global `skills/` when it's byte-identical; only extract a shared
  skeleton into a global skill (with a per-agent remainder file) when the
  extracted part is genuinely the same mechanic, not merely similar
  wording — and never force an agent whose actual shape differs (like PM
  here) into the same split just for symmetry.
- Every reference to a source-prototype workspace-template placeholder
  (`{{WORKSPACE_ROOT}}`) was rewritten to plain prose ("your own
  workspace folder") — this project's seeder has no templating engine.
- The source prototype auto-seeded a `PLAN.md` starter file at each
  singleton's workspace root outside the normal SOUL.md/AGENTS.md
  mechanism; that one-off file type was NOT added to `seeder_kit` (each
  agent's `agent.md`/`soul.md` still instructs it to read/write its own
  `PLAN.md`, it just isn't pre-populated by the seeder).
- These agents describe org/kanban/Brain tools (`org_get_graph`,
  `kanban_create`, `brain_search`, `org_trigger_agent_async`, ...) that
  this project does not implement anywhere — same gap as the source
  prototype content itself once had relative to upstream Hermes; treat
  `modes/company/` as ported identity/procedure content, not a claim that
  this deployment's runtime actually backs every tool named here.

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

`create_profile_api` alone never sets a workspace for a freshly created
profile — so applying the seeder ALSO creates a real, dedicated
`<agent-workspaces-root>/<agent-slug>/` directory for each newly seeded
agent (e.g. `/workspace/pm`, a sibling of the default profile's own
`/workspace/default`) and writes it into that profile's `config.yaml` as
`workspace`, before applying `agent.md`. This never overwrites an
already-configured workspace — an existing profile's hand-set `workspace`/
`default_workspace` always wins. `<agent-workspaces-root>` is derived from
`HERMES_WEBUI_DEFAULT_WORKSPACE`'s own parent directory (the env var the
real workspace container's boot script sets), so it's never a
second, independently-hardcoded path. Outside a real container (that env
var unset), workspace auto-creation is a soft no-op — `agent.md` then
falls back to being skipped as `agent_md_updated: false` with an
`agent_md_skipped_reason`, not an error.

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
- **Per-agent workspace directory + `config.yaml`'s `workspace` key** —
  created/written only once, the first time a profile has no
  `workspace`/`default_workspace` set at all. Never overwrites an
  already-configured workspace on a later apply.
- **`soul.md` / `agent.md`** — always overwritten from the seed source on
  every apply. Edit the file here, not the running profile's copy, if you
  want a change to survive the next apply.
- **Skills** — always re-copied from the seed source, overwriting the
  previous copy. Copy order is global `skills/` first, then the agent's
  own `skills/` (`SeederTree.skill_dirs_for`) — a per-agent skill folder
  with the SAME name as a global one overwrites it for that agent only
  (e.g. PM's own `org-comm-protocol/` overrides the global one; every
  other company-mode agent gets the global copy untouched).
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
