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
   */
  healthy: boolean
  hostPort: number | null
  desktopPort: number | null
  createdAt: string
}

export type ListWorkspacesResult = {
  workspaces: WorkspaceListItem[]
  limit: number
  offset: number
}

