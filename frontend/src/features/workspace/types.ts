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
