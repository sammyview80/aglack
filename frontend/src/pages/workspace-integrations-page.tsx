import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ThreadsShell } from '@/components/threads-shell'
import { IntegrationsPageContent } from '@/features/integrations/components/integrations-page-content'

type LocationState = {
  name?: string
}

export function WorkspaceIntegrationsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const name = (location.state as LocationState | null)?.name

  if (!workspaceId) return null

  const workspaceName = name?.trim() || 'Workspace'

  return (
    <ThreadsShell
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      title="Plugins"
      onSelectAgent={(agentName) => {
        navigate(`/workspaces/${workspaceId}/chat?agent=${encodeURIComponent(agentName)}`, {
          state: { name: workspaceName },
        })
      }}
    >
      <IntegrationsPageContent workspaceId={workspaceId} />
    </ThreadsShell>
  )
}
