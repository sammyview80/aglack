/** "/create" — the new-workspace form, seeded from any saved draft.
 * Extracted out of the former monolithic App.tsx. */
import { useNavigate } from 'react-router-dom'
import { CreateWorkspace, type CreateWorkspaceInput } from '../onboarding/CreateWorkspace'
import { loadCreateDraft, loadOwnerName, saveCreateDraft } from '../onboarding/types'

export function CreatePage({
  error,
  setError,
}: {
  error: string
  setError: (msg: string) => void
}) {
  const navigate = useNavigate()
  const draft = loadCreateDraft()
  const initial = {
    ownerName: draft?.ownerName || loadOwnerName(),
    // No hardcoded fallback — an empty field lets the "my-workspace"
    // placeholder show through (grey, not a literal pre-filled value),
    // matching the reference design. A real saved draft still restores.
    workspaceName: draft?.workspaceName || '',
    password: draft?.password,
    kind: draft?.kind,
  }

  return (
    <CreateWorkspace
      busy={false}
      error={error}
      initial={initial}
      onBack={() => navigate('/')}
      onCreate={(input: CreateWorkspaceInput) => {
        setError('')
        saveCreateDraft(input)
        navigate('/creating')
      }}
    />
  )
}
