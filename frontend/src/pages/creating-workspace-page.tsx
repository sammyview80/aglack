import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createWorkspace } from '@/features/workspace/api'
import { CreatingStatus } from '@/features/workspace/components/creating-status'
import { clearCreateDraft } from '@/features/workspace/draft-storage'
import type { CreateWorkspaceResult } from '@/features/workspace/types'
import { handleError } from '@/lib/handle-error'
import { queryKeys } from '@/lib/query-keys'

type LocationState = {
  result: CreateWorkspaceResult
  workspaceName: string
}

export function CreatingWorkspacePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const state = location.state as LocationState | null
  const [result, setResult] = useState<CreateWorkspaceResult | null>(state?.result ?? null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (result?.status !== 'ready') return
    clearCreateDraft()
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
    navigate(`/onboarding/${result.workspaceId}`, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.status, result?.workspaceId, navigate])

  const retryMutation = useMutation({
    mutationFn: () => createWorkspace((state as LocationState).workspaceName),
    onSuccess: (next) => {
      setResult(next)
    },
    onError: (err) => {
      setError(
        handleError(err, {
          fallback: 'Failed to create workspace',
          messagesByCode: {
            workspace_name_taken: `"${state?.workspaceName}" is already taken — choose a different name.`,
            network: 'Cannot reach the gateway. Is rust_gateway running?',
          },
        }),
      )
    },
  })

  async function retry() {
    if (!state) return
    setError('')
    try {
      await retryMutation.mutateAsync()
    } catch {
      // handled in onError
    }
  }

  const busy = retryMutation.isPending

  if (result?.status === 'ready') return null

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
      onDone={() => {
        clearCreateDraft()
        navigate('/')
      }}
      onBack={() => navigate('/create')}
    />
  )
}
