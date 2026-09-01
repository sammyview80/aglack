# Diagnose-workspace route — plan (plain language)

Status: **planning only, nothing built yet**. This is the "how" before the
"code."

## What we're building

One endpoint: `POST /workspaces/:id/diagnose`. A workspace container
sometimes fails silently — the wrapper crash-loops, the process hangs, or
the container itself exits — and today the only way to notice is a
generic `502`/`healthy: false` on some other route, with no detail on
WHY and no automatic recovery. This gives an operator (or, later, a
"restart my workspace" button in the frontend) one call that:

1. Inspects the REAL Docker container state (not just "is the wrapper
   answering" — that alone can't distinguish "container never started",
   "container crashed", "container OOM-killed", from "container running
   but the process inside hung").
2. Live-checks the wrapper and desktop, same live-check discipline as
   `GET /workspaces` (see `docs/list-workspaces-plan.md`).
3. If unhealthy, runs a real recovery cycle: `docker stop` then
   `docker start` (NOT `docker restart` — see "Why stop-then-start, not
   restart" below), then re-checks both services.
4. Returns a structured report: what was found, what action was taken (if
   any), and the state after that action — never a bare boolean.

This is a POST, not a GET: it can mutate real infrastructure (stop/start
a container), so it must not be something a browser prefetch, a crawler,
or a naive retry-on-GET client could trigger by accident.

## Why stop-then-start, not `docker restart`

`docker restart` is a single opaque Docker operation with its own
internal timeout and signal-then-kill behavior that this codebase does
not control or observe step-by-step. Two explicit calls
(`ContainerLauncher::stop` then the EXISTING `start` sequencing this
project already trusts) means:
- the "was it actually stopped" question has its own explicit answer
  (`docker stop`'s exit code), not folded into one bigger opaque command
- if `stop` succeeds but `start` fails, that distinction is visible in
  the diagnosis report, instead of "restart failed" telling you nothing
  about which half broke

## What counts as a "real diagnosis" here

Three independent signals, all real (no simulated/hardcoded values):

1. **Container state** — `docker inspect --format '{{json .State}}'
   <container_name>`, parsed for `Running` (bool), `ExitCode` (int),
   `OOMKilled` (bool). This is the ONLY way to see "the container process
   itself is gone" versus "the container is up but the wrapper inside
   crashed" — a live HTTP health check alone cannot tell these apart (a
   `Running: false` container obviously fails every HTTP check too, but
   for a completely different reason than a hung process inside a
   `Running: true` container).
2. **Wrapper health** — reuses `container.rs`'s existing
   `check_wrapper_health` (same single-attempt, bounded-timeout check
   `GET /workspaces` already performs — see
   `docs/list-workspaces-plan.md`). Only attempted if the container is
   actually `Running` (no point hitting a port with nothing behind it).
3. **Desktop health** — same idea, reusing `wait_for_desktop_ready`'s
   underlying single-attempt request pattern (a new
   `check_desktop_health`, mirroring `check_wrapper_health`'s shape, so
   the desktop gets the same real check the wrapper already gets, not a
   second-class "we don't bother" treatment).

"Unhealthy" (the trigger for the auto-heal step) = container not
`Running`, OR wrapper health check fails, OR desktop health check fails.
Any one of the three failing is enough — a `Running: true` container
whose wrapper hung is exactly as unusable to a caller as one that's
`Running: false`.

## The auto-heal cycle

Only runs when the initial diagnosis found the workspace unhealthy (a
healthy workspace's diagnosis is read-only — no `stop`/`start` call is
ever made against something already working). Sequence:

1. `docker stop <container_name>` (via a new
   `ContainerLauncher::stop`) — separate call from `remove` (used by
   `delete_workspace`), since diagnosis must keep the container/its data,
   not `docker rm` it.
2. `docker start <container_name>` (via a new
   `ContainerLauncher::start_existing` — separate from `launch`, which
   `docker create`s a brand NEW container; this starts the ALREADY
   EXISTING one diagnosis is investigating).
3. Wait for wrapper + desktop readiness using the EXACT SAME
   `wait_for_wrapper_ready`/`wait_for_desktop_ready` polling loops
   `DockerCliLauncher::launch` already uses at creation time — a
   restarted container's wrapper takes the same few real seconds to boot
   as a freshly created one; a single-attempt check immediately after
   `docker start` returns would almost always report "still unhealthy"
   through no fault of the restart.
4. Update the store: `mark_ready` with the SAME container name and ports
   (a stop+start does not change published ports — Docker keeps the same
   `-p` mappings across a stop/start cycle, unlike remove+recreate) if
   the post-restart checks pass; `mark_failed` if they don't.

If the workspace was ALREADY healthy, none of this runs — the response
still reports the full diagnosis, just with `action: "none"`.

## Response shape

Shared envelope (`crate::response`), `data`:

```
{
  "workspace_id": "...",
  "before": {
    "container_running": bool,
    "container_exit_code": number | null,
    "container_oom_killed": bool,
    "wrapper_healthy": bool,
    "desktop_healthy": bool
  },
  "action": "none" | "restarted" | "restart_failed",
  "after": { ...same shape as `before`... } | null
}
```

`after` is `null` when `action == "none"` (nothing changed, so there is
no separate "after" state — `before` already describes the current
state). `restart_failed` means the stop/start cycle itself errored
(Docker command failure) — distinct from "restarted but still
unhealthy" (a real `after` object showing that), which is a legitimate,
non-error outcome this endpoint must still report as `200`, not fail the
whole request over.

## Error cases

- Unknown `workspace_id` → `404 workspace_not_found` (same code every
  other per-workspace route already uses).
- A workspace that never launched a container (`Creating` with no
  `container_name` yet, or `Failed` before any container existed) →
  `409 workspace_no_container` — nothing to diagnose; this is different
  from `workspace_not_ready` (used by the proxy routes), since a
  diagnosis request against a `Failed` workspace THAT DOES have a
  container name is exactly the useful case (a previous launch attempt
  got far enough to create a container, then failed) — that case must
  proceed to diagnosis, not be rejected.
- Docker command failures during inspection (not the heal cycle) →
  `500 workspace_diagnosis_failed`.

## Where things live

- `container.rs` — three new `ContainerLauncher` trait methods:
  `inspect`, `stop`, `start_existing`. Plus `check_desktop_health`,
  mirroring the existing `check_wrapper_health`.
- `diagnosis.rs` (new module) — `diagnose_workspace`, the one function
  that composes store lookup + the three signals + the conditional heal
  cycle. Mirrors `mod.rs`'s existing separation: orchestration logic
  lives in its own function, not inlined into the HTTP handler.
- `route.rs` — `diagnose_workspace_route` handler + response DTOs.
- `app.rs` — `POST /workspaces/:id/diagnose` registered alongside the
  other per-workspace routes.
