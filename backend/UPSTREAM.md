# Upstream provenance

`backend/upstream/` is a nested git clone of the Hermes Web UI project,
pinned at:

```
e168b67e4278df618d1cab61fdb3a8dc55b29a81
```

The `wrapper/` project (a standalone package rooted at `backend/wrapper/`)
is built entirely against that pinned commit. `backend/upstream/` is a
local pinned checkout, excluded from this repository's git tracking (see
`../.gitignore`) and must never be edited by anyone working on the wrapper —
treat it as a read-only vendored dependency. Only the wrapper's pin metadata
in this file gets committed.

## Bootstrapping a fresh clone

Because `backend/upstream/` is git-ignored, a fresh clone of this
repository starts with it absent — the wrapper cannot run until it exists.
Create it with the bootstrap script:

```bash
./backend/bootstrap-upstream.sh
```

It clones the upstream project over **HTTPS** (no credentials, token, or
SSH key required), checks out the pinned commit above, and verifies that
the resulting `HEAD` matches that SHA exactly, failing loudly if it does
not. It is safe to re-run:

- directory missing → clone + check out the pin + verify
- directory already at the pinned commit → reports so and changes nothing
- directory at a **different** commit → reports the mismatch and exits
  non-zero without resetting anything (moving a pin is a deliberate act,
  see "Safely updating the pinned commit" below)

The equivalent manual steps, if you prefer to run them yourself:

```bash
git clone https://github.com/nesquena/hermes-webui.git backend/upstream
git -C backend/upstream checkout e168b67e4278df618d1cab61fdb3a8dc55b29a81
```

## Verifying the pin

```bash
cd backend/upstream
git rev-parse HEAD
# must print e168b67e4278df618d1cab61fdb3a8dc55b29a81
```

`./backend/bootstrap-upstream.sh` performs this same check (and reports a
mismatch as a non-zero exit) so it can be used as a CI gate.

If it doesn't match, someone has moved the upstream checkout without
updating this file (or without going through the update procedure below) —
treat that as a bug and re-pin or re-clone.

## Checking whether a newer upstream commit is available

`backend/upstream` is a normal git clone with `origin` already pointing at
the real Hermes WebUI project, so `git -C backend/upstream fetch`/`pull`
work today without any special setup. Use the read-only helper script
instead of a bare `pull` for routine checks — it fetches, reports whether
you're behind, and lists the new commits, but never changes the pinned
commit itself (that stays a deliberate step, see below):

```bash
./backend/sync-upstream.sh
```

## Safely updating the pinned commit

Never update `upstream/` and immediately rely on it in production. Follow
this sequence:

1. In a scratch clone (NOT the checked-in `upstream/`), fetch and inspect
   the new commit you want to pin:
   ```bash
   git -C /path/to/scratch-clone fetch origin
   git -C /path/to/scratch-clone log --oneline <old-pin>..<new-pin>
   ```
   Read the diff for changes to `server.py`, `api/routes.py`,
   `api/helpers.py`, `api/auth.py`, and `bootstrap.py` in particular —
   those are the files the wrapper's `transport/dispatcher.py` and
   `upstream.py` depend on structurally.
2. Point a **local, disposable** copy of `upstream/` (e.g. via
   `HERMES_WEBUI_UPSTREAM=/path/to/scratch-clone`) at the candidate commit
   and run the full wrapper test suite against it:
   ```bash
   cd backend/wrapper
   HERMES_WEBUI_UPSTREAM=/path/to/scratch-clone PYTHONPATH=src python3.11 -m pytest -q
   ```
   (or an equivalent supported Python 3.11+ interpreter)
3. Only if the suite passes, replace the local pinned `upstream/` checkout
   with the new commit (re-clone or `git -C backend/upstream fetch &&
   git -C backend/upstream checkout <new-pin>`) and update the pinned
   hash in this file.
4. Re-run `git -C backend/upstream rev-parse HEAD` one more time to
   confirm the local clone matches what you just tested, then commit the
   wrapper's updated pin metadata.

Never point production traffic at an upstream revision that has not passed
step 2.
