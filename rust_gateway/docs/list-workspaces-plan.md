# List-workspaces route — plan (plain language)

Status: **planning only, nothing built yet**. This is the "how" before the
"code."

## What we're building

One API endpoint: "give me the workspaces that exist." `GET /workspaces`,
returning an array of `{ workspace_id, name, status, host_port,
desktop_port, created_at }` — enough for a frontend dashboard to render a
list and know which ones it can link into (`Ready` + ports set) versus
which are still `creating`/`failed`.

## Why "optimized" and what that means here

The wrapper's own onboarding routes earned that word by skipping a full
proxy/dispatch replay for calls that don't need it (see
`backend/wrapper/AGENTS.md`). The same discipline applies here:

- **One SQL query, no N+1.** A naive implementation might call
  `find_by_workspace_id` once per row after some other lookup — this does
  not: `list_workspaces` is a single `SELECT ... ORDER BY ... LIMIT ...
  OFFSET ...` against `workspace_creations`, full stop.
- **No container/network calls.** This is a pure DB projection. It does
  NOT re-check a workspace's live health (unlike `resolve.rs`'s per-request
  readiness check on the proxy routes) — `status`/ports are exactly what
  the last `mark_ready`/`mark_failed` wrote. A stale-but-cheap read, not a
  fresh-but-expensive one. Callers that need live confirmation still go
  through the existing per-workspace proxy routes.
- **Only listing-relevant columns.** No `idempotency_key` exposed as its
  own field — it's surfaced as `name` (see below), the only column name
  meaningful to a caller.

## Naming: `idempotency_key` IS the workspace name

`workspace_creations.idempotency_key` is the caller-supplied `name` from
`POST /workspaces` (see `route.rs`'s module doc and
`migrations/0001_workspace_creations.sql`). The list response calls this
field `name`, not `idempotency_key` — the latter is an internal
implementation detail of the retry mechanism, not something a frontend
should know or depend on.

## Pagination

Small, explicit, optional: `?limit=<n>&offset=<n>` query params, both
optional. Default `limit` 50, capped at 200 server-side (a caller passing
`limit=100000` must not be able to force one query to return the entire
table uncontrolled). Invalid values (non-numeric, negative) are rejected
with `400 invalid_pagination` rather than silently clamped — silent
clamping would hide a caller's bug (e.g. a typo'd query param) behind a
response that still looks superficially fine.

Ordered by `created_at DESC` (newest first) — matches "what did I just
create" being the common dashboard use case, and gives a stable, sensible
order for `limit`/`offset` to page through.

## Response envelope

Same shared envelope as every other route in this gateway
(`crate::response`): `{ ok: true, data: { workspaces: [...], limit,
offset } }`. `limit`/`offset` echoed back in the response so a paging
frontend doesn't need to separately track what it asked for.

## Where things live

- `store.rs` — new `WorkspaceStore::list` method, the one new SQL query.
- `route.rs` — new `list_workspaces_route` handler + response DTOs,
  alongside the existing `create_workspace_route`.
- `app.rs` — `GET /workspaces` registered next to the existing `POST
  /workspaces` on the same path.

No new module: this is small enough, and shares state
(`WorkspacesState`/`WorkspaceStore`) closely enough with the existing
create-workspace route, that a new file would only add indirection.
