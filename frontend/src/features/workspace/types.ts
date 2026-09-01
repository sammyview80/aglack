export type WorkspaceKind = 'headless' | 'server'

export type CreateWorkspaceInput = {
  ownerName: string
  workspaceName: string
  password?: string
  kind?: WorkspaceKind
}

export type CreateDraft = CreateWorkspaceInput

export type WorkspaceStatus = 'creating' | 'ready' | 'failed'

export type CreateWorkspaceResult = {
  workspaceId: string
  status: WorkspaceStatus
  containerName: string | null
}

export type WorkspaceListItem = {
  workspaceId: string
  name: string
  status: WorkspaceStatus
  /**
   * Live result of the gateway checking this workspace's container RIGHT
   * NOW (see rust_gateway/docs/list-workspaces-plan.md's "Live health
   * check" section) — NOT derived from `status`. Always `false` for
   * `creating`/`failed` rows (nothing to check yet); for a `ready` row,
   * `true` only if the wrapper answered its health check on this exact
   * list call — a `ready` row can still be `healthy: false` if its
   * container crashed or hung after it was marked ready.
   *
   * `null` means the caller asked to skip the live health check
   * (`health=skip` query param) — no live status was gathered for this
   * row, so callers should not render it as healthy or unhealthy.
   */
  healthy: boolean | null
  hostPort: number | null
  desktopPort: number | null
  createdAt: string
}

export type ListWorkspacesResult = {
  workspaces: WorkspaceListItem[]
  limit: number
  offset: number
}

/** One live look at a workspace container — `before` / `after` on diagnose. */
export type DiagnosisSnapshot = {
  containerRunning: boolean
  containerExitCode: number | null
  containerOomKilled: boolean
  wrapperHealthy: boolean
  desktopHealthy: boolean
}

export type DiagnosisAction = 'none' | 'restarted' | 'restart_failed'

/**
 * POST /workspaces/:id/diagnose. `after` is null when nothing changed
 * (`none`) or the stop/start command itself failed (`restart_failed`).
 * `restarted` always has `after`, which may still be unhealthy.
 */
export type DiagnosisReport = {
  workspaceId: string
  before: DiagnosisSnapshot
  action: DiagnosisAction
  after: DiagnosisSnapshot | null
}

