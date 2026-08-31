# Create-workspace route — plan (plain language)

Status: **planning only, nothing built yet**. This is the "how" before the
"code."

## What we're building

One API endpoint: "create me a new workspace." A workspace is one Docker
container (built from `backend/workspace-image/Dockerfile`) running Hermes
Agent + Hermes WebUI + our wrapper, that a user can open in their browser.

## The problem this plan solves

If a user clicks "create workspace" and their internet hiccups, or they hit
refresh, or their browser silently retries the request — we must not spin
up a second container by accident. One click, one workspace, no matter how
many times the request actually reaches the server.

## How we solve it: remember what we've already done

Every create-workspace request carries an **idempotency key** — a unique
value that identifies "this one specific attempt to create a workspace,"
generated once and reused if the request needs to be retried.

The flow:

1. Request comes in with a key.
2. We check: "have I seen this exact key before?"
   - **Yes** → don't create anything new. Just return the same workspace
     info we returned last time.
   - **No** → create a new container, remember the key + the result, return
     it.

This record of "which keys we've seen and what we did about them" has to
survive a server restart, or a retry after a restart would slip through and
create a duplicate anyway. So it's saved to a real file on disk (SQLite), not
just kept in memory.

## Where things live

- **SQLite database file** — created automatically the first time the
  gateway starts, if it doesn't already exist. No manual setup step. Its
  location is configurable (via `.env`, matching the "no hardcoded values"
  rule already in place), defaulting to a file under `rust_gateway/data/`.
- **One table** — a simple record per idempotency key: the key itself, what
  workspace it created (or is creating), and when.

## What "create a container" actually does

1. Look up the idempotency key. If already handled, stop here and return
   the existing result.
2. Otherwise: ask Docker to build/run a new container from
   `backend/workspace-image/Dockerfile` (building the image once and
   reusing it for every workspace after that — not rebuilding it per
   request).
3. Give the new container a unique name and its own storage, so it doesn't
   collide with any other workspace's container or files.
4. Save the result (workspace ID, container info) into the same SQLite
   database, tied to that idempotency key.
5. Return the workspace's info to the caller (at minimum: a workspace ID;
   connection details come once the container is confirmed running).

## What this plan does NOT cover yet

- Waiting for the container to finish booting / health-checking it before
  saying "ready" (comes right after this, not skipped forever).
- Deleting or stopping a workspace.
- Multiple users/auth — right now this is single-tenant plumbing; a real
  user/tenant identity gets layered in later (see
  `backend/wrapper/docs/rust-gateway-architecture.md`).
- Anything about billing or limits on how many workspaces one user can make.

## Testing approach (per rust_gateway/AGENTS.md: test-driven)

Before writing the real logic, write tests proving:
- calling create-workspace twice with the SAME idempotency key returns the
  SAME workspace, and does not create a second container
- calling it with two DIFFERENT keys creates two separate workspaces
- the SQLite file gets created automatically if it doesn't exist yet

These tests get written first, fail (nothing exists yet), then we build the
feature until they pass.
