/**
 * The gateway-level error vocabulary every per-workspace feature shares.
 *
 * rust_gateway rejects a request BEFORE any wrapper hop with
 * `workspace_not_found` (404) / `workspace_not_ready` (409) — see its
 * `workspaces/resolve.rs` — and `apiFetch` maps an unreachable gateway to
 * `network`. Every feature that calls `${gatewayUrl()}/workspaces/:id/...`
 * (onboarding, agent-seeder, future proxies) needs the same two things for
 * those codes: a friendly message per code, and an "is this an
 * invalid-workspace error" predicate to redirect to /create instead of
 * toasting. Declared once here; feature-specific codes get spread on top
 * at each feature's own call site
 * (`{ ...GATEWAY_WORKSPACE_ERRORS, my_feature_code: '...' }`).
 */
import { ApiError } from '@/lib/api'

export const GATEWAY_WORKSPACE_ERRORS: Record<string, string> = {
  workspace_not_ready: 'This workspace is not ready yet.',
  workspace_not_found: 'No workspace with that id.',
  network: 'Cannot reach the gateway. Is rust_gateway running?',
}

/** True when `err` means the workspace id itself is unusable (missing or
 * not ready) — callers should route the user back to workspace creation
 * rather than showing a retryable error. */
export function isInvalidWorkspace(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === 'workspace_not_found' || err.code === 'workspace_not_ready')
  )
}
