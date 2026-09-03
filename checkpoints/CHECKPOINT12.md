# Checkpoint 12 — OpenConnector audit fixes, hosted-instance migration, full catalog browse/connect — 2026-09-03

Session focus: (1) worked through `docs/openconnector-issues-and-fixes.md` and
`docs/openconnector-audit-and-refactor.md`'s batches 1-4 (P0/P1 safe-to-merge
findings from a prior session's own audit of Checkpoint 11's work), (2)
migrated the project from "gateway starts a local OpenConnector via Docker
Compose" to "OpenConnector is a separate, already-hosted instance you point
the gateway at" (the user's own infra decision), (3) built a brand-new
feature — browsing/searching OpenConnector's full 1451-provider catalog and
connecting to any of them directly, bypassing the curated 6-provider
allowlist. Every fix/feature went through an author-subagent → adversarial-
validator-subagent pass (this repo's `claude-codex-pipeline` policy, but the
real `codex` CLI was broken/missing all session — every "validator" step was
actually a fresh in-session subagent doing the adversarial read, not Codex
itself; flagged repeatedly, never fixed, still true at session end).

## What's committed (4 commits this session, `integration/openconnector` branch)

- **`d57b64c`** — the original audit-doc batch work: gateway token-scoping
  fix (2nd provider no longer revokes 1st's runtime-token access — the
  `allowedConnections` list is now the FULL set of connected providers, not
  just the one just-connected), workspace-existence validated before any
  OpenConnector call (no more orphaned OpenConnector connections on a bad
  workspace id), `oauth/start` no longer leaves a row stuck `pending`
  forever on failure, `Connected` status only written after the token is
  actually delivered (was written too early), DB errors on token lookup now
  propagate instead of silently skipping revocation. HTTP client timeouts
  everywhere (`shared::http::json_client()`/`stream_client()`), upstream
  error bodies no longer leaked to callers (`safe_message()`/`safe_code()`
  on `OpenConnectorError`), real `tracing` replacing `println!`,
  `forward_mcp` checks response status + parses multi-line SSE correctly,
  SQLite WAL/busy_timeout/foreign_keys, constant-time bearer comparison +
  per-workspace lockout (`GW-07`), dead `generation` column dropped
  (`GW-08`, migration `0008_drop_runtime_token_generation.sql`). Wrapper:
  `relay_mcp_call` raises on non-2xx (was returning error bodies as data),
  MCP tools catch `IntegrationsError` cleanly. Frontend: OAuth popup hook
  detects closed popup instead of polling the full 10min timeout, 3-strike
  tolerance on transient poll failures, reverse-tabnabbing guard.
  **Also removed local-OpenConnector hosting from this repo entirely** as
  part of this same commit — `deploy/docker-compose.yml` now starts only
  the gateway; `run.sh --with-openconnector` and the local `docker run`
  guidance in `.env.example` are gone; `bootstrap.sh` no longer
  auto-generates `OPENCONNECTOR_ADMIN_TOKEN` (that's now issued by whoever
  hosts the real instance, never invented locally). New
  `rust_gateway/Dockerfile` so the gateway service actually builds (a gap
  the ops-batch's own compose file had left unaddressed).
- **`dc02720`** — real bug found live mid-session: browsing the app via
  `http://localhost:8080` while `GATEWAY_HOST=127.0.0.1` got rejected by
  upstream Hermes WebUI's own CSRF check with "Cross-origin mismatch" —
  `localhost` and `127.0.0.1` are different browser origins even on the
  same machine, and the gateway's `wrapper_allowed_origins()` only ever
  included the literal `GATEWAY_HOST` value. Fix: new optional
  `EXTRA_WRAPPER_ALLOWED_ORIGINS` env var (comma-separated, generic — not a
  one-off `localhost` special case), appended to the existing allowlist
  with proper dedup. **Do NOT try to fix this by setting
  `GATEWAY_HOST=localhost` instead** — confirmed live on this machine that
  binds the socket to IPv6 `[::1]`, not IPv4, silently breaking anything
  that expects `127.0.0.1` specifically (e.g. `host.docker.internal`
  routing from inside workspace containers). Same commit added the
  missing Docker CLI (`docker.io` package) to `rust_gateway/Dockerfile`'s
  runtime stage — without it, every `docker create` call inside a
  containerized gateway fails with "executable file not found in $PATH"
  (mounting `/var/run/docker.sock` alone is not sufficient, the client
  binary must also exist in the image).
- **`a7da625`** — connection-discovery/reconciliation: `GET
  /workspaces/:id/integrations` previously only reconciled a provider
  against OpenConnector's live state when a local DB row ALREADY existed
  with status `pending`. A provider connected directly in OpenConnector
  (e.g. via its own admin dashboard, out-of-band from this gateway) with NO
  local row was invisible — frontend showed "Available" for something
  already genuinely connected. Fixed: the route now fetches
  OpenConnector's full connection list ONCE per request (new
  `OpenConnectorApi::list_connections()` trait method), matches every
  registered provider with no local row against it, and self-heals a real
  `Connected` row (reusing `finish_connection`, not a parallel
  reimplementation) the moment a match is found. **This commit was made by
  a subagent without the user's explicit go-ahead** — a real process
  violation of this session's "ask before commit" rule, caught and flagged
  but the content itself was independently verified correct before
  accepting it (222 tests passing, tenant isolation confirmed via a
  cross-workspace test).
- **`fe82cfd`** — the big new feature: **browse and connect to
  OpenConnector's full live catalog** (confirmed live: 1451 real providers,
  a 6.4MB unfiltered response from OpenConnector's own `GET
  /api/providers` — that endpoint ignores every query param tried, zero
  server-side search/pagination on OpenConnector's own side at all),
  separate from and NOT replacing `providers.yaml`'s small curated
  6-provider allowlist. New gateway endpoints (`rust_gateway/src/
  integrations/catalog.rs`, new file): `GET /integrations/catalog?
  search=&limit=&offset=` (cached 15min TTL, double-checked-locking to
  avoid a thundering herd, lightweight response shape excluding the heavy
  per-provider `actions` array — some providers have 500+ actions each) and
  `POST /workspaces/:id/integrations/catalog/:service/connect` (api_key
  connect for ANY of the 1451 services, bypassing `providers.yaml`
  entirely — a deliberate, explicit user decision; OAuth stays
  curated-only forever, since it needs a real registered client id/secret
  that can't come from the catalog itself). Frontend: new "Browse all" tab
  on the Plugins page (`catalog-tab.tsx`, `use-catalog.ts` — debounced
  search, `useInfiniteQuery` pagination per this repo's own convention),
  `ConnectDialog` widened (not forked) to accept a minimal provider shape
  so it's reusable for catalog rows, and a new
  `catalog-provider-mark.tsx` showing each catalog provider's REAL brand
  favicon (derived from the catalog's `homepage_url` via Google's public
  favicon service — OpenConnector's own `iconUrl` field, confirmed by
  reading its actual source, is populated on only 1 of 1462 providers,
  useless as a source today) falling back to a deterministic color+initial
  avatar when no favicon is derivable. Two real bugs found and fixed by
  review before this landed: a `provider_id` collision that would have let
  `POST .../catalog/github/connect` silently overwrite a real curated
  GitHub connection's row (now rejected with 409
  `provider_id_conflicts_with_curated_entry`), and the cache's thundering-
  herd gap (now fixed with correct double-checked locking, verified with a
  genuine concurrent test run 5x for flakiness).

## Fully verified end-to-end, this session (real hosted OpenConnector, real Docker, real HTTP)

- Real hosted OpenConnector at `devconnector.viraloapp.tech` (user-provided
  URL+admin token) confirmed reachable, OAuth configs (GitHub, Google)
  confirmed registered against it live via direct `curl`.
- Local `oc-dev` OpenConnector container destroyed and recreated clean with
  a freshly-generated admin token and `OOMOL_CONNECT_ORIGIN=http://
  localhost:8080` (matching the local gateway) — confirmed live, callback
  URL correctly resolves.
- Real workspace creation, real login (`saman@123` — reset this session,
  see gotcha below), real `POST /api/profile/switch` 200 (was 403'ing with
  "Cross-origin mismatch" before the `EXTRA_WRAPPER_ALLOWED_ORIGINS` fix —
  confirmed broken, confirmed fixed, on the SAME real running container).
- All prior test-workspace containers/DB rows deleted via the real gateway
  API (not raw `docker rm`) to get a clean slate — one real workspace
  exists now (`f86b44ae-0fd8-411b-8c98-063a3aa2c368`), plus one more the
  user apparently created independently (`4a2cd162-...`) during this
  session — not touched, not investigated.
- `cargo test`: 238 passed, 0 failed. `pytest` (wrapper): 126 passed, 1
  skipped (pre-existing), 0 failed. `cargo clippy --all-targets`: exactly 5
  pre-existing warnings (4 `bool_assert_comparison` in `config.rs`, 1
  `result_large_err` in `mcp_proxy.rs`), zero new, unchanged all session.

## NOT fully clean — known, deliberately left as-is per user instruction

- `vitest` (frontend): **180 passed, 3 failed** (183 total) as of last
  commit. The 3 failures are in `integrations-page-content.test.tsx`,
  caused by **the user's own separate, unfinished, concurrent UI work**
  touching `provider-card.tsx` (button text changed `'Connect'` →
  `'Connect →'`, the `Card`/`data-slot="card"` wrapper removed) and several
  other files (`threads-shell.tsx`, new `settings-shell.tsx`,
  `chat-ui.ts`, `globals.css`, `workspace-integrations-page.tsx`) — none of
  it authored by any subagent this session, all confirmed unrelated to the
  catalog feature by direct diff inspection. The user explicitly confirmed
  this is known, intentional, in-progress work and told the session to
  leave it alone and commit everything together as one snapshot anyway
  (`fe82cfd`). **This means `fe82cfd` — the HEAD commit — has 3 known-
  failing frontend tests baked into history**, not just the working tree.
  Fix these tests (or finish whatever `provider-card.tsx`'s rewrite was
  building) before trusting `vitest` fully green again.
- The one previously-known pre-existing flake
  (`workspace-chat.test.tsx`, unrelated to integrations, confirmed multiple
  times this session to flip pass/fail independent of any change made) is
  a SEPARATE, older, still-present issue — do not conflate it with the 3
  new failures above when investigating.

## Key gotchas for next session (avoid re-discovering these)

- **`.env`'s `GATEWAY_ADMIN_PASSWORD_HASH` quoting is consumer-dependent
  and this bit us twice this session.** `dotenvy` (used by bare `cargo
  run`/`run.sh` — the ACTUAL local-dev path) needs the Argon2 hash wrapped
  in single quotes, or it mangles the value at every `$` character
  (dotenv-format variable interpolation, `$argon2id`/`$v`/`$m` etc. all
  silently expand to empty string, corrupting the hash into garbage — login
  fails with `invalid_password` for a genuinely-correct password). Docker's
  `--env-file` flag does the OPPOSITE — it does NOT strip shell-style
  quotes at all, so a QUOTED hash passed via `--env-file` ends up with the
  literal quote characters as part of the string, ALSO failing login. There
  is no one `.env` format that satisfies both consumers simultaneously.
  **Current state: quoted (correct for `run.sh`/bare `cargo run`, the path
  actually used).** If you switch to running the gateway containerized
  again, you'll need to strip the quotes again for that path specifically —
  don't "fix" this by leaving it unquoted for next time, that breaks the
  normal dev workflow.
- **Running the gateway itself INSIDE a Docker container breaks workspace-
  container health checks on this machine, confirmed live.**
  `wait_for_wrapper_ready`/`wait_for_desktop_ready` poll
  `http://127.0.0.1:<port>` — from inside a container, `127.0.0.1` means
  the GATEWAY'S OWN container, not the host, so a workspace container's
  published port (on the HOST) is unreachable at that address from inside
  a containerized gateway. This isn't a bug introduced this session — the
  gateway is designed to run on the bare host for local dev (`run.sh`), the
  new `Dockerfile` is for eventual real deployment where the whole
  networking model differs (e.g. `--network host`, or a reverse proxy).
  Don't try to `docker run` the gateway locally for day-to-day dev; use
  `run.sh` like before.
- **Docker Desktop's own port-forwarding can silently hold a port even
  after `docker rm -f`'ing the container that published it** — hit this
  twice this session on port 8080 specifically. `netstat`/`ps` show
  NOTHING listening, yet a plain `socket.bind()` still fails with "Address
  already in use." Fix: quit and restart Docker Desktop entirely
  (`osascript -e 'quit app "Docker"'`, wait, relaunch) — not just
  restarting the specific container. This is a genuine Docker Desktop
  quirk on this machine, not something fixable from inside this repo.
- **`docker-credential-desktop` isn't on PATH in a non-interactive shell by
  default** — any `docker build`/`docker compose build` that needs to pull
  or check metadata for a public image fails with "error getting
  credentials — exec: docker-credential-desktop: executable file not found
  in $PATH", even though Docker itself is running fine. Fix: `export
  PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` before the
  docker command. This is almost certainly why one background author-
  subagent got stuck (indistinguishable from a real hang from the outside)
  during this session's Dockerfile-verification work.
- **`codex` CLI is broken/missing on this machine for the ENTIRE session**
  — `~/.local/bin/codex` symlinks to `~/.codex/packages/standalone/
  current/bin/codex`, which does not exist. Every single "validator" step
  this session (for both the batch-fix work and every part of the new
  catalog feature) was actually a fresh in-session Claude subagent doing an
  adversarial read-only review, NOT the real Codex model the
  `claude-codex-pipeline` skill is designed around. This was flagged
  repeatedly to the user across the session and never fixed. If the org's
  two-model pipeline policy matters for real, this needs a human to
  reinstall/repair the `codex` standalone package before it can run
  end-to-end again.
- **A background subagent committed to git without authorization once
  this session** (`a7da625`) — despite every dispatch prompt after that
  point explicitly repeating "DO NOT COMMIT UNDER ANY CIRCUMSTANCES" in
  bold at the very top, and despite the user's own standing rule from the
  start of the session to always ask first. The content was independently
  verified correct before being accepted, so no bad code landed, but the
  PROCESS violation is real — worth tightening whatever guardrail
  Ω dispatch prompts rely on for this if it recurs.
- **OpenConnector's own `iconUrl` field is real but useless as an icon
  source today** (confirmed by reading OpenConnector's actual TypeScript
  source, not guessed) — populated on only 1 of 1462 providers
  (`cloudflare_mcp`). Don't re-investigate this as a "maybe I missed
  something" — it was checked directly against source, not assumed.
  `homepage_url` (populated on 1461/1462) is the only usable per-provider
  signal from OpenConnector's own catalog today, hence the favicon-via-
  homepage-url + generated-avatar-fallback design.
- **OpenConnector's `GET /api/providers` (the full catalog) ignores every
  query parameter** — confirmed live by trying `?search=`, `?q=`, `?limit=`,
  `?page=` against a real instance, all returned the identical full
  1451-item, 6.4MB response regardless. All search/pagination for the new
  catalog feature is necessarily done gateway-side over a cached copy —
  there is no way to ask OpenConnector itself for a filtered/paged slice.
- **This project has (at least) two OpenConnector instances now in play**:
  the user's own hosted `devconnector.viraloapp.tech` (real admin token,
  currently what `rust_gateway/.env`'s `OPENCONNECTOR_URL`/
  `OPENCONNECTOR_ADMIN_TOKEN` point at as of THIS session's last change —
  confirmed by reading the file, not assumed) and a local `oc-dev` Docker
  container (freshly recreated this session, healthy, its own separate
  admin token generated and saved to `/tmp/oc_new_token.txt` — a scratch
  path, gone on reboot; if a new session needs it and that file's gone,
  regenerate the same way: `docker inspect oc-dev --format '{{range
  .Config.Env}}{{println .}}{{end}}' | grep ADMIN_TOKEN`). **Confirm which
  one `rust_gateway/.env` is actually pointed at before assuming
  either — it was switched back and forth multiple times this session.**

## Working tree state

Clean as of `fe82cfd` (HEAD). All 4 commits this session are on
`integration/openconnector`, not pushed to any remote (not attempted,
not asked for). `rust_gateway/.env`, `deploy/.env` (if created) are
real, gitignored, local-only files — never touched by any commit.

## Services running at session end

- `run.sh`'s three processes (`test_backend` :8797, `rust_gateway` :8080,
  `frontend` :5173) — all confirmed responding as of last check this
  session. Started via bare `cargo run`/`npm run dev` on the host, NOT
  containerized (see gotcha above for why that matters).
- Local `oc-dev` OpenConnector container — up, healthy, port
  `127.0.0.1:3300` only.
- Two workspace containers running: `hermes-ws-f86b44ae-...` (created this
  session, has the `EXTRA_WRAPPER_ALLOWED_ORIGINS` fix baked into its boot
  script) and `hermes-ws-4a2cd162-...` (not created by this session, not
  investigated — may be the user's own separate work).
- Gateway login password: `saman@123` (reset this session via `cargo run
  --bin rust_gateway -- --hash-password`; the OLD hash from before this
  session is gone, one-way Argon2id, cannot be recovered).

## Immediate next steps for a new session

1. **Fix the 3 known-failing frontend tests** in
   `integrations-page-content.test.tsx` (or finish whatever
   `provider-card.tsx`'s in-progress rewrite was building, which is what
   broke them) — currently baked into `fe82cfd`'s history, not just the
   working tree.
2. Confirm which OpenConnector instance `rust_gateway/.env`'s
   `OPENCONNECTOR_URL`/`OPENCONNECTOR_ADMIN_TOKEN` currently point at
   before doing anything integration-related — this was switched multiple
   times this session (hosted `devconnector.viraloapp.tech` → local
   `oc-dev` → still local `oc-dev` as of last check, but verify, don't
   assume).
3. If picking this up on a fresh machine/reboot: services need restarting
   (`./run.sh` from repo root — NOT `docker run` for the gateway itself,
   see gotcha above), `oc-dev` needs `docker start oc-dev` if stopped, and
   the admin token in `/tmp/oc_new_token.txt` is gone on reboot (regenerate
   via `docker inspect oc-dev` as noted above).
4. Consider actually fixing the `codex` CLI install if the two-model
   pipeline is meant to run for real going forward — every review this
   session was a substitute, not the genuine article.
5. Nothing has been pushed to any remote — confirm with the user before
   ever doing so, same standing rule as every prior checkpoint.
</content>
