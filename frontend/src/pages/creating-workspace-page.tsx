import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { createWorkspace } from '@/features/workspace/api'
import { CreatingStatus } from '@/features/workspace/components/creating-status'
import { clearCreateDraft } from '@/features/workspace/draft-storage'
import type { CreateWorkspaceResult } from '@/features/workspace/types'
import { handleError } from '@/lib/handle-error'

type LocationState = {
  result: CreateWorkspaceResult
  workspaceName: string
}

export function CreatingWorkspacePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state as LocationState | null
  const [result, setResult] = useState<CreateWorkspaceResult | null>(state?.result ?? null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function retry() {
    if (!state) return
    setBusy(true)
    setError('')
    try {
      const next = await createWorkspace(state.workspaceName)
      setResult(next)
    } catch (err) {
      setError(
        handleError(err, {
          fallback: 'Failed to create workspace',
          messagesByCode: {
            workspace_name_taken: `"${state.workspaceName}" is already taken — choose a different name.`,
            network: 'Cannot reach the gateway. Is rust_gateway running?',
          },
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  function finish() {
    clearCreateDraft()
    navigate('/')
  }

  return (
    <CreatingStatus
      workspaceName={state?.workspaceName ?? ''}
      result={state ? result : null}
      error={error}
      busy={busy}
      onRetry={retry}
      onContinue={() => {
        if (result) navigate(`/onboarding/${result.workspaceId}`)
      }}
      onDone={finish}
      onBack={() => navigate('/create')}
    />
  )
}
