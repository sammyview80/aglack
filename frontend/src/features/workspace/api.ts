/**
 * Client for rust_gateway's POST /workspaces (see
 * rust_gateway/src/workspaces/route.rs for the authoritative contract).
 *
 * Base URL comes from VITE_GATEWAY_URL via lib/env.ts — never hardcode
 * a host/port here. Response parsing goes through `apiFetch` (lib/api.ts)
 * — the shared { ok, data } / { ok, error } envelope every rust_gateway
 * JSON route uses, so error handling doesn't need its own logic here.
 */
import { apiFetch } from '@/lib/api'
import { gatewayUrl } from '@/lib/env'
import type {
  CreateWorkspaceResult,
  WorkspaceStatus,
} from '@/features/workspace/types'

type CreateWorkspaceApiData = {
  workspace_id: string
  status: WorkspaceStatus
  container_name: string | null
}

/**
 * POST /workspaces. `name` doubles as the idempotency key on the gateway
 * side while a creation is `creating` or `failed` — calling again with
 * the same `name` retries rather than creating a second container. A
 * name that already belongs to a `ready` workspace instead rejects with
 * `ApiError.code === 'workspace_name_taken'` (see
 * rust_gateway/src/workspaces/route.rs) — callers should check that code
 * to show a "name already in use" message.
 */
export async function createWorkspace(
  name: string,
  password?: string,
): Promise<CreateWorkspaceResult> {
  const data = await apiFetch<CreateWorkspaceApiData>(gatewayUrl(), '/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name, password: password || undefined }),
  })

  return {
    workspaceId: data.workspace_id,
    status: data.status,
    containerName: data.container_name,
  }
}
