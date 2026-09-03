import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
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
  connected: 'Connected',
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
    <>
      <div className={cn(integrationsUi.catalogCard, isConnected && integrationsUi.catalogCardInstalled)}>
        <div className={integrationsUi.catalogCardTop}>
          <div className="relative shrink-0">
            <ProviderMark providerId={provider.id} icon={provider.icon} name={provider.name} />
            {isConnected ? (
              <span className="absolute -bottom-1 -right-1 flex size-[18px] items-center justify-center rounded-full bg-[#1e9e4e] text-white ring-2 ring-[var(--th-card)]">
                <CheckCircle2 size={12} strokeWidth={2.5} />
              </span>
            ) : null}
          </div>
          <div className={integrationsUi.catalogCardBody}>
            <p className={integrationsUi.catalogCardName}>{provider.name}</p>
            {provider.description ? (
              <p className={integrationsUi.catalogCardCategories}>{provider.description}</p>
            ) : null}
            {account ? <p className={integrationsUi.catalogCardUrl}>as {account}</p> : null}
            {connection?.lastError ? (
              <p className="mt-0.5 text-[11px] text-[#d1435b]">{connection.lastError}</p>
            ) : null}
          </div>
        </div>

        <div className={integrationsUi.catalogCardFooter}>
          {connection ? (
            <span className={statusBadgeClass(connection.status)}>{STATUS_LABEL[connection.status]}</span>
          ) : (
            <span className={integrationsUi.catalogCardAuthType}>
              {provider.oauthAvailable ? 'oauth' : 'api key'}
            </span>
          )}
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
                {isConnectingViaOAuth ? 'Waiting…' : 'Connect →'}
              </button>
            )}
          </div>
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
    </>
  )
}
