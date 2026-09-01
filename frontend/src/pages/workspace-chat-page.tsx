import { useLocation, useParams } from 'react-router-dom'
import { WorkspaceChat } from '@/features/chat/components/workspace-chat'

type ChatLocationState = {
  name?: string
}

export function WorkspaceChatPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const location = useLocation()
  const name = (location.state as ChatLocationState | null)?.name

  if (!workspaceId) return null

  return <WorkspaceChat workspaceId={workspaceId} workspaceName={name?.trim() || 'Workspace'} />
}
