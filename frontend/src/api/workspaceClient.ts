/**
 * Client for rust_gateway's POST /workspaces (see
 * rust_gateway/src/workspaces/route.rs for the authoritative contract).
 *
 * Base URL comes from VITE_GATEWAY_URL (see ../../.env.example) — never
 * hardcode a host/port here, matching rust_gateway's own no-hardcoded-URL
 * rule (see rust_gateway/AGENTS.md).
 */

export type WorkspaceStatus = 'creating' | 'ready' | 'failed'

export type CreateWorkspaceResult = {
  workspaceId: string
  status: WorkspaceStatus
  containerName: string | null
}

type CreateWorkspaceApiResponse = {
  workspace_id: string
  status: WorkspaceStatus
  container_name: string | null
}

function gatewayUrl(): string {
  const base = import.meta.env.VITE_GATEWAY_URL
  if (!base) {
    throw new Error(
      'VITE_GATEWAY_URL is not set — copy frontend/.env.example to frontend/.env',
    )
  }
  return base
}

/**
 * POST /workspaces. `name` doubles as the idempotency key on the gateway
 * side — calling this again with the same `name` (e.g. a page refresh
 * during "creating") returns the same workspace rather than creating a
 * second container. See rust_gateway/src/workspaces/mod.rs.
 */
export async function createWorkspace(
  name: string,
  password?: string,
): Promise<CreateWorkspaceResult> {
  const res = await fetch(`${gatewayUrl()}/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: password || undefined }),
  })

  let body: CreateWorkspaceApiResponse | { error?: string } | undefined
  try {
    body = await res.json()
  } catch {
    body = undefined
  }

  if (!res.ok) {
    const detail =
      (body && 'error' in body && body.error) || res.statusText || 'workspace creation failed'
    throw new Error(detail)
  }

  const data = body as CreateWorkspaceApiResponse
  return {
    workspaceId: data.workspace_id,
    status: data.status,
    containerName: data.container_name,
  }
}
