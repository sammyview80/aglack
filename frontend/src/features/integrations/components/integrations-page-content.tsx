import { useMemo, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { AgentToggleList } from '@/features/integrations/components/agent-toggle-list'
import { ProviderCard } from '@/features/integrations/components/provider-card'
import { integrationsUi } from '@/features/integrations/integrations-ui'
import { useIntegrations } from '@/features/integrations/hooks/use-integrations'
import { useProviders } from '@/features/integrations/hooks/use-providers'
import { chatUi } from '@/features/chat/chat-ui'
import { StatusAlert } from '@/components/status-alert'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { errorMessage } from '@/lib/api'
import type { IntegrationConnection, ProviderSummary } from '@/features/integrations/types'

type Shelf = 'all' | 'installed' | 'available'

function isInstalled(connection: IntegrationConnection | undefined) {
  return connection?.status === 'connected' || connection?.status === 'pending'
}

function matchesQuery(provider: ProviderSummary, query: string) {
  if (!query) return true
  const haystack = `${provider.name} ${provider.id} ${provider.description ?? ''}`.toLowerCase()
  return haystack.includes(query)
}

function PluginsChrome({
  meta,
  children,
}: {
  meta: string
  children: ReactNode
}) {
  return (
    <div className={chatUi.threadScroll}>
      <article className={chatUi.threadCard}>
        <div className={chatUi.threadMain}>
          <div className={chatUi.headerRow}>
            <div className={chatUi.headerIdentity}>
              <strong className={chatUi.headerName}>Plugins</strong>
              <span className={chatUi.headerMeta}>{meta}</span>
            </div>
          </div>
          <div className={chatUi.divider} />
          {children}
        </div>
      </article>
    </div>
  )
}

export function IntegrationsPageContent({ workspaceId }: { workspaceId: string }) {
  const providersQuery = useProviders()
  const connectionsQuery = useIntegrations(workspaceId)
  const [query, setQuery] = useState('')
  const [shelf, setShelf] = useState<Shelf>('all')

  const connectionsByProvider = useMemo(
    () => new Map((connectionsQuery.data ?? []).map((connection) => [connection.providerId, connection])),
    [connectionsQuery.data],
  )

  const providers = providersQuery.data ?? []
  const installedCount = providers.filter((provider) => isInstalled(connectionsByProvider.get(provider.id))).length
  const visible = providers.filter((provider) => {
    const connection = connectionsByProvider.get(provider.id)
    if (shelf === 'installed' && !isInstalled(connection)) return false
    if (shelf === 'available' && isInstalled(connection)) return false
    return matchesQuery(provider, query.trim().toLowerCase())
  })

  if (providersQuery.isPending) {
    return (
      <PluginsChrome meta="Loading…">
        <div className={chatUi.transcript}>
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="mt-3 h-24 w-full rounded-lg" />
        </div>
      </PluginsChrome>
    )
  }

  if (providersQuery.isError) {
    return (
      <PluginsChrome meta="Could not load plugins">
        <StatusAlert message={errorMessage(providersQuery.error, 'Could not load providers.')} />
      </PluginsChrome>
    )
  }

  return (
    <PluginsChrome meta={`${providers.length} available · ${installedCount} installed`}>
      <div className={integrationsUi.toolbar}>
        <label className={integrationsUi.search}>
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
          />
        </label>
        <div className={integrationsUi.chips} role="tablist" aria-label="Plugin shelves">
          {(
            [
              { id: 'all', label: `All ${providers.length}` },
              { id: 'installed', label: `Installed ${installedCount}` },
              { id: 'available', label: 'Available' },
            ] as const
          ).map((chip) => (
            <button
              key={chip.id}
              type="button"
              role="tab"
              aria-selected={shelf === chip.id}
              className={cn(integrationsUi.chip, shelf === chip.id && integrationsUi.chipActive)}
              onClick={() => setShelf(chip.id)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className={chatUi.transcript}>
        {visible.length === 0 ? (
          <p className={integrationsUi.empty}>No plugins match that search.</p>
        ) : (
          <div className={integrationsUi.list}>
            {visible.map((provider) => (
              <ProviderCard
                key={provider.id}
                workspaceId={workspaceId}
                provider={provider}
                connection={connectionsByProvider.get(provider.id)}
              />
            ))}
          </div>
        )}
        <AgentToggleList workspaceId={workspaceId} />
      </div>
    </PluginsChrome>
  )
}
