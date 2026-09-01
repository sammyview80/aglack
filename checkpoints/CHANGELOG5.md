# Changelog 5

Everything changed this session, in commit order. See `CHECKPOINT5.md` in
this same folder for the full narrative/root-cause detail behind each
entry; this file is the terse commit-by-commit record.

## 2026-09-02 (continued from Changelog 4)

### Added

- **Per-agent workspace auto-creation.** `config.py`'s new
  `resolve_agent_workspaces_root()` derives the per-agent workspaces root
  from `HERMES_WEBUI_DEFAULT_WORKSPACE`'s own parent directory (fails
  closed if unset). `features/agent_seeder/service.py`'s new
  `_ensure_agent_workspace` creates a real `<root>/<agent-slug>/`
  directory for a newly seeded agent (e.g. `/workspace/pm`) and writes it
  into that profile's `config.yaml` as `workspace`, before applying
  `agent.md` — closing the gap where `create_profile_api` alone never
  sets a workspace, so every seeded agent's `AGENTS.md` was silently
  skipped. Never overwrites an already-configured workspace.
  (`backend/wrapper/src/hermes_webui_wrapper/config.py`,
  `.../features/agent_seeder/service.py`,
  `backend/wrapper/tests/v1/test_agent_seeder.py`,
  `backend/wrapper/.env.example`, `backend/wrapper/AGENTS.md`,
  `backend/seeder/README.md`)

### Fixed

- **Real end-to-end test (real Docker, real gateway, real container, no
  fakes) found a genuine bug every unit test had missed**: applying a
  seed mode against a real container failed with
  `agent_seeder_workspace_create_failed` /
  `"[Errno 13] Permission denied: '/workspace/pm'"`. Root cause,
  confirmed live via `docker exec`: the boot script's
  `chown -R abc:abc {workspace_default_path}` only ever chowned the LEAF
  directory (`/workspace/default`), never its parent (`/workspace`) —
  the new per-agent workspace feature needs to `mkdir` a sibling
  directory under that parent, as `abc`, which was impossible.
  New `workspace_chown_target()` computes the correct PARENT to chown
  (falls back to the path itself only if the parent would be filesystem
  root `/`). The existing test asserting
  `script.contains("chown -R abc:abc /workspace")` had been silently
  non-discriminating the whole time (that substring is also a prefix of
  the buggy `chown -R abc:abc /workspace/default` output) — replaced
  with an exact line-match assertion, plus 2 new direct unit tests for
  `workspace_chown_target`.
  (`rust_gateway/src/workspaces/container/boot_script.rs`)

### Verified (real end-to-end, no fakes)

- Rebuilt `hermes-workspace:dev` from scratch via a real `docker build`.
- Ran the real `rust_gateway` binary with its real `DockerCliLauncher`
  (not `FakeLauncher`), created a genuinely running Docker container via
  the real `POST /workspaces` API.
- Ran the real `POST /workspaces/:id/agent-seeder/simple/apply` call
  through the full `gateway → container's wrapper → upstream
  api.profiles` chain, twice (idempotency check).
- Verified every claimed artifact directly against the real container's
  filesystem via `docker exec` — not inferred from the HTTP response
  alone: `/workspace/pm` (created, `abc`-owned), its `AGENTS.md`, the
  profile's `config.yaml` (`workspace: /workspace/pm`) and `SOUL.md`, and
  the seeded skills.
- This is what actually found the boot-script bug above — every existing
  unit/integration test suite (wrapper 67, gateway 91, all green at the
  time) had missed it, since none of them exercise a real container's
  filesystem permissions.

### Docs

- `checkpoints/CHECKPOINT5.md` added, including a "lesson for future
  sessions" section: unit-test-green does not mean container-correct for
  anything the boot script sets up (env vars, directory ownership,
  mounted paths) — a real `docker build` + `POST /workspaces` +
  `docker exec` pass is how this bug was actually found.
</content>
