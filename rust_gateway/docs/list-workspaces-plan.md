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

- **One SQL query, no N+1 at the DB layer.** A naive implementation might
  call `find_by_workspace_id` once per row after some other lookup — this
  does not: `WorkspaceStore::list` is a single `SELECT ... ORDER BY ...
  LIMIT ... OFFSET ...` against `workspace_creations`, full stop.
- **Live health, fanned out concurrently, not serially.** Per direct
  product decision, this endpoint DOES report real-time health, not just
  the DB's last-written `status` — a workspace that crashed after
  `mark_ready` must not read as `ready` forever (see "Live health check"
  below for the exact mechanism and its cost tradeoffs).
- **Only listing-relevant columns.** No `idempotency_key` exposed as its
  own field — it's surfaced as `name` (see below), the only column name
  meaningful to a caller.

## Live health check (per-row, concurrent, bounded)

Earlier draft of this doc proposed a pure DB projection with NO live
check, deferring health entirely to a hypothetical
`GET /workspaces/:id/health` endpoint. Direct instruction overrode that:
the list response itself must reflect live container health, no separate
endpoint. This section documents the actual mechanism and what it costs.

- Only rows with `status == Ready` (and therefore a recorded
  `host_port`) are checked at all — `Creating`/`Failed` rows have no
  wrapper to reach, so their reported `status` stays exactly the DB value.
- For each `Ready` row, the SAME check the launch sequence itself already
  performs (`container.rs`'s `wait_for_wrapper_ready`, hitting
  `http://127.0.0.1:<host_port>/api/wrapper/v1/health`) is called ONCE,
  with a short per-call timeout (2s — long enough for a healthy wrapper's
  ordinary response, short enough that one hung container cannot stall
  the whole list request). This is not the polling retry loop the launch
  path uses; a single attempt is enough here — the loop's job (wait for a
  container that is still booting) doesn't apply to a workspace that
  already reached `Ready` once.
- All `Ready` rows' checks run CONCURRENTLY (`route.rs`'s
  `check_health_and_build_list_items`, one `tokio::task::JoinSet` task
  per row), not sequentially — the wall-clock cost of listing N ready
  workspaces is one health-check round trip, not N of them back to back.
  Response items are reassembled in the store's original `ORDER BY`
  order, not task-completion order — a caller paging through results
  must see a stable order regardless of which container answers fastest.
- Reported as `healthy: bool` on each list item — `true` only when the
  live check just succeeded; `false` for a `Ready` DB row whose live
  check failed (crashed/hung container) OR any row that was never
  `Ready` in the first place (`creating`/`failed`) — `healthy` answers
  "can I use this workspace right now," not "did this row reach Ready at
  some point in the past" (that's still `status`).
- **Cost tradeoff, stated plainly:** this makes `GET /workspaces` an
  O(ready workspace count) network-fanout call, not a pure DB read. That
  is a deliberate, direct-instruction departure from the original
  "no container calls" plan. Request frequency (how often a dashboard
  polls this endpoint) is unaffected by this change — what changes is
  that every SINGLE call now carries a real, if bounded (2s max per row,
  all rows concurrent), tail latency, and hits every running container's
  wrapper once per call. Acceptable at this project's current scale
  (dev-stage, no auth, small workspace counts) — revisit if that changes.

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
