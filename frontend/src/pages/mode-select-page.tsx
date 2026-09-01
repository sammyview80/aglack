import { useCallback, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { ModeSelect } from '@/features/agent-seeder/components/mode-select'

export function ModeSelectPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const navigate = useNavigate()
  const [invalidWorkspace, setInvalidWorkspace] = useState(false)
  const onInvalidWorkspace = useCallback(() => setInvalidWorkspace(true), [])

  if (!workspaceId || invalidWorkspace) {
    return <Navigate to="/create" replace />
  }

  return (
    <ModeSelect
      workspaceId={workspaceId}
      onFinished={() => navigate('/')}
      onInvalidWorkspace={onInvalidWorkspace}
      onBack={() => navigate('/')}
    />
  )
}
