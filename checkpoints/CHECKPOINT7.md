# Checkpoint 7 — read this first in a new session

Continues from `CHECKPOINT6.md`. This session migrated the frontend's
**entire server-state layer to TanStack Query (React Query v5)**, with
intent-based prefetching, loading skeletons on every async surface, and one
consistent error/retry story. Read `CHECKPOINT.md` → `CHECKPOINT3.md` →
`CHECKPOINT4.md` → `CHECKPOINT5.md` → `CHECKPOINT6.md` first; this file
only adds what changed since.

## Repository state

Still **nothing committed** — the tree carries this session's work plus
everything listed in `CHECKPOINT6.md`'s "Repository state" section
(Company-mode seeder tree, unused avatar files, the `?health=skip`
feature). All of it remains uncommitted and unreviewed by a human.

## What shipped

`@tanstack/react-query@^5.102.8` + `@tanstack/react-query-devtools` (dev
only). No other new dependency.

**New files**
- `src/lib/query-client.ts` — the single `QueryClient`.
- `src/lib/query-keys.ts` — hierarchical, typed key factory.
- `src/features/agent-history/hooks/use-agent-history.ts` — agents /
  sessions / messages queries + prefetch helpers.
- `src/features/agent-history/components/{agents,sessions,messages}-skeleton.tsx`.

**Migrated off hand-rolled `useEffect` + `useState` fetching**
- `features/workspace/hooks/use-workspace-list.ts` — ~200 lines of manual
  `items`/`busy`/`busyId`/`ready`/`loadError` became `useInfiniteQuery` +
  `useMutation` for delete/diagnose. Kept the `window.confirm` before
  delete, the `toast.loading` → success/error flow, and the `LIST_ERRORS`
  code→message map.
- `features/agent-history/components/agent-history-panel.tsx` — the manual
  per-request-id generation refs added in the previous session are **gone**;
  React Query makes that race impossible by construction. This is the
  clearest win of the migration: a hand-written correctness guard replaced
  by a library invariant.
- `features/onboarding/hooks/use-onboarding-wizard.ts` — status query +
  mutations; the OAuth poll is now a `refetchInterval` that returns `false`
  once the flow leaves `pending` (verified it terminates).
- `components/threads-shell.tsx` — `WorkspaceRail` now shares the workspace
  list query instead of issuing its own duplicate fetch.

**Design decisions worth keeping**
- `staleTime` 30s, `refetchOnWindowFocus: false` — this is a local control
  plane with explicit refresh controls, not a feed.
- **The retry predicate never retries a structured 4xx.** Retrying
  `workspace_not_found`/`workspace_not_ready` is pure added latency; only
  `network` / `invalid_response` get one retry.
- Prefetch on **intent**: hover AND keyboard focus (focus-only prefetch
  omitted would make it mouse-only, i.e. inaccessible), plus the first
  session's messages once a session list loads. Single-item only, never a
  fan-out.
- Skeletons on `isPending` (first load) only — a background refetch must not
  rip content out from under the user.
- Retry controls call `refetch()`, never `window.location.reload()`.

## Review findings (all fixed)

Codex reviewed twice and found 7 real problems, 4 of them P1:

1. **P1 `keepPreviousData` rendered the WRONG agent's data.** I had asked
   for `keepPreviousData` to avoid empty-state flashes; applied to the
   agent/session queries it showed agent A's transcript under agent B —
   a data-correctness bug strictly worse than a flash. Removed from
   agent-history entirely; the skeleton covers that case. It is only valid
   for a page change *within one identity*.
2. **P1 history fetched while the panel was closed.** The audience panel
   always mounts, so its queries ran even if the user never opened it,
   violating the documented fresh-on-open model. Fixed by ANDing a
   `panelOpen` flag into `enabled` on all three hooks.
3. **P1 `WorkspaceRail` was never migrated** — still `useEffect`/`useState`,
   a duplicate fetch, and silently swallowed errors. Now shares the same
   query key, with a visible error indicator.
4. **P1 (found in the final round, introduced by fix #2's blind spot)** the
   workspace dashboard prefetched `listAgents` on card hover, bypassing the
   `panelOpen` gate through a different path. Deleted — it was also wasted
   work, since the card navigates to `/chat` where the panel starts closed.
5. P2 pagination dropped the echoed `limit` after page one (could skip or
   duplicate rows if the server's page size differed).
6. P2 "retry" called `window.location.reload()` — discarding the whole SPA
   and every other cache entry to recover one failed request.
7. P2 onboarding's `initializedFromStatus` ref never reset on workspace
   change, so provider/model state bled across workspaces.

Codex independently confirmed devtools are absent from the production
bundle and that the OAuth poll terminates.

## Verification

- `npm run build`: clean, zero TypeScript errors.
- Backend suites unaffected: wrapper **85/85**, gateway **103/103**,
  seeder_kit **38/38**.
- **Real gateway + real container smoke test** (not just a compile): CORS
  preflight for the frontend origin, workspace list first page (no args),
  paged list with the echoed `limit`, `?health=skip` (rail path), seeding,
  `agent-history/agents` → `[default, pm]`, sessions query, and the
  no-retry 404 path returning immediately (11ms).
- Production bundle served via `vite preview` and inspected: React Query
  present, **devtools absent**.
- One honest gap closed mid-test: the first smoke run hit
  `{"error": "not found"}` on agent-history because the `hermes-workspace:dev`
  image predates that feature. Rebuilt the image from current source and
  re-ran — not a regression, but worth knowing that `:dev` is stale.
- Cleanup removed only this session's container/image; the two containers
  belonging to a separate session were left running, and `frontend/.env`
  was left untouched (still port 8080).

## Frontend test suite — the gap this session also closed

The frontend had **zero automated tests**. It now has a real suite:
`vitest` + Testing Library + jsdom, wired into the existing
`vite.config.ts` (one config, so the `@` alias cannot drift), with
`npm test` (CI-safe single run) and `npm run test:watch`.

**18 tests across 4 files**, each one guarding a bug a reviewer actually
found in this code rather than restating the implementation:
- `lib/query-client.test.ts` — the retry predicate never retries a 4xx;
  `network`/`invalid_response` retry exactly once.
- `lib/query-keys.test.ts` — keys differ across workspace/agent/session and
  nest under their root (the cross-tenant-cache-leak guard).
- `agent-history-panel.test.tsx` — nothing fetches while the panel is
  closed; switching agents never shows the previous agent's sessions;
  skeleton on first load but not on refetch.
- `use-workspace-list.test.tsx` — pagination sends the *echoed* limit (the
  mock echoes 7, not 50, so a hardcoded default fails the test) and stops on
  a short page.

**These guards were mutation-tested, not assumed.** Each of the three
critical behaviors had its bug deliberately reintroduced to confirm the
suite actually fails:

| Reintroduced bug | Result |
| --- | --- |
| `keepPreviousData` on the sessions query | 1 failed |
| removed the `panelOpen` gate | 1 failed |
| retry predicate returning `true` for 4xx | 2 failed |

All three passed again once reverted, and both mutated files were diffed
byte-for-byte against their originals afterwards to prove no residue. A
test that cannot fail is worse than no test; these can.

Test output is also clean — an `act(...)` warning and two "Query data
cannot be undefined" errors were fixed rather than tolerated, since a noisy
suite trains people to ignore real failures.

## Not done / known gaps

- Still **not browser-verified by a human** — the tests exercise behavior in
  jsdom, but nobody has clicked through the panel, drawer, prefetch, or
  skeletons in a real browser.
- Coverage is deliberately narrow: it pins the React Query rules and the
  known-bug surfaces, not the whole UI. Onboarding's wizard flow
  (`config_exists` confirm, probe, OAuth poll termination) has no test yet
  and is the obvious next target.
- Nothing committed; Company-mode seeder tree still untracked and untested.
- `hermes-workspace:dev` is stale relative to the wrapper source (missing
  `agent_history`). Rebuild before any manual end-to-end use.
- Tooling: `cargo` at `~/.cargo/bin`, `docker` at
  `/Applications/Docker.app/Contents/Resources/bin`, wrapper tests need
  `.venv/bin/python`. `vite preview` binds `localhost` (IPv6), not
  `127.0.0.1`.
</content>
