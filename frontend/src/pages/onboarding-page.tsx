import { useCallback, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { OnboardingWizard } from '@/features/onboarding/components/onboarding-wizard'

export function OnboardingPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const navigate = useNavigate()
  const [invalidWorkspace, setInvalidWorkspace] = useState(false)
  const onInvalidWorkspace = useCallback(() => setInvalidWorkspace(true), [])

  if (!workspaceId || invalidWorkspace) {
    return <Navigate to="/create" replace />
  }

  return (
    <OnboardingWizard
      workspaceId={workspaceId}
      onFinished={() => navigate('/create')}
      onInvalidWorkspace={onInvalidWorkspace}
    />
  )
}
