import { Dialog } from '@base-ui/react/dialog'
import { useState } from 'react'
import { StatusAlert } from '@/components/status-alert'
import { integrationsUi } from '@/features/integrations/integrations-ui'
import { useConnectIntegration } from '@/features/integrations/hooks/use-integrations'
import { errorMessage } from '@/lib/api'
import type { ProviderSummary } from '@/features/integrations/types'

type ConnectDialogProps = {
  workspaceId: string
  provider: ProviderSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * API-key connect, not an OAuth popup — see `features/integrations/api.ts`'s
 * own note on `connectIntegration`: the gateway's connect route only
 * implements `api_key` auth today. This is the honest reflection of that
 * in the UI, not a placeholder for a flow that already works elsewhere.
 */
export function ConnectDialog({ workspaceId, provider, open, onOpenChange }: ConnectDialogProps) {
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const connect = useConnectIntegration(workspaceId)

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    connect.mutate(
      { providerId: provider.id, apiKey },
      {
        onSuccess: () => {
          setApiKey('')
          onOpenChange(false)
        },
        onError: (err) => setError(errorMessage(err, 'Could not connect.')),
      },
    )
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setError('')
        onOpenChange(next)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={integrationsUi.dialogBackdrop} />
        <Dialog.Popup className={integrationsUi.dialog}>
          <Dialog.Title className={integrationsUi.dialogTitle}>Connect {provider.name}</Dialog.Title>
          <Dialog.Description className={integrationsUi.dialogCopy}>
            {provider.description ?? `Paste an API key for ${provider.name}.`}
          </Dialog.Description>
          <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
            <label className={integrationsUi.field} htmlFor="integration-api-key">
              API key
              <input
                id="integration-api-key"
                type="password"
                autoComplete="off"
                className={integrationsUi.input}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required
              />
            </label>
            {error && <StatusAlert message={error} />}
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" className={integrationsUi.cancel} onClick={() => onOpenChange(false)}>
                Cancel
              </button>
              <button type="submit" className={integrationsUi.connect} disabled={connect.isPending || !apiKey.trim()}>
                {connect.isPending ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
