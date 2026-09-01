import { useNavigate } from 'react-router-dom'
import { WorkspaceList } from '@/features/workspace/components/workspace-list'

export function WorkspacesPage() {
  const navigate = useNavigate()
  return (
    <WorkspaceList
      onCreate={() => navigate('/create')}
      onSetup={(workspaceId) => navigate(`/onboarding/${workspaceId}`)}
    />
  )
}
