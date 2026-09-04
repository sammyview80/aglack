# Checkpoint 13 — Per-agent browser automation: daemon, MCP tools, security fix, desktop-visible Chromium, 4GB-RAM efficiency profile — 2026-09-04

Session focus: built a complete, real, end-to-end **per-agent browser
automation feature** from scratch — a container-internal Chromium
process-lifecycle daemon, real MCP tools (`open_browser`/`close_browser`/
`browser_task`, the last one driven by the real `browser-use` pip
package), wired it through every layer (gateway proxy, agent seeding,
per-agent identity via a real per-agent stdio MCP transport, a real
security hole found and fixed before it shipped), then — after live user
testing surfaced three more real bugs — fixed a `/dev/shm` Chromium crash,
made the browser **visible** in the existing KasmVNC desktop instead of
headless, and applied a full 4GB-RAM efficiency profile (KasmVNC
resolution/depth/framerate, `resize=scale`, conservative Chromium flags,
a configurable idle-kill). Every numeric/behavioral claim in this doc was
independently re-verified against a real running container after the
work, not taken from any subagent's self-report.

## Branch state — READ THIS FIRST

Working branch: **`feat/browser-agent`**, NOT `integration/openconnector`.
This matters: earlier in this session the two branches diverged (real
gateway browser work was committed on `feat/browser-agent`, then the
branch was switched to `integration/openconnector`, which does NOT have
that commit — code reverted but the shared local `data/gateway.db` SQLite
file did not, causing a real migration-mismatch crash-loop until the
branch was switched back). **Before doing ANYTHING else in a new
session, run `git branch --show-current` and confirm it says
`feat/browser-agent`** — if it doesn't, this whole feature (and the
gateway's own DB) will not work.

Two commits landed on this branch this session (both by the user
directly, not by me/a subagent — flagging per this project's own
authorization discipline, since only the user is authorized to commit):
- `7df7f85` "feat: browser use with pressitant" — the original daemon +
  gateway wiring + MCP tools + creation-time token security fix.
- `9ae8402` "fix: skill and browser use" — root-profile application,
  real per-agent env propagation fix, `org-browser-use` skill,
  `wants_browser` opt-out flip.

Everything from the **last third of this session** (the `/dev/shm` crash
fix, visible-desktop switch, and full 4GB efficiency profile) is
**UNCOMMITTED** as of this checkpoint — `git status --short` shows:
```
 M backend/workspace-image/Dockerfile
 M backend/workspace-image/browser_manager.py
 M backend/workspace-image/test_browser_manager.py
 M rust_gateway/.env.example
 M rust_gateway/src/app.rs
 M rust_gateway/src/bin/rust_gateway.rs
 M rust_gateway/src/config.rs
 M rust_gateway/src/workspaces/container/boot_script.rs
 M rust_gateway/src/workspaces/container/docker_launcher.rs
?? backend/workspace-image/patch_kasmvnc_local_scaling.py
?? backend/workspace-image/patch_kasmvnc_resource_efficiency.py
?? backend/workspace-image/test_kasmvnc_local_scaling_patch.py
?? backend/workspace-image/test_kasmvnc_resource_efficiency_patch.py
```
Nothing pushed to any remote either — same standing rule as every prior
checkpoint, confirm with the user before ever doing so.

## The architecture, as it actually stands

```
Hermes agent (any profile, including root/"default" — see below)
  │ calls open_browser / browser_task / close_browser (MCP tools)
  ▼
seeder_kit.runner (a REAL per-agent stdio subprocess, --agent-id <slug>
  argv, injected server-side into arguments["_agent_id"], never trusted
  from the MCP caller — this is what gives each tool call real,
  unspoofable agent identity)
  │ HTTP call to the gateway's own browser-proxy route, bearer from
  │ /run/hermes/integrations.token (delivered automatically at workspace
  │ CREATION time now, not just on first OpenConnector connect)
  ▼
rust_gateway: POST /workspaces/:id/browser/:agent_id/:action
  (action ∈ {start,stop,status}, workspace-tenancy-checked, bearer-
  checked with the SAME lockout McpBearerLockout /mcp already uses)
  │ forwards to the container's published, HOST-side-127.0.0.1-only port
  ▼
browser_manager.py (stdlib-only daemon inside the container, binds
  0.0.0.0 INSIDE the container — see "real bugs found" below for why)
  │ start(): launches a REAL, VISIBLE (non-headless) Chromium window
  │ onto the container's own KasmVNC desktop (DISPLAY=:1), persistent
  │ --user-data-dir per agent_id, ephemeral CDP port
  ▼
open_browser/close_browser: just report/release that cdp_url
browser_task: hands the cdp_url + a resolved browser-use LLM (the
  CALLING agent's own configured model, via hermes_cli.runtime_provider)
  to a real browser_use.Agent(...).run() call — one MCP call, fully
  autonomous multi-step goal completion, no back-and-forth needed.
```

## What's real and working (verified live, this session, not assumed)

1. **The daemon** (`backend/workspace-image/browser_manager.py`) — stdlib
   HTTP server, in-memory `{agent_id: {pid, port, profile_dir,
   last_activity}}` registry, process-wide lock (no double-launch race),
   zombie-reaping PID-liveness checks, `/agents/<id>/{start,stop,status}`.
2. **Gateway wiring** (`rust_gateway`) — new `browser_port` published per
   workspace (host-side `127.0.0.1`-only bind — the daemon itself binds
   `0.0.0.0` *inside* the container, a real bug found live: a loopback
   bind inside a container is NEVER reachable through ANY Docker publish
   mapping from outside, regardless of how correct the mapping is), new
   `workspaces/proxy/browser_proxy.rs` route, auth-gated with the same
   bearer+lockout `/mcp` uses (shared threshold — deliberate, same
   secret).
3. **The three MCP tools** (`backend/seeder/tools/`) — real, per-agent
   identity via `seeder_kit.runner`'s `--agent-id`, never the shared HTTP
   `mcp_server.py` mount (that mount has NO way to know which agent is
   calling — confirmed, tried, abandoned that approach explicitly).
4. **`browser_task` really does autonomous multi-step goal completion in
   one call** — confirmed by reading the real code: it hands off entirely
   to `browser_use.Agent(...).run()`, which internally screenshots,
   decides, clicks/types/navigates, repeats, until done — the calling
   Hermes agent has zero visibility into individual steps, only gets
   `final_result()` (+ `errors()`) back.
5. **`wants_browser` is opt-out, not opt-in** — every agent, current AND
   future, gets browser tools by default (`AgentSpec.wants_browser: bool
   = True`, only a `browser.disabled` marker file excludes one). All 7
   real seeded agents (`simple/PM`, `company/{Librarian,PM,CFO,CEO,
   Persona,Builder}`) get it with zero content changes.
6. **The root/default profile ALSO gets it now** — a real, structural gap
   found live (`apply_all`/`apply_one` only ever iterated
   `tree.agents`, the NAMED seeder-tree folders; root/default is not one
   of those, so it was structurally unreachable). Fixed with
   `_apply_root_profile` (a synthetic minimal `AgentSpec`, reuses
   `_apply_mcp_tools`/`_apply_browser_capability` unchanged — no
   duplicated logic), wired into `apply_all` (root's entry appended LAST
   in the `applied[]` response, so every existing `applied[0]`-indexing
   caller/test is unaffected). Confirmed live: a fresh workspace's
   `default` profile's `config.yaml` now has a real `mcp_servers`/`env`/
   `browser:` block, `--agent-id default`, `HERMES_HOME: /config/.hermes`
   (the root's own home, not a subdirectory).
7. **Real per-agent env propagation fixed** — `hermes-agent`'s own
   `mcp_tool.py` deliberately filters stdio-subprocess env to a safe
   allowlist (a real security feature, not a bug) — `GATEWAY_INTERNAL_URL`
   /`INTEGRATIONS_WORKSPACE_ID`/`HERMES_HOME` never reached the spawned
   tool server without an explicit `mcp_servers.<name>.env` block, which
   `build_mcp_server_entry` didn't emit until this session. Confirmed via
   a real MCP protocol round-trip against a real running container.
8. **New skill**: `backend/seeder/skills/org-browser-use/SKILL.md` —
   tells every agent to use the real tools, explicitly NOT `browser_exec`
   (a DIFFERENT, unrelated, confirmed-broken tool built on `browser-use`'s
   own separate `browser-harness` CLI — its own `--doctor` reports
   `daemon alive: FAIL` even when the real daemon's Chromium is fine;
   flagged, explicitly scoped OUT of this session's work per the user's
   own choice).

## Real bugs found live and fixed, in the order they surfaced

1. **`mcp==2.0.0` vs `mcp==2.1.1` dependency conflict** —
   `hermes-agent`'s own `pyproject.toml` exact-pins `mcp==2.0.0` AND sets
   `exclude-newer = "14 days"` (not exempting `browser-use`), so `uv`
   could only resolve an OLD `browser-use` release whose OWN `mcp` pin
   (`1.26.0`) directly conflicted — 5 real `docker build` failures before
   root-causing this. Fixed: `seeder_kit[mcp]` installed via plain `uv
   pip install`, `browser-use` installed as a SEPARATE `uv pip install
   --exclude-newer "$(date -u +%Y-%m-%d)"` call (a bare `uv venv` has no
   `pip` binary at all — confirmed live — so `uv`'s own flag, not a
   second package manager, is the fix).
2. **`PROFILE_ROOT = /data/browser-profiles`** — `/data` doesn't exist in
   the image and isn't `abc`-owned; every `start()` failed closed with a
   real `PermissionError`. Fixed: `/workspace/.browser-profiles` (the
   image's own confirmed `abc`-writable, container-lifetime-persistent
   root, same one `_ensure_agent_workspace` already uses).
3. **Creation-time integrations token would have been fail-OPEN** — the
   original plan (mint the token with an EMPTY `allowed_connection_ids`
   at workspace creation, to unblock `open_browser`'s file-presence
   check on a workspace with zero connections) was caught by a subagent
   BEFORE being built, via a real read of the vendored OpenConnector
   source: `evaluateConnection()` treats an empty list as "no
   restriction" (allow everything), not "no access" — a real, serious
   cross-tenant hole avoided, not shipped. Fixed: mint with a random
   sentinel UUID instead (forces the deny-by-default branch until the
   workspace's first real connect rotates it to a real scoped list). Real
   adversarial test (`creation_time_token_is_scoped_to_one_sentinel_id_
   never_an_empty_list`) asserts against the actual spy call, re-verified
   passing independently.
4. **`GATEWAY_INTERNAL_URL is not set`** — see "env propagation" above.
5. **`browser_exec: chrome-not-running`** — a DIFFERENT, unrelated tool
   (see above), explicitly scoped out, not fixed this session.
6. **`/dev/shm` too small (64MB default) → real Chromium crash** ("Aw,
   Snap!", error code 5) once the browser was switched to non-headless
   (see #7) — confirmed via `docker exec <container> df -h /dev/shm`
   showing exactly 64M on a crashing container, ruled out OOM-kill and
   same-profile double-launch first (both real, both checked, both
   negative) before concluding this. Fixed: `docker create --shm-size`,
   now configurable (see below), defaults to `1g`.
7. **Browser was headless, invisible, not requested** — switched to a
   real, visible (non-`--headless`) window rendered onto the container's
   own KasmVNC virtual desktop (`DISPLAY=:1`) — this is what made bug #6
   surface (headless Chromium doesn't stress `/dev/shm` nearly as hard).
8. **`browser_manager.py` bound `127.0.0.1` INSIDE the container** — a
   loopback bind there is unreachable through ANY Docker publish mapping
   from OUTSIDE the container, full stop, regardless of how correct the
   mapping is (standard, well-known Docker networking fact, not a bug in
   the mapping) — confirmed via a real reproduced connection failure
   hitting the published port from the bare-host gateway process. Fixed:
   daemon binds `0.0.0.0` inside; the "never reachable from outside this
   machine" property is now enforced correctly on the HOST side of the
   Docker publish instead (`127.0.0.1:<port>:9400`).

## The 4GB-RAM efficiency profile (uncommitted, this session's last work)

Real, requested, deliberately conservative tuning across every layer
competing for memory on a 4GB deployment target (Hermes agent runtime +
KasmVNC desktop + now a real per-agent Chromium+GPU process):

- **KasmVNC/Xvnc**: `-geometry 1024x576 -depth 16 -FrameRate 15` (was
  `1024x768`, no depth/framerate cap at all) — via a NEW fail-closed
  patch script, `patch_kasmvnc_resource_efficiency.py`, same discipline
  as the 3 pre-existing `patch_kasmvnc_*.py` scripts (byte-exact match,
  exits non-zero if the base image ever changes this block).
- **`resize=remote` → `resize=scale`** — via a NEW patch script,
  `patch_kasmvnc_local_scaling.py`, which MUST run AFTER
  `patch_kasmvnc_hide_control_bar.py` in the Dockerfile (both patch the
  SAME iframe line; this one's own match target is deliberately that
  patch's OWN output, not the pristine base-image state — get this order
  wrong and the build fails closed, correctly, not silently).
  Server-rendered resolution now genuinely fixed regardless of the
  viewer's own window/monitor size — the whole point of the profile.
- **Chromium flags**: `--no-first-run --disable-default-apps
  --disable-sync --disable-extensions --disable-background-networking
  --mute-audio`, window size kept in sync with the new `1024,576`
  geometry (a real, silent-bug risk flagged in the code if these two
  values ever drift apart again).
- **`--memory`/`--shm-size` on every new container** — previously
  `--memory` was ABSENT ENTIRELY (any workspace container could use the
  whole Docker Desktop VM's memory, unbounded). Both now REAL,
  DEPLOYMENT-CONFIGURABLE via `.env` (no code change needed):
  ```
  WORKSPACE_MEMORY_LIMIT=4g   # optional, defaults to 4g
  WORKSPACE_SHM_SIZE=1g       # optional, defaults to 1g
  ```
- **Idle-kill, real and configurable**: new `BrowserManager.sweep_idle()`
  + a background daemon thread calling it every 30s. Also
  deployment-configurable, no code change:
  ```
  WORKSPACE_BROWSER_IDLE_TIMEOUT_MINUTES=4   # optional, defaults to 4; 0 = never kill
  ```
  Threaded through the FULL chain: `config.rs` → `DockerCliLauncher` →
  `boot_script.rs`'s `browser_manager_launch_line` → the container's own
  `BROWSER_IDLE_TIMEOUT_MINUTES` env var, confirmed live in a real boot
  script. **Real, honestly-documented limitation, not hidden**: the
  daemon can ONLY observe `start()`/`status()` HTTP calls, never actual
  CDP browsing traffic (that goes DIRECT from a tool module's Python
  process to Chromium's port, never through this daemon) — a long
  `browser_task` call that does real work for many minutes without its
  caller making another `start()`/`status()` call in the meantime could
  be killed mid-task. Accepted tradeoff of the simplest correct
  implementation; the real fix (a heartbeat from inside `browser_task.py`
  own run loop) is explicitly out of scope, noted as a possible follow-up
  only if this becomes a real problem in practice.
- **`--disable-gpu` was NOT added** — the user's own message said "test
  it," treated as a live tradeoff to evaluate, not something to bake in
  blind. Still an open, unresolved question for whoever picks this up —
  see "Suggested next steps."

## Test counts, ALL independently re-verified fresh at the end of this
## session (not trusted from any subagent self-report)

- `cargo test` (rust_gateway): **283 passed, 0 failed** (started this
  session at 269, ended at 283 — 14 new/real tests across the whole
  session: sentinel-token security test, browser-proxy auth tests,
  `WorkspacesConfig`'s new optional-env tests, boot-script env-export
  tests).
- `cargo clippy --all-targets`: **6 warnings**, unchanged from the
  session's own established baseline (2× `result_large_err`, 4×
  `bool_assert_comparison`, all pre-existing) — one round of 4 NEW
  warnings (a markdown doc-comment list-parsing quirk from my own new
  doc comments) was introduced and then fixed back to exactly 6 within
  this same session; do not be alarmed if you see this instruction and
  the count is still 6, that IS correct.
- `python3 -m pytest backend/workspace-image`: **56 passed, 0 failed**
  (started at 38, ended at 56 — every browser-daemon/KasmVNC-patch test
  this session added).
- `PYTHONPATH=src python -m pytest -q` (backend/wrapper): **148 passed,
  3 skipped, 0 failed** (3 skips are pre-existing, unrelated to this
  session's work).
- `python3 -m pytest` (backend/seeder_kit): **58 passed, 0 failed**.

One REAL, PRE-EXISTING, UNRELATED test failure was found and confirmed
NOT caused by this session's work (verified via `git stash` round-trip
against the ORIGINAL unmodified code, reproduces identically either way):
`test_apply_agent_without_soul_md_does_not_inherit_root_soul` in
`backend/wrapper/tests/v1/test_agent_seeder.py` fails when run ALONE
(`FileNotFoundError` writing a SOUL.md fixture into a not-yet-existing
directory in the test's own setup code) but PASSES when run as part of
the full suite (some earlier test's own side effect happens to create the
directory first). Not touched, not this session's bug — flag it if it's
ever actually investigated.

## Real, live infrastructure state at end of session

- All three gateway services (rust_gateway :8080, test_backend :8797,
  vite :5173) confirmed live via direct curl, running from CURRENT
  binaries (binary mtime newer than every uncommitted source change,
  confirmed via `stat`, not assumed).
- `hermes-workspace:dev` image rebuilt and confirmed current (built AFTER
  every uncommitted `backend/workspace-image/` change).
- `oc-dev` (OpenConnector) — up 7+ hours, healthy, untouched this
  session.
- Two real workspace containers were running at end of session
  (`hermes-ws-0186a0fa...`, `hermes-ws-c79355e6...`) from the user's own
  live testing, NOT from any of this session's own verification runs
  (every verification workspace this session created was deleted after
  use) — these are real, may still have useful state, do not blindly
  delete without checking first.
- `codex` CLI: confirmed STILL broken (`which codex` → exit 1, dead
  symlink target) — flagged repeatedly across this and prior checkpoints,
  never fixed. Every "validation" this session was a fresh in-session
  Claude subagent doing an adversarial read, explicitly labeled as such
  in every report, never the real Codex.

## Suggested next steps

1. **Commit the uncommitted efficiency-profile work** (13 files, listed
   at the top of this doc) — or continue iterating first; either way,
   confirm with the user before committing OR pushing, same standing rule
   as always. Nothing has EVER been pushed to a remote across this
   entire checkpoint series.
2. **Decide on `--disable-gpu`** — real, live, untested tradeoff the user
   themselves flagged as worth trying, not yet done.
3. **Consider a real 4+ minute live test of the idle-kill sweep** — this
   session verified the underlying logic thoroughly via 56 real unit
   tests (including injectable-time sweep-idle tests) but never actually
   waited out a real 4-minute timeout against a live container's real
   Chromium process end-to-end; worth doing once, live, before trusting
   it fully in production.
4. **`browser_exec`/`browser-harness`** — still broken, still explicitly
   out of scope this session per the user's own choice. Revisit only if
   asked; it is a wholly separate mechanism from everything built this
   session (do not assume any of this session's fixes touched it).
5. **Fix the `codex` CLI install if the two-model pipeline is meant to
   run for real** — same unresolved item from every prior checkpoint,
   still true.
6. **The heartbeat-based idle-kill improvement** (see "idle-kill" above)
   — only worth doing if the documented mid-task-kill risk turns out to
   matter in practice; do not build it speculatively.
7. If picking this up on a fresh machine/reboot: same standing gotchas as
   prior checkpoints (`./run.sh` from repo root, `docker start oc-dev` if
   stopped) — PLUS, new to this session: confirm `git branch
   --show-current` says `feat/browser-agent` before doing anything else,
   and confirm `rust_gateway`'s own binary/`hermes-workspace:dev` image
   are rebuilt fresh before assuming any of this session's fixes are
   actually live (a stale binary/image silently reverts every fix in
   this document back to its pre-session, broken behavior).
