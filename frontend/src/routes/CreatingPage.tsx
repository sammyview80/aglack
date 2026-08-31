/** "/creating" — shows the result of the POST /workspaces call made on
 * the "/create" page. There is no GET-by-id / status-poll endpoint on
 * rust_gateway yet (see rust_gateway/src/app.rs — only POST /workspaces
 * exists), so this page can only display the one response it was handed;
 * it cannot poll a "creating" workspace to see if it later became "ready".
 * "Try again" re-submits the same workspace name, which is safe — the
 * gateway treats that name as an idempotency key (see
 * rust_gateway/src/workspaces/mod.rs) and retries rather than duplicating
 * the container. */
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { createWorkspace, type CreateWorkspaceResult } from '../api/workspaceClient'
import { clearCreateDraft } from '../onboarding/types'

type LocationState = {
  result: CreateWorkspaceResult
  workspaceName: string
}

export function CreatingPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state as LocationState | null
  const [result, setResult] = useState<CreateWorkspaceResult | null>(state?.result ?? null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Arriving here without state (e.g. direct URL visit, or a hard refresh
  // — router state does not survive a reload) means there's nothing to
  // show; send the user back to start over rather than rendering a blank
  // "creating" screen with no workspace to describe.
  if (!state) {
    return (
      <div className="onboarding-shell">
        <p>No workspace creation in progress.</p>
        <button type="button" className="ob-btn ob-btn--primary" onClick={() => navigate('/create')}>
          Back to create workspace
        </button>
      </div>
    )
  }

  async function retry() {
    setBusy(true)
    setError('')
    try {
      const next = await createWorkspace(state!.workspaceName)
      setResult(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
    } finally {
      setBusy(false)
    }
  }

  function finish() {
    clearCreateDraft()
    navigate('/')
  }

  return (
    <div className="onboarding-shell">
      <h1>Workspace: {state.workspaceName}</h1>

      {result?.status === 'ready' && (
        <>
          <p>Ready. Container: {result.containerName}</p>
          <button type="button" className="ob-btn ob-btn--primary" onClick={finish}>
            Done
          </button>
        </>
      )}

      {result?.status === 'creating' && (
        <>
          <p>
            Still creating — the gateway accepted the request but there is no status endpoint yet
            to confirm when it finishes. Try again in a moment.
          </p>
          <button type="button" className="ob-btn ob-btn--primary" onClick={retry} disabled={busy}>
            {busy ? 'Checking…' : 'Try again'}
          </button>
        </>
      )}

      {result?.status === 'failed' && (
        <>
          <p>Workspace creation failed.</p>
          <button type="button" className="ob-btn ob-btn--primary" onClick={retry} disabled={busy}>
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        </>
      )}

      {error ? <p className="ob-error" role="alert">{error}</p> : null}
    </div>
  )
}
