# AGENTS.md — frontend

Vite + React 19 + TypeScript. One HTTP backend from the browser:
`rust_gateway` (workspaces + per-workspace onboarding proxy). Envelope
parser is `lib/api.ts`. Screens: `/create`, `/creating`,
`/onboarding/:workspaceId`.

Read this before editing. Do not invent a parallel tree.

## Rules

1. **shadcn first.** Primitives in `src/components/ui/` via
   `npx shadcn@latest add`. Composites in `src/components/`.
2. **No hardcoded anything that belongs in env, the URL, or the API.**
   - Host / port / origin / base URL: never a literal (`localhost`,
     `127.0.0.1`, `:8080`, `:5173`, `:8787`, a wrapper listen address).
     `VITE_*` is read only in `src/lib/env.ts`; callers use helpers
     (`gatewayUrl()`). Never `import.meta.env.VITE_*` in features/pages.
   - Workspace id: from the route (`useParams`) or from
     `createWorkspace`'s result. Pass it into every onboarding call.
     Never invent, cache as a global, or bake an id into source.
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
6. **Onboarding:** chat/text MODEL providers only. No image/video/web-search
   /chat-gateway UI. Wire snake_case remaps to camelCase in
   `features/onboarding/api.ts` (same as workspace). Every call takes
   `workspaceId` as its first argument. Do not call the wrapper's own
   base URL — go through
   `${gatewayUrl()}/workspaces/:id/onboarding/...`. The gateway is the
   enforcement point (`workspace_not_found` / `workspace_not_ready`).

## Structure

```
src/
  app/          providers, error-boundary, toaster, router
  pages/        onboarding-page, create-workspace-page, creating-workspace-page, not-found-page
  features/
    workspace/  rust_gateway POST /workspaces (camelCase result DTO)
    onboarding/ rust_gateway /workspaces/:id/onboarding/* (camelCase DTOs)
    theme/
  lib/
    env.ts      gatewayUrl
    api.ts      apiFetch / ApiError / errorMessage
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

## Errors / toasts / fallbacks

`apiFetch` throws `ApiError`; `handleError` toasts; `ErrorBoundary` /
`NotFoundPage` / `PageFallback` for crash / 404 / empty. Probe failure
(`data.ok === false`) is not `ApiError` — toast the inner `error` string.

## Validate

`npm run build` must pass.

```bash
cp .env.example .env && npm install && npm run dev
```
