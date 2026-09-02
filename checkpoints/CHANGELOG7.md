# Changelog 7

Everything changed this session. See `CHECKPOINT7.md` for the narrative and
root-cause detail; this file is the terse record.

**Nothing in this session was committed** — every entry below is
uncommitted working-tree state.

## 2026-09-02 (continued from Changelog 6)

### Added

- **TanStack Query (React Query v5) as the frontend's server-state layer.**
  `@tanstack/react-query@^5.102.8` + `@tanstack/react-query-devtools`
  (dev-only, verified absent from the production bundle). New
  `src/lib/query-client.ts` (single `QueryClient`: `staleTime` 30s,
  `refetchOnWindowFocus: false`, queries retry once, mutations never, and a
  retry predicate that NEVER retries a structured 4xx) and
  `src/lib/query-keys.ts` (hierarchical typed key factory; every key carries
  its full workspace/agent/session identity).
  (`frontend/src/lib/query-client.ts`, `frontend/src/lib/query-keys.ts`,
  `frontend/src/app/providers.tsx`)

- **Prefetching on intent.** Hover AND keyboard focus (focus included so it
  is not mouse-only) prefetches an agent's sessions; the first session's
  messages are prefetched once a session list loads. Single-item only — no
  fan-out.
  (`frontend/src/features/agent-history/hooks/use-agent-history.ts`)

- **Loading skeletons on every async surface**, shaped like the real content
  (list rows, avatar grid, message rows), reusing the existing
  `components/ui/skeleton.tsx`. Shown on `isPending` only, never on a
  background refetch.
  (`frontend/src/features/agent-history/components/{agents,sessions,messages}-skeleton.tsx`,
  `frontend/src/features/workspace/components/workspace-list.tsx`)

- **Frontend test suite — the codebase had none.** `vitest` +
  `@testing-library/react` + `jest-dom` + `user-event` + `jsdom`, configured
  inside the existing `vite.config.ts` (not a duplicate config, so the `@`
  alias cannot drift), with `npm test` / `npm run test:watch` and a
  `renderWithClient` helper giving every test a fresh `QueryClient`.
  **18 tests, 4 files**, each guarding a bug a reviewer actually found.
  (`frontend/src/test/`, `frontend/src/lib/*.test.ts`,
  `frontend/src/features/**/**.test.tsx`, `frontend/vite.config.ts`)

### Changed

- **Migrated every server read off hand-rolled `useEffect` + `useState`.**
  `use-workspace-list.ts` (~200 lines of manual `items`/`busy`/`busyId`/
  `ready`/`loadError`) became `useInfiniteQuery` + `useMutation`, preserving
  the `window.confirm` before delete, the `toast.loading` → success/error
  flow, and the `LIST_ERRORS` map. The agent-history panel's manual
  per-request-id race guards were DELETED — React Query makes that race
  impossible by construction. Onboarding's status became a query and its
  actions mutations, with the OAuth poll as a self-terminating
  `refetchInterval`. `WorkspaceRail` now shares the workspace-list query
  instead of issuing a duplicate fetch.
  (`frontend/src/features/workspace/hooks/use-workspace-list.ts`,
  `frontend/src/features/agent-history/components/agent-history-panel.tsx`,
  `frontend/src/features/onboarding/hooks/use-onboarding-wizard.ts`,
  `frontend/src/components/threads-shell.tsx`,
  `frontend/src/pages/creating-workspace-page.tsx`)

### Fixed (all found by independent review)

- **P1 `keepPreviousData` rendered the WRONG agent's data.** Applied to the
  agent/session queries it showed agent A's transcript under agent B — worse
  than the empty-state flash it was meant to avoid. Removed from
  agent-history; it is only valid for a page change within one identity.
- **P1 agent history fetched while the panel was closed.** The panel always
  mounts, so its queries ran even if the user never opened it, violating the
  documented fresh-on-open model. Fixed by ANDing `panelOpen` into `enabled`
  on all three hooks.
- **P1 `WorkspaceRail` was never migrated** — raw `useEffect`/`useState`, a
  duplicate fetch, and silently swallowed errors. Now shares the query key
  with a visible error indicator.
- **P1 the workspace dashboard prefetched `listAgents` on card hover**,
  bypassing the `panelOpen` gate via a different path (and wasted, since the
  card navigates to `/chat` where the panel starts closed). Deleted.
- **P2 pagination dropped the echoed `limit`** after page one, risking
  skipped/duplicated rows if the server's page size differed from the
  assumed default.
- **P2 "retry" called `window.location.reload()`**, discarding the whole SPA
  and every other cache entry to recover one failed request. Now `refetch()`.
- **P2 onboarding's `initializedFromStatus` ref never reset** on workspace
  change, so provider/model state bled from one workspace to the next.
- Test-side defects fixed rather than tolerated: a `tsc -b` type error in
  `query-keys.test.ts` that broke `npm run build`, an `act(...)` warning, and
  two "Query data cannot be undefined" errors.

### Verified

- `npm test` **18/18**, clean stderr. `npm run build` clean, zero TS errors.
- Backends unaffected: wrapper **85/85**, seeder_kit **38/38**, gateway
  **103/103**.
- **Mutation-tested the three critical guards** — reintroducing
  `keepPreviousData` (1 failure), removing the `panelOpen` gate (1 failure),
  and making the retry predicate retry 4xx (2 failures) each broke the
  suite; all green again after reverting, with both mutated files diffed
  byte-for-byte to prove no residue.
- **Real gateway + real container smoke test**: CORS preflight for the
  frontend origin, first-page list with no args, paged list with the echoed
  limit, `?health=skip`, seeding, `agent-history/agents` → `[default, pm]`,
  and a 404 returning immediately (11ms, proving no wasteful retry).
- Production bundle served and inspected: React Query present, devtools
  absent.
- Cleanup removed only this session's container/image; two containers from a
  separate session were left running and `frontend/.env` was left untouched.

### Docs

- `frontend/AGENTS.md`: new "Server state: TanStack Query (React Query v5)"
  section codifying the rules (no new `useEffect` fetches, keys carry full
  identity, `keepPreviousData` only within one identity, skeletons on first
  load only, retry via `refetch()` never a page reload, polling only for
  OAuth and it must terminate, devtools dev-only); `lib/` structure updated;
  the stale "per-request-id generation ref" note corrected, since those
  guards no longer exist.
- `checkpoints/CHECKPOINT7.md` added.
</content>
