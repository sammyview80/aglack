import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { ConnectDialog } from '@/features/integrations/components/connect-dialog'
import { ProviderMark } from '@/features/integrations/components/provider-mark'
import { integrationsUi } from '@/features/integrations/integrations-ui'
import { useDisconnectIntegration } from '@/features/integrations/hooks/use-integrations'
import { useOAuthConnect } from '@/features/integrations/hooks/use-oauth-connect'
import { cn } from '@/lib/utils'
import type { IntegrationConnection, ProviderSummary } from '@/features/integrations/types'

type ProviderCardProps = {
  workspaceId: string
  provider: ProviderSummary
  connection: IntegrationConnection | undefined
}

const STATUS_LABEL: Record<IntegrationConnection['status'], string> = {
  connected: 'Installed',
  pending: 'Connecting…',
  needs_reauth: 'Reconnect',
  disconnected: 'Available',
  error: 'Error',
}

const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function accountCaption(label: string | null | undefined): string | null {
  if (!label) return null
  if (UUID_IN.test(label) || /^ws-/i.test(label) || label.length > 32) return null
  return label
}

function statusBadgeClass(status: IntegrationConnection['status']) {
  if (status === 'needs_reauth' || status === 'error') return integrationsUi.badgeWarn
  return integrationsUi.badge
}

export function ProviderCard({ workspaceId, provider, connection }: ProviderCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const disconnect = useDisconnectIntegration(workspaceId)
  const oauthConnect = useOAuthConnect(workspaceId)
  const isConnected = connection?.status === 'connected'
  const isConnectingViaOAuth = oauthConnect.connectingProviderId === provider.id
  const account = accountCaption(connection?.accountLabel)

  function handleConnectClick() {
    if (provider.oauthAvailable) {
      oauthConnect.start(provider.id)
    } else {
      setDialogOpen(true)
    }
  }

  return (
    <Card className={cn(integrationsUi.card, isConnected && integrationsUi.cardConnected)}>
      <div className={integrationsUi.cardInner}>
        <ProviderMark providerId={provider.id} icon={provider.icon} name={provider.name} />
        <div className={integrationsUi.cardCopy}>
          <div className="flex items-start justify-between gap-2">
            <p className={integrationsUi.title}>{provider.name}</p>
            {connection ? (
              <span className={statusBadgeClass(connection.status)}>{STATUS_LABEL[connection.status]}</span>
            ) : null}
          </div>
          <p className={integrationsUi.blurb}>{provider.description ?? provider.id}</p>
          {account ? <p className={integrationsUi.meta}>as {account}</p> : null}
          {connection?.lastError ? <p className="text-xs text-[#d1435b]">{connection.lastError}</p> : null}
        </div>
        <div className={integrationsUi.actions}>
          {isConnected ? (
            <button
              type="button"
              className={integrationsUi.disconnect}
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate(provider.id)}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : (
            <button
              type="button"
              className={integrationsUi.connect}
              disabled={isConnectingViaOAuth}
              onClick={handleConnectClick}
            >
              {isConnectingViaOAuth ? 'Waiting for popup…' : 'Connect'}
            </button>
          )}
        </div>
      </div>
      {!provider.oauthAvailable && (
        <ConnectDialog
          workspaceId={workspaceId}
          provider={provider}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </Card>
  )
}
