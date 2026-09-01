/**
 * Client for rust_gateway's /workspaces routes (see
 * rust_gateway/src/workspaces/route.rs): POST create, GET list,
 * DELETE by id, POST diagnose. Hermes WebUI / desktop URLs are gateway proxy prefixes,
 * not the wrapper's own origin.
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
  DiagnosisAction,
  DiagnosisReport,
  DiagnosisSnapshot,
  ListWorkspacesResult,
  WorkspaceListItem,
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

type WorkspaceListItemApiData = {
  workspace_id: string
  name: string
  status: WorkspaceStatus
  healthy: boolean
  host_port: number | null
  desktop_port: number | null
  created_at: string
}

type ListWorkspacesApiData = {
  workspaces: WorkspaceListItemApiData[]
  limit: number
  offset: number
}

export type ListWorkspacesQuery = {
  limit?: number
  offset?: number
}

function mapListItem(row: WorkspaceListItemApiData): WorkspaceListItem {
  return {
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    healthy: row.healthy,
    hostPort: row.host_port,
    desktopPort: row.desktop_port,
    createdAt: row.created_at,
  }
}

/**
 * GET /workspaces. Omit `limit`/`offset` to use the gateway defaults
 * (echoed back on the result). Do not send negatives — the gateway
 * rejects those with `invalid_pagination`. A `limit` above the gateway
 * cap is clamped server-side; trust `result.limit`, not what you asked.
 */
export async function listWorkspaces(
  query: ListWorkspacesQuery = {},
): Promise<ListWorkspacesResult> {
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  const suffix = params.size > 0 ? `?${params}` : ''
  const data = await apiFetch<ListWorkspacesApiData>(gatewayUrl(), `/workspaces${suffix}`)
  return {
    workspaces: data.workspaces.map(mapListItem),
    limit: data.limit,
    offset: data.offset,
  }
}

/**
 * DELETE /workspaces/:id. Stops the container (if any) and drops the
 * store row. Unknown id → `ApiError.code === 'workspace_not_found'`.
 * Docker remove failure → `workspace_delete_failed` (row kept).
 */
export async function deleteWorkspace(workspaceId: string): Promise<{ workspaceId: string }> {
  const data = await apiFetch<{ workspace_id: string }>(
    gatewayUrl(),
    `/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: 'DELETE' },
  )
  return { workspaceId: data.workspace_id }
}

type DiagnosisSnapshotApi = {
  container_running: boolean
  container_exit_code: number | null
  container_oom_killed: boolean
  wrapper_healthy: boolean
  desktop_healthy: boolean
}

type DiagnosisReportApi = {
  workspace_id: string
  before: DiagnosisSnapshotApi
  action: DiagnosisAction
  after: DiagnosisSnapshotApi | null
}

function mapSnapshot(row: DiagnosisSnapshotApi): DiagnosisSnapshot {
  return {
    containerRunning: row.container_running,
    containerExitCode: row.container_exit_code,
    containerOomKilled: row.container_oom_killed,
    wrapperHealthy: row.wrapper_healthy,
    desktopHealthy: row.desktop_healthy,
  }
}

/**
 * POST /workspaces/:id/diagnose. Inspects Docker state + live wrapper/
 * desktop health. If unhealthy, stop then start the existing container
 * and re-checks. HTTP 200 even when a restart does not fix things —
 * read `action` + `after`, do not treat 200 as "now healthy".
 * Unknown id → `workspace_not_found`. No container yet →
 * `workspace_no_container`. Inspect/store failure →
 * `workspace_diagnosis_failed`.
 */
export async function diagnoseWorkspace(workspaceId: string): Promise<DiagnosisReport> {
  const data = await apiFetch<DiagnosisReportApi>(
    gatewayUrl(),
    `/workspaces/${encodeURIComponent(workspaceId)}/diagnose`,
    { method: 'POST' },
  )
  return {
    workspaceId: data.workspace_id,
    before: mapSnapshot(data.before),
    action: data.action,
    after: data.after ? mapSnapshot(data.after) : null,
  }
}

/** Hermes WebUI for this workspace, via the gateway proxy (new tab). */
export function hermesWebuiUrl(workspaceId: string): string {
  return `${gatewayUrl()}/workspaces/${encodeURIComponent(workspaceId)}/hermes-webui/`
}

/** Webtop desktop UI for this workspace, via the gateway proxy (new tab). */
export function desktopUrl(workspaceId: string): string {
  return `${gatewayUrl()}/workspaces/${encodeURIComponent(workspaceId)}/desktop/`
}
