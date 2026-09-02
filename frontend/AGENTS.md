# AGENTS.md — frontend

Vite + React 19 + TypeScript. One HTTP backend from the browser:
`rust_gateway` (workspaces + per-workspace onboarding/agent-seeder proxies).
Envelope parser is `lib/api.ts`. Screens: `/` (workspace list), `/create`,
`/creating`, `/onboarding/:workspaceId`, `/mode/:workspaceId`.

**New-workspace flow is fixed — every "workspace became ready" exit MUST
land on onboarding, never straight to `/`:**
`/create` (ready sync) → `/onboarding/:id`; `/create` (async) → `/creating`
→ (becomes ready) → `/onboarding/:id`; onboarding finish → `/mode/:id`;
mode-select finish/skip → `/`. A workspace is not actually usable until a
model provider is configured (onboarding) — routing a freshly-created
workspace to the dashboard instead skips that entirely and was a real bug
fixed once already (`create-workspace-page.tsx`,
`creating-workspace-page.tsx`, `mode-select-page.tsx` all navigate off a
`CreateWorkspaceResult`/mode-finish event — grep for `navigate(` in those
three files before changing any of them, and confirm every ready/finish
exit still points one step further into this chain, not back to `/` or
`/create` prematurely).

Read this before editing. Do not invent a parallel tree.

## Rules

1. **shadcn first.** Primitives in `src/components/ui/` via
   `npx shadcn@latest add`. Composites in `src/components/`.
2. **No hardcoded anything that belongs in env, the URL, or the API.**
   - Host / port / origin / base URL: never a literal (`localhost`,
     `127.0.0.1`, `:8080`, `:5173`, `:8787`, a wrapper listen address).
     `VITE_*` is read only in `src/lib/env.ts`; callers use helpers
     (`gatewayUrl()`). Never `import.meta.env.VITE_*` in features/pages.
   - Workspace id: from the route (`useParams`), from `createWorkspace`'s
     result, or from `listWorkspaces`'s items. Pass it into every
     onboarding call. Never invent, cache as a global, or bake an id
     into source.
   - Provider catalog / models / categories / OAuth flags: from
     `GET .../onboarding/status` only. Do not hardcode provider ids,
     model lists, or category order as the source of truth (UI sort
     keys that *follow* the API's category ids are fine).
   - New config → add `VITE_*` to `.env.example` + `env.ts` helper.
     Do not add a second env reader.
3. **Pages stay thin.** Fetch + domain UI live in `src/features/<name>/`.
4. **Errors:** `handleError` (toast + string). Never `alert()`, never toast
   from `api.ts`.
5. **Workspaces:** POST `/workspaces` `{ name, password? }`. No `kind`.
   GET `/workspaces` lists `{ workspaces, limit, offset }` — `name` is the
   caller-facing workspace name (gateway renamed `idempotency_key`; do
   not mention or depend on that column). Each item's `healthy` is a LIVE
   per-request check the gateway just ran against that workspace's
   container — independent of `status`; a `ready` row can be
   `healthy: false` if its container died after being marked ready. Use
   `healthy`, not `status`, for anything claiming to show whether a
   workspace is usable right now (health counts, "Healthy" filters,
   status dots) — see `rust_gateway/docs/list-workspaces-plan.md`. Omit
   `limit`/`offset` on first load; page with echoed `limit` and `offset`
   of `items.length`. Never send negatives. DELETE `/workspaces/:id`
   stops the container (if any) and drops the row
   (`workspace_not_found` / `workspace_delete_failed`). Hermes Web:
   `${gatewayUrl()}/workspaces/:id/hermes-webui/`. Desktop UI:
   `${gatewayUrl()}/workspaces/:id/desktop/`. Build those with
   `hermesWebuiUrl` / `desktopUrl` in `features/workspace/api.ts` — never
   a wrapper origin. Remap snake_case in `features/workspace/api.ts`.
6. **Onboarding:** chat/text MODEL providers only. No image/video/web-search
   /chat-gateway UI. Wire snake_case remaps to camelCase in
   `features/onboarding/api.ts` (same as workspace). Every call takes
   `workspaceId` as its first argument. Do not call the wrapper's own
   base URL — go through
   `${gatewayUrl()}/workspaces/:id/onboarding/...`. The gateway is the
   enforcement point (`workspace_not_found` / `workspace_not_ready`).
7. **Agent seeder:** after onboarding's model setup completes
   (`OnboardingWizard`'s `onFinished`), the user lands on `/mode/:workspaceId`
   (`ModeSelectPage` → `features/agent-seeder/components/mode-select.tsx`) to
   pick Simple / Creator / Company. **`mode-select.tsx` has NO per-mode
   branching** — every mode is one entry in the `MODES` table
   (`features/agent-seeder/modes.ts`); the component only knows "does this
   mode have a `run`" (clickable) or not (disabled, "Coming soon"). Only
   `simple` has a `run` today — it calls
   `POST ${gatewayUrl()}/workspaces/:id/agent-seeder/simple/apply`
   (`features/agent-seeder/api.ts`'s `applySeeder(workspaceId, 'simple')`),
   which forwards to the wrapper's
   `POST /api/wrapper/v1/agent-seeder/{mode}/apply` (applies
   `backend/seeder/modes/{mode}/agents/*` — see that folder's own README).
   **Adding a real Creator or Company mode is additive, not a rewrite:**
   populate `backend/seeder/modes/<mode>/`, then add
   `run: (workspaceId) => applySeeder(workspaceId, '<mode>')` to that
   mode's entry in `MODES` — no changes to `mode-select.tsx` itself. Same
   rule as onboarding: never call the wrapper's own base URL, only the
   gateway proxy.

## Structure

```
src/
  app/          providers, error-boundary, toaster, router
  pages/        workspaces-page, onboarding-page, mode-select-page,
                create-workspace-page, creating-workspace-page, not-found-page
  features/
    workspace/     rust_gateway GET+POST+DELETE /workspaces (camelCase DTOs)
    onboarding/    rust_gateway /workspaces/:id/onboarding/* (camelCase DTOs)
    agent-seeder/  rust_gateway /workspaces/:id/agent-seeder/* (camelCase DTOs);
                   modes.ts is the mode catalog (id/label/description/run) —
                   add a mode here, not as a branch in mode-select.tsx
    agent-history/ rust_gateway /workspaces/:id/agent-history/* (camelCase DTOs);
                   read-only agent/session/message browser powering the
                   AUDIENCE panel in threads-shell.tsx, fresh-on-open + manual
                   refresh only (no polling, no websockets, no timers)
    theme/
  lib/
    env.ts          gatewayUrl
    api.ts          apiFetch / ApiError / errorMessage
    query-client.ts the one QueryClient (staleTime / 4xx-aware retry policy)
    query-keys.ts   hierarchical query key factory — keys carry full identity
    handle-error.ts
```

New gateway route → `apiFetch(gatewayUrl(), ...)`.

## Onboarding API

Base: `${VITE_GATEWAY_URL}/workspaces/:workspaceId/onboarding`

| Call | Notes |
| --- | --- |
| GET `/status` | Catalog + `completed` |
| POST `/setup` | `{ provider, model, api_key?, base_url?, confirm_overwrite? }`. HTTP 200 with `data.error === 'config_exists'` + `requires_confirm` is **not** `ApiError` — show confirm, re-POST `confirmOverwrite: true`. |
| POST `/setup/self-hosted` | `ollama` / `lmstudio` only |
| POST `/complete` | Marks done |
| POST `/probe` | Envelope `ok: true` always; inner `data.ok` is reachability |
| POST `/oauth/start` | When catalog `oauthProvider` is set. Poll GET `/oauth/poll?flow_id=` every few seconds until status leaves `pending`. Cancel POST `/oauth/cancel`. |

Gateway errors before any wrapper hop: `workspace_not_found` (404),
`workspace_not_ready` (409). Initial load of those two **redirects to
`/create`** (not a retry toast). Wrapper codes after a successful
forward: `onboarding_setup_failed`, `oauth_start_failed`,
`oauth_poll_failed`. A ready workspace whose container wrapper is not
started yet returns a non-envelope 502 from `forward_to` — `apiFetch`
maps that to `invalid_response`; treat as a normal `handleError`
failure (retry), not a crash.

## Agent Seeder API

Base: `${VITE_GATEWAY_URL}/workspaces/:workspaceId/agent-seeder`

| Call | Notes |
| --- | --- |
| POST `/:mode/apply` | Applies every agent in `backend/seeder/modes/:mode/agents/*` to this workspace. Returns `{ applied: AppliedAgent[] }` — see `features/agent-seeder/types.ts`. Idempotent: safe to call more than once. An unknown/empty `:mode` returns `{ applied: [] }`, not an error. |
| GET `/modes` | Lists mode names that actually exist under `backend/seeder/modes/`. Not currently called from the frontend (`MODES` in `modes.ts` is the UI's own list) — use this if `mode-select.tsx` ever needs to hide a mode the backend genuinely has no content for, instead of relying solely on the hardcoded `run` presence. |

`applySeeder(workspaceId, mode)` in `features/agent-seeder/api.ts` takes
`mode` as its second argument — every caller (i.e. `modes.ts`'s `run`
functions) must pass the exact mode id `MODES` declares, since that's what
becomes the URL path segment.

Same gateway error codes as onboarding (`workspace_not_found` 404,
`workspace_not_ready` 409) before any wrapper hop. Wrapper codes after a
successful forward: `agent_seeder_profile_create_failed`,
`agent_seeder_agent_md_failed`, `agent_seeder_tool_discovery_failed`,
`agent_seeder_config_unreadable`, `agent_seeder_config_write_failed` (see
`backend/wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py`
for what each means). None of these have friendly per-code messages in
`mode-select.tsx` yet beyond the two gateway ones — add to `MODE_ERRORS`
there if a specific one needs a better message than the raw server text.

## Agent History API

Base: `${VITE_GATEWAY_URL}/workspaces/:workspaceId/agent-history`

| Call | Notes |
| --- | --- |
| GET `/agents` | `{ agents: [{ name }] }` — every agent is a Hermes profile. |
| GET `/agents/:name/sessions?limit=&offset=` | `{ sessions, limit, offset }`. Each session is metadata only, projected to exactly 5 keys (`session_id`, `title`, `message_count`, `updated_at`, `last_message_at`), newest first. |
| GET `/agents/:name/sessions/:sessionId/messages?limit=&offset=` | `{ messages: [{ role, content, timestamp }], limit, offset, total }`. |

Pagination `limit` defaults to 50, hard-capped at 200; `offset` defaults to
0. `features/agent-history/api.ts` remaps every snake_case field above to
camelCase (`sessionId`, `messageCount`, `updatedAt`, `lastMessageAt`) —
same pattern as `workspace`/`onboarding`. Cross-agent isolation is enforced
server-side: requesting a session under the wrong agent name 404s rather
than returning another agent's transcript.

Same gateway error codes as onboarding/agent-seeder
(`workspace_not_found` 404, `workspace_not_ready` 409) before any wrapper
hop. Wrapper codes after a successful forward: `agent_history_profile_not_found`
(404), `agent_history_session_not_found` (404), `agent_history_invalid_limit`
(400), `agent_history_invalid_offset` (400).

Freshness is deliberately fresh-on-open + manual refresh only — no
polling, no websockets, no timers. Opening an agent or session re-fetches
once; a visible refresh control re-fetches on demand. Sessions and
messages queries are gated on the AUDIENCE panel actually being open
(`panelOpen` ANDed into `enabled`), so no transcript data is fetched
while the panel is closed. The agents list is the one deliberate
exception: threads-shell's CHAT sidebar renders the real agent list on
the chat screen itself, so `useAgents` is enabled whenever the shell is
mounted (the sidebar and the panel share one query key, so this is a
single fetch). Clicking a sidebar agent selects it in the panel via
`AgentHistoryPanel`'s controlled `selectedAgent`/`onSelectedAgentChange`
props, opening the drawer below the three-column breakpoint. **Do not
fetch agent history from any OTHER screen**: the workspace dashboard did
exactly that once (hover a workspace card → `listAgents`) and it
silently defeated the gate. Prefetch sessions/messages only from inside
the panel, on hover/focus of an agent or session.

## Server state: TanStack Query (React Query v5)

**Every server read goes through React Query.** Do not add a new
`useEffect` + `useState` fetch — that pattern is gone from this codebase on
purpose (it produced a real stale-response race in the agent-history panel,
fixed by migrating to `useQuery`).

- `lib/query-client.ts` — the one `QueryClient`. `staleTime` 30s,
  `refetchOnWindowFocus: false` (this app has explicit refresh controls),
  queries retry once, mutations never. **The retry predicate never retries a
  structured 4xx** (`workspace_not_found`, `workspace_not_ready`, …) — only
  `network` / `invalid_response` are worth a retry. Retrying a 404 is pure
  latency.
- `lib/query-keys.ts` — the hierarchical key factory. Every key MUST carry
  its full identity (`workspaceId`, agent name, session id). A key missing
  part of its identity is a cross-tenant cache leak, not a style nit.
- Query/mutation hooks live in the owning feature
  (`features/<name>/hooks/`), never inline in a page or shell component.
- Lists that page (`limit`/`offset`) use `useInfiniteQuery`. First page
  sends no args; later pages send the **echoed** `limit` plus an `offset` of
  the loaded count, and `getNextPageParam` returns `undefined` once a page
  comes back short.
- Mutations (`delete`, `diagnose`, onboarding `setup`/`probe`/`complete`)
  invalidate the relevant key on success rather than hand-patching cache.
- `placeholderData: keepPreviousData` is only for a page change **within one
  identity**. Never across a different agent/session/workspace — it renders
  the previous entity's data under the new one (a real bug caught in review).
  Show the skeleton instead.
- Skeletons render on `isPending` (first load) only, never on a background
  refetch — a refetch must not rip content out from under the user. Reuse
  `components/ui/skeleton.tsx`; feature-shaped skeletons live in the feature.
- Query errors render inline with a retry wired to `refetch()`. Never
  `window.location.reload()` — that throws away the whole SPA and every other
  cache entry to recover one request.
- Polling is the exception, not the default: only the OAuth poll and it must
  terminate (`refetchInterval` returns `false` once the flow leaves
  `pending`).
- Devtools are dev-only and must stay out of the production bundle.

## Errors / toasts / fallbacks

`apiFetch` throws `ApiError`; `handleError` toasts; `ErrorBoundary` /
`NotFoundPage` / `PageFallback` for crash / 404 / empty. Probe failure
(`data.ok === false`) is not `ApiError` — toast the inner `error` string.

## Validate

`npm run build` must pass.

```bash
cp .env.example .env && npm install && npm run dev
```
