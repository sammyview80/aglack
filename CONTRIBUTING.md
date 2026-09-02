# Contributing

Thanks for your interest in improving this project.

Before anything else, please read the [Code of Conduct](CODE_OF_CONDUCT.md).

## License — read this first

This project is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE). It is **source-available, not
open source**: you may use, copy, modify, and share it for **noncommercial
purposes only**. Commercial use is not permitted under this license.

By contributing, you agree that your contribution is licensed under those same
terms, and that you have the right to submit it.

## What this repository contains

Four components, each with its own test suite and its own conventions:

| Path | What it is | Tests |
| --- | --- | --- |
| `rust_gateway/` | Rust (axum) control plane: workspace registry + Docker orchestration + per-workspace proxy routes | `cargo test` |
| `backend/wrapper/` | Python FastAPI sidecar wrapping the pinned upstream Hermes Web UI | `pytest` |
| `backend/seeder_kit/` | Python library: seeder tree parsing, tool discovery, MCP runner | `pytest` |
| `frontend/` | React 19 + Vite + TypeScript UI | `npm run build`, `npm test` |

There is also `backend/workspace-image/` (the workspace container Dockerfile
and the patch scripts it applies), which has a small fast test suite of its own.

## Setting up a fresh clone

### 1. Bootstrap the pinned upstream checkout — required

`backend/upstream/` is a pinned third-party checkout of the Hermes Web UI
project. It is **git-ignored**, so a fresh clone does not have it, and the
wrapper cannot run — or even collect its tests — until it exists.

```bash
./backend/bootstrap-upstream.sh
```

This clones over public HTTPS (no credentials, token, or SSH key needed),
checks out the pinned commit recorded in [`backend/UPSTREAM.md`](backend/UPSTREAM.md),
and verifies `HEAD` matches it exactly. It is safe to re-run and never
overwrites an existing checkout — if it finds a different commit it reports the
mismatch and exits non-zero rather than resetting anything.

Treat `backend/upstream/` as a **read-only vendored dependency**. Never edit it.
Moving the pin is a deliberate act with its own procedure — see
`backend/UPSTREAM.md`.

> This step is genuinely required, not a formality: 6 of the wrapper's 10 test
> modules import the real upstream `api.*` package (`from api.profiles import
> …`), and `create_app()` bootstraps and revision-checks the checkout. Without
> it they fail at collection time with
> `RuntimeError: upstream checkout is missing or not a directory`.

### 2. Install the Python packages — order matters

**Install `seeder_kit` *before* `wrapper`.** This is not a preference; the
wrapper will fail to install otherwise.

```bash
python3.11 -m venv .venv && source .venv/bin/activate

python -m pip install -r backend/wrapper/requirements-dev.txt
python -m pip install -e backend/seeder_kit   # FIRST
python -m pip install -e backend/wrapper      # THEN this
```

Why: `backend/wrapper/pyproject.toml` depends on a bare, unversioned
`seeder-kit` name, and **there is no `seeder-kit` package on PyPI**. A relative
`file://` URL cannot be used there (`uv pip install -e <dir>` cannot resolve a
relative URL declared inside a package's own metadata, so it would break both
local dev and the Docker image). The bare name is instead satisfied by whatever
is already installed in the environment — which is why the sibling checkout has
to go in first. Install the wrapper first and pip will go looking on PyPI for a
package that does not exist. The same two-step order appears in
`backend/workspace-image/Dockerfile`.

Both packages require **Python 3.11 or newer**.

### 3. Frontend

```bash
cd frontend && npm ci
```

## The four verification suites

All four must stay green. These are the same commands listed in the README's
"Verifying a change" section, and the same ones CI runs.

```bash
(cd rust_gateway && cargo test)
(cd backend/wrapper && python -m pytest)
(cd backend/seeder_kit && python -m pytest)
(cd frontend && npm run build)
```

Notes:

- **wrapper** needs `./backend/bootstrap-upstream.sh` to have been run, and
  reads `HERMES_FRONTEND_ORIGIN` (copy `backend/wrapper/.env.example` to
  `.env`, or set it inline — it must match the Vite origin, e.g.
  `http://localhost:5173`). If you use the checked-in virtualenv, that is
  `.venv/bin/pytest`.
- **frontend** `npm run build` is `tsc -b && vite build`, so it is the
  typecheck gate as well as the build. `npm test` runs Vitest separately.
- **`cargo test`** fakes the Docker boundary (`FakeLauncher`). Anything
  touching the container boot script, env vars, directory ownership, or mounts
  **also** needs a real `docker build` + `POST /workspaces` + `docker exec`
  check. A fully green unit suite has already missed a real
  container-permissions bug once.

### Additional suites

```bash
# Dockerfile-contract tests for the workspace image (fast, stdlib only)
(cd backend/workspace-image && python -m pytest)
```

That directory uses a two-tier scheme defined in its `pytest.ini`: the fast
`test_*.py` files are collected by default, while
`e2e_test_kasmvnc_lastactiveat.py` is excluded by its filename because it shells
out to a real `docker build`/`docker run`. Run it deliberately when you need it:

```bash
(cd backend/workspace-image && python e2e_test_kasmvnc_lastactiveat.py)
```

## Linting and formatting

```bash
# Rust
(cd rust_gateway && cargo fmt --all -- --check)
(cd rust_gateway && cargo clippy --all-targets -- -D warnings)

# Python (config: ruff.toml at the repo root, shared by all three packages)
ruff check .

# Frontend
(cd frontend && npm run lint)
```

Two format checks run in CI as **advisory, non-blocking** steps, because
neither formatter has been applied to this codebase yet and enforcing them
today would mean a repo-wide mechanical reformat:

- `ruff format --check` would currently rewrite ~51 of 71 Python files.
- `(cd frontend && npm run format:check)` would rewrite ~53 of 134 source files.

Both configs are tuned to match the existing style (Python: double quotes,
4-space indent; TypeScript: single quotes, no semicolons, 2-space indent), so
adopting them later should be a pure re-wrap. If you want to adopt one, do it
as its **own commit** containing nothing but the reformat, then flip that CI
step to blocking.

Lint strictness is deliberately a conservative baseline that the existing code
passes today (ruff: `E4`, `E7`, `E9`, `F`, `B`; clippy: the default set, with
no `pedantic`/`nursery`). Tighten one rule family at a time, with the resulting
fixes in the same commit — see the comments in `ruff.toml` and
`rust_gateway/clippy.toml` for the specific rules queued up next.

## Conventions

These mirror the README's "Contributing / conventions" section.

- **Read the component's `AGENTS.md` before changing it.** Each states that
  component's structure rules and test requirements:
  - [`rust_gateway/AGENTS.md`](rust_gateway/AGENTS.md) — module layout, the
    test-driven rule, and the "no hardcoded host/port/URL — every network
    address comes from `config.rs` via env vars" rule.
  - [`backend/wrapper/AGENTS.md`](backend/wrapper/AGENTS.md) — how the wrapper
    relates to the pinned upstream, and what must never be mutated.
  - [`frontend/AGENTS.md`](frontend/AGENTS.md) — the fixed new-workspace
    routing chain, shadcn-first component rules, and the rule that `VITE_*` is
    read only in `src/lib/env.ts`.
- **`rust_gateway` is test-driven.** Write the failing test first, make it
  pass, keep it. No code without a test proving the behavior.
- **Feature plans live next to the code** as short plain-language docs in
  [`rust_gateway/docs/`](rust_gateway/docs) named `*-plan.md` (for example
  `create-workspace-plan.md`, `list-workspaces-plan.md`,
  `streaming-proxy-plan.md`). **Read the matching plan before touching a
  feature; add one before building a new feature** — it explains the "why" so
  the code doesn't have to.
- **One logical change per PR.** Split unrelated refactors and cleanup.
- **Do not hand-edit `CHANGELOG`/`CHECKPOINT` files.** The release process owns
  them. Put release-note wording in the PR description instead.
- **Update the docs** when you change setup, onboarding, runtime behavior,
  architecture, testing guidance, or user-facing workflows.
- Session history and architecture evolution live in `checkpoints/`; research
  notes in `docs/`. For an environment/config-looking bug (especially CORS),
  read `docs/troubleshooting.md` first.

## Opening a pull request

1. Run the four suites and record the results.
2. Fill in the PR template, including the **"Not verified"** section — say
   plainly what you could not check.
3. For behavior changes, add or update tests: a test should fail before your
   change and pass after it.
4. For UI changes, include before/after images at desktop and narrow widths.

## Security

Please do not report security issues in a public issue. See
[SECURITY.md](SECURITY.md); report privately via a GitHub security advisory on
this repository.

Never include secrets in an issue, PR, or test fixture — API keys, tokens,
cookies, full `.env` or `auth.json` files, or password hashes. Redact before
pasting logs.

## Known gaps

Honest list of things a contributor will notice:

- **Runtime Python dependencies are unpinned.** `backend/wrapper/pyproject.toml`
  declares floors without ceilings (`fastapi>=0.110`, `uvicorn>=0.29`,
  `pyyaml>=6.0`, `cryptography>=42.0`, `pydantic>=2.0`); only seeder_kit's
  optional `mcp>=1.28,<2` has an upper bound. Two installs weeks apart can
  therefore resolve different versions. As a partial mitigation, the **test**
  toolchain is pinned in `backend/wrapper/requirements-dev.txt` and
  `backend/seeder_kit/requirements-dev.txt`, and CI installs from those. Pinning
  the runtime set properly belongs in the `pyproject.toml` files.
- **No auth gate yet on gateway routes** (including `agent-config` /
  `agent-seeder`) — do not expose an instance publicly as-is.
- No billing; SQLite single-machine stage.
- Neither code formatter is enforced yet (see "Linting and formatting").
