import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { createWorkspace } from '@/features/workspace/api'
import { CreateWorkspaceForm } from '@/features/workspace/components/create-workspace-form'
import {
  clearCreateDraft,
  loadCreateDraft,
  loadOwnerName,
  saveCreateDraft,
} from '@/features/workspace/draft-storage'
import type { CreateWorkspaceInput } from '@/features/workspace/types'
import { handleError } from '@/lib/handle-error'

const CREATE_ERROR_CODES = (name: string): Record<string, string> => ({
  workspace_name_taken: `"${name}" is already taken — choose a different name.`,
  network: 'Cannot reach the gateway. Is rust_gateway running?',
})

export function CreateWorkspacePage() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const draft = loadCreateDraft()
  const initial = {
    ownerName: draft?.ownerName || loadOwnerName(),
    workspaceName: draft?.workspaceName || '',
    password: draft?.password,
    kind: draft?.kind,
  }

  async function handleCreate(input: CreateWorkspaceInput) {
    setError('')
    saveCreateDraft(input)
    setBusy(true)
    try {
      const result = await createWorkspace(input.workspaceName, input.password)
      toast.success(
        result.status === 'ready' ? 'Workspace is ready.' : 'Workspace request accepted.',
      )
      if (result.status === 'ready') {
        clearCreateDraft()
        navigate(`/onboarding/${result.workspaceId}`)
        return
      }
      navigate('/creating', { state: { result, workspaceName: input.workspaceName } })
    } catch (err) {
      setBusy(false)
      setError(
        handleError(err, {
          fallback: 'Failed to create workspace',
          messagesByCode: CREATE_ERROR_CODES(input.workspaceName),
        }),
      )
    }
  }

  return (
    <CreateWorkspaceForm
      busy={busy}
      error={error}
      initial={initial}
      onBack={() => navigate('/')}
      onCreate={handleCreate}
    />
  )
}
