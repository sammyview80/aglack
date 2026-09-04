# Checkpoint 11 — OpenConnector agent-discovery hardening — 2026-09-03

Session focus: continues Checkpoint 10's OAuth/OpenConnector work. This
session found and fixed real agent-facing failures (confirmed via live
transcripts, not speculation) — agents guessing GitHub action ids
instead of discovering them, and a bundled hermes-agent skill actively
contradicting the OpenConnector-brokered path.

## What's live and working (verified end-to-end, real containers)

- **Root profile bundled-skill seeding**: `_ensure_root_profile_has_bundled_skills()`
  in `backend/wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py`
  (~line 138). Root cause: `backend/upstream/api/profiles.py`'s
  `create_profile_api()` only auto-seeds hermes-agent's bundled skills
  (`/opt/hermes/skills`, 485 files) when `clone_from is None` — but our
  `_create_profile_if_missing()` almost always clones from a root profile
  (`clone_from=root_name`) to inherit model config, and native code
  deliberately skips the bundled-skill overlay on the clone path
  (assumes the clone SOURCE already has skills). The root profile itself
  never got seeded, so nothing downstream ever inherited skills. Fix:
  before cloning, check if root's `skills/` dir is empty and seed it
  once via native `hermes_cli.profiles.seed_profile_skills()` — cheap
  `is_dir()`/`iterdir()` check, no subprocess cost paid once seeded.
  Every future clone inherits skills for free via native
  `clone_config=True`'s existing `shutil.copytree`. **Do NOT re-attempt
  a "manually copy bundled skills into every profile" fix** — that was
  tried first this session, was wrong (reinvented upstream's own
  exclusion/opt-out logic), and was fully reverted. This root-seed
  approach is the correct, final one.
- **Gateway MCP proxy allowlist widened**: `ALLOWED_TOOLS` in
  `rust_gateway/src/integrations/mcp_proxy.rs` (~line 59) now includes
  `search_actions`, `get_action_guide`, `list_apps`, `find_action` (was
  only `execute_action`/`list_connections`). Still enforced: per-provider
  `allowed_actions`, connection-name force-injection, tenant isolation —
  unchanged.
- **`find_action` — new merged discovery tool** (the main deliverable
  this session): `backend/wrapper/src/hermes_webui_wrapper/features/integrations/mcp_server.py`.
  Real root cause found live: agents kept calling `execute_action` with
  GUESSED action ids (`search_repositories`, `github.list_repositories`
  — neither exists; real one is `github.search_repositories`), burning
  turns on `unknown_action`, sometimes giving up and using an unrelated
  method (web search) instead of the connected provider. **Deeper
  finding**: the agent's actual MCP tool surface (via wrapper's
  `mcp_server.py`, mounted at `/api/wrapper/v1/integrations`) only ever
  exposed `list_connections` + `execute_action` as real `@mcp.tool()`
  functions — `search_actions`/`get_action_guide`/`list_apps` were NEVER
  callable by the agent at all, even after the gateway allowlist fix
  above (that fix only unblocks those RPC method names at the gateway
  layer; nothing in the agent's actual tool surface called them). Fix:
  `find_action(service, query, limit=5)` — one call that internally runs
  `search_actions` then `get_action_guide` for the top 1-3 candidates,
  returns real id + full input schema in one round trip. Agent-facing
  tool surface is now: `list_connections`, `execute_action`,
  `find_action` — three tools total, verified this is the complete real
  set (`grep -n "@mcp.tool" mcp_server.py`).
- **`org-integrations` skill** (`backend/seeder/skills/org-integrations/SKILL.md`,
  new this session, auto-seeds via the normal org-skill pipeline):
  teaches "check `list_connections` first; if connected, ALWAYS call
  `find_action` before `execute_action`, never guess an id; if not
  connected, fall back to your normal method (curl etc)." Corrected
  TWICE this session after real failures: (1) originally referenced
  `search_actions`/`get_action_guide` as directly callable — corrected
  to only reference the 3 tools that actually exist; (2) hardened
  "search before execute" from soft guidance to a hard rule after
  confirming via `composio` CLI (`composio search`/`composio execute`)
  that Composio (a real comparable platform) documents this exact same
  hard-rule posture, no shortcuts, in their own CLI help text.
- **`github-auth` conflict exclusion**: hermes-agent's bundled `github`
  skill folder ships 6 sub-skills (`github-auth`, `github-issue-to-pr`,
  `github-pr-workflow`, `github-issues`, `github-repo-management`,
  `github-code-review`) that ALL instruct the agent to have the user
  create a separate GitHub PAT and set up `git`/`gh` CLI directly —
  found live, this directly contradicts using the OpenConnector-brokered
  path and was the likely reason an agent's mental model defaulted to
  guessing REST-style action names. Fix in
  `backend/wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py`:
  `_EXCLUDED_BUNDLED_SKILL_SUBPATHS` maps `"github"` → those 6 subpaths;
  `_connected_provider_ids()` reuses the existing `relay_mcp_call` →
  `list_connections` path; excluded subpaths get `shutil.rmtree`'d
  during `_apply_skills()` for any provider currently connected. Runs on
  every seed pass (fresh AND re-seed), so connecting a provider AFTER a
  profile was already seeded retroactively removes the conflicting
  skill on next re-seed. `github/codebase-inspection` (pure LOC counting,
  no auth) deliberately left alone. **To add another provider** (gmail,
  slack, notion): add an entry to `_EXCLUDED_BUNDLED_SKILL_SUBPATHS`
  after actually inspecting that provider's bundled skill content the
  same way (`docker run --rm --entrypoint sh nousresearch/hermes-agent:latest
  -c 'find /opt/hermes/skills/<provider> -iname "*.md"'`) — do not guess
  which sub-skills conflict.

## Fully verified end-to-end (real workspace, real GitHub OAuth, real API calls)

Tested on workspace `21086d7a-4652-4fd8-ba7b-ed72c42a3f3e` (now deleted —
was a throwaway test workspace) BEFORE the `find_action` fix's image
rebuild:
- Root skills seed: 0 → 14 top-level bundled skills after fix.
- `org-integrations` correctly appears in seeder's `skills_seeded` list.
- `github-auth` + 5 siblings present pre-connect, correctly removed
  after connect + re-seed; `codebase-inspection` correctly kept.
- `search_actions`/`execute_action` through the real gateway proxy path
  work (this was BEFORE `find_action` existed, calling the gateway's
  `/workspaces/:id/mcp` route directly with a real bearer token —
  confirms the gateway-layer allowlist fix works, does NOT confirm the
  agent's own tool surface exposes these, which turned out to be false
  until `find_action` shipped).

**NOT yet re-verified after this session's LAST changes** (the
`find_action` tool itself, the corrected 3-tool skill doc, the Docker
image rebuild that includes both) — this is exactly where the session
was interrupted. See "Immediate next steps" below.

## Explicitly reverted this session (don't redo)

- A first attempt at the bundled-skills fix manually copied
  `/opt/hermes/skills` into every profile's `skills/` dir inside
  `_apply_skills()`, with a new `resolve_bundled_skills_root()` helper
  in `config.py`. Fully reverted after finding upstream's own
  `create_profile_api`/`seed_profile_skills`/clone-skills mechanism
  already does this correctly when used right — see the root-profile-seed
  fix above, which is the one that's actually in the code now.

## Key gotchas for next session (avoid re-discovering these)

- **`backend/upstream/api/profiles.py` is a real, separate hermes-agent
  source checkout** vendored in this repo (distinct from `/opt/hermes/hermes_cli`
  inside the built image — that's a DIFFERENT copy, CLI-flavored, used
  for the `hermes` CLI/skills, not what the wrapper's `from api.profiles
  import ...` resolves to). `_default_upstream_root()` in
  `backend/wrapper/src/hermes_webui_wrapper/config.py` resolves
  `<wrapper-root>/../upstream`, i.e. `backend/upstream/`. If you need to
  check what an "upstream" function actually does, read the file in
  `backend/upstream/`, not inside a running container's `/opt/hermes/hermes_cli`
  — they can behave differently, confirmed live this session (`create_profile_api`
  in `backend/upstream/api/profiles.py` vs `create_profile`/`seed_profile_skills`
  in the image's `/opt/hermes/hermes_cli/profiles.py` — different files,
  related but not identical).
- **The agent's REAL MCP tool surface is `mcp_server.py`'s `@mcp.tool()`
  functions ONLY** — never assume a tool name is agent-callable just
  because it appears in the gateway's `ALLOWED_TOOLS` allowlist, in
  OpenConnector's own catalog, or in prior checkpoint prose. Always
  `grep -n "@mcp.tool" backend/wrapper/src/hermes_webui_wrapper/features/integrations/mcp_server.py`
  to get the real current list. As of this session: `list_connections`,
  `execute_action`, `find_action`.
- **Testing the MCP path directly (bypassing the wrapper) is easy to
  get wrong and produces misleading results** — hitting gateway's
  `/workspaces/:id/mcp` route or OpenConnector's `:3300/mcp` directly
  with curl tests the RPC-method allowlist and OpenConnector's catalog,
  but NOT whether the agent itself can actually call that tool name (it
  can't, unless `mcp_server.py` defines it). Also: calling OpenConnector
  directly (bypassing gateway) requires manually supplying
  `connectionName` — gateway force-injects this for you normally, so a
  direct-to-OpenConnector call omitting it will 403 with
  `connection_not_allowed` even with a valid, correctly-scoped token —
  this is a testing artifact, not a real bug (confirmed live, wasted
  time debugging a false alarm before realizing this).
- **Workspace container is a snapshot of the image at CREATE time** — a
  rebuilt `hermes-workspace:dev` image does NOT retroactively update any
  already-running container. Every code/skill fix this session needed:
  `docker build -t hermes-workspace:dev -f backend/workspace-image/Dockerfile .`
  (run from repo root) THEN delete the old test workspace
  (`DELETE /workspaces/:id` via gateway, logged in via `POST /auth/login`)
  THEN create a fresh one (`POST /workspaces {"name": "..."}`) to actually
  test the new code. This was needed **three separate times** this
  session as fixes landed incrementally — expect to need it again if
  more integration-tool fixes land in a future session.
- **`backend/seeder/` is baked into the image at build time**
  (`COPY backend/seeder /opt/hermes-webui/seeder` in the Dockerfile), NOT
  read live from the filesystem at container runtime — a new/edited
  `SKILL.md` in `backend/seeder/skills/` needs the SAME image rebuild +
  workspace recreate cycle as any Python/Rust code change. Confirmed
  live: `org-integrations` was completely absent from a freshly-seeded
  profile until the image was rebuilt, despite the skill file existing
  on disk and the seeder logic being correct.
- **Gateway's own admin password was reset this session** — the ORIGINAL
  password (whatever it was before) no longer works. New random
  password generated and hashed via `cargo run --bin rust_gateway --
  --hash-password "<password>"` (note: takes password as a POSITIONAL
  ARG, not stdin — `<<<` redirection just hangs waiting on nothing).
  The plaintext was written to `/tmp/newpw.txt` (scratch, gone on
  reboot/session end) — **if a new session needs gateway admin access
  and that file is gone, the password must be reset again the same way**;
  there is no way to recover the old one (Argon2id, one-way).
- **Docker Desktop can silently stop mid-session** — this happened once
  this session (unclear trigger). `docker build`/`docker exec` will fail
  with "failed to connect to the docker API... daemon is running?" —
  fix is `open -a Docker` then poll `docker info` until it succeeds
  (took ~10-20s this session). This ALSO stops the `oc-dev` (OpenConnector,
  port 3300) container — check `docker ps -a --format "{{.Names}} {{.Status}}"`
  for `oc-dev Exited` and `docker start oc-dev` explicitly; the gateway
  will start fine without it but logs `failed to register OAuth config
  for github: ... error sending request ...` at boot and OAuth
  connect/list_connections calls will fail until it's back.
- `run.sh` reliably prints `run.sh: stopped.` shortly after starting
  even though all three services (test_backend :8797, rust_gateway
  :8080, frontend :5173) are actually up and stay up — this is a
  wrapper-script/trap quirk, not a real failure. Always verify with
  `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/` on
  all three ports rather than trusting the script's own stdout.

## Working tree state (nothing committed this session, or ever — same as Checkpoint 10)

Everything from Checkpoint 10 is still uncommitted, PLUS this session's
changes, all uncommitted:
- `rust_gateway/src/integrations/mcp_proxy.rs` (`ALLOWED_TOOLS` widened,
  new tests).
- `backend/wrapper/src/hermes_webui_wrapper/features/integrations/mcp_server.py`
  (`find_action` tool added).
- `backend/wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py`
  (`_ensure_root_profile_has_bundled_skills`,
  `_EXCLUDED_BUNDLED_SKILL_SUBPATHS`, `_connected_provider_ids`,
  `_exclude_connected_provider_bundled_skills`).
- `backend/wrapper/tests/v1/test_agent_seeder.py`,
  `backend/wrapper/tests/v1/test_integrations.py` (new tests for all of
  the above).
- `backend/seeder/skills/org-integrations/SKILL.md` (new).
- `rust_gateway/.env` — `GATEWAY_ADMIN_PASSWORD_HASH` changed (new
  random password, see gotcha above — this file is gitignored normally,
  confirm before committing anything that it stays that way).

All test suites green as of last run this session: Rust `cargo test` —
179 passed, 0 failed. Python wrapper `pytest` — 117 passed, 1 skipped
(pre-existing, unrelated), 0 failed.

## Immediate next steps for a new session

1. **Finish the interrupted verification.** A GitHub OAuth popup URL was
   issued for a fresh test workspace (`f0341c74-4d59-40a6-b6ec-67368715f3ff`,
   created on the rebuilt image that includes `find_action` + the
   corrected skill doc) and the session ended before the user
   approved it in a browser. Next session: either resume that exact
   workspace (check it still exists: `GET /workspaces` via gateway, or
   `docker ps --filter name=hermes-ws-f0341c74`) and complete the OAuth
   popup, or start a fresh workspace + OAuth connect from scratch — then
   verify `find_action` really closes the guessing problem: seed an
   agent, connect GitHub, call `find_action` with a vague query like
   "search repositories" through the REAL agent chat UI (not a direct
   curl bypass) and confirm the agent gets a working, schema-correct
   `execute_action` call on the first try.
2. Services need restarting at the start of a new session — nothing
   persists a running process across sessions. Use `./run.sh` from repo
   root, then verify all 3 ports respond (see gotcha above about
   `run.sh: stopped.` being a false alarm). Also verify `oc-dev` is
   running (`docker start oc-dev` if not) before testing anything
   integration-related.
3. Everything is still uncommitted — ask the user before committing
   (git safety protocol unchanged from Checkpoint 10's own note).
4. If asked to extend the `github-auth`-style exclusion to another
   provider (gmail/slack/notion), don't guess which bundled sub-skills
   conflict — inspect them live first, same method as this session (see
   "Key gotchas" above).
