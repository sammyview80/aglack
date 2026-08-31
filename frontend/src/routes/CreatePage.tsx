/** "/create" — the new-workspace form, seeded from any saved draft.
 * Extracted out of the former monolithic App.tsx. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createWorkspace } from '../api/workspaceClient'
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
  const [busy, setBusy] = useState(false)
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

  async function handleCreate(input: CreateWorkspaceInput) {
    setError('')
    saveCreateDraft(input)
    setBusy(true)
    try {
      // `workspaceName` is the idempotency key rust_gateway uses — see
      // rust_gateway/src/workspaces/mod.rs. A retry from /creating (e.g.
      // after a page refresh) reuses this same call safely.
      const result = await createWorkspace(input.workspaceName, input.password)
      // The gateway has no GET-by-id endpoint yet (see rust_gateway/src/app.rs
      // — only POST /workspaces exists), so /creating can't poll for status.
      // Pass the POST response through router state; it's the only status
      // this app can show until a status/poll endpoint is built.
      navigate('/creating', { state: { result, workspaceName: input.workspaceName } })
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
    }
  }

  return (
    <CreateWorkspace
      busy={busy}
      error={error}
      initial={initial}
      onBack={() => navigate('/')}
      onCreate={handleCreate}
    />
  )
}
