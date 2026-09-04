import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { AgentToggleList } from '@/features/integrations/components/agent-toggle-list'
import { CatalogTab } from '@/features/integrations/components/catalog-tab'
import { ProviderCard } from '@/features/integrations/components/provider-card'
import { integrationsUi } from '@/features/integrations/integrations-ui'
import { useIntegrations } from '@/features/integrations/hooks/use-integrations'
import { useProviders } from '@/features/integrations/hooks/use-providers'
import { StatusAlert } from '@/components/status-alert'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { errorMessage } from '@/lib/api'
import type { IntegrationConnection, ProviderSummary } from '@/features/integrations/types'

type Shelf = 'all' | 'installed' | 'available' | 'browse'

function isInstalled(connection: IntegrationConnection | undefined) {
  return connection?.status === 'connected' || connection?.status === 'pending'
}

function matchesQuery(provider: ProviderSummary, query: string) {
  if (!query) return true
  const haystack = `${provider.name} ${provider.id} ${provider.description ?? ''}`.toLowerCase()
  return haystack.includes(query)
}

function ProviderSection({
  label,
  count,
  providers,
  workspaceId,
  connectionsByProvider,
}: {
  label: string
  count: number
  providers: ProviderSummary[]
  workspaceId: string
  connectionsByProvider: Map<string, IntegrationConnection>
}) {
  return (
    <div className={integrationsUi.section}>
      <div className={integrationsUi.sectionHead}>
        <span className={integrationsUi.sectionEyebrow}>{label}</span>
        <span className={integrationsUi.sectionCount}>{count}</span>
        <span className={integrationsUi.sectionLine} />
      </div>
      <div className={integrationsUi.catalogGrid}>
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            workspaceId={workspaceId}
            provider={provider}
            connection={connectionsByProvider.get(provider.id)}
          />
        ))}
      </div>
    </div>
  )
}

export function IntegrationsPageContent({ workspaceId }: { workspaceId: string }) {
  const providersQuery = useProviders()
  const connectionsQuery = useIntegrations(workspaceId)
  const [query, setQuery] = useState('')
  const [shelf, setShelf] = useState<Shelf>('all')

  const connectionsByProvider = useMemo(
    () => new Map((connectionsQuery.data ?? []).map((c) => [c.providerId, c])),
    [connectionsQuery.data],
  )

  const providers = providersQuery.data ?? []
  const installedCount = providers.filter((p) => isInstalled(connectionsByProvider.get(p.id))).length
  const visible = providers.filter((p) => {
    const conn = connectionsByProvider.get(p.id)
    if (shelf === 'installed' && !isInstalled(conn)) return false
    if (shelf === 'available' && isInstalled(conn)) return false
    return matchesQuery(p, query.trim().toLowerCase())
  })
  const connectedVisible = visible.filter((p) => isInstalled(connectionsByProvider.get(p.id)))
  const availableVisible = visible.filter((p) => !isInstalled(connectionsByProvider.get(p.id)))

  if (providersQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    )
  }

  if (providersQuery.isError) {
    return <StatusAlert message={errorMessage(providersQuery.error, 'Could not load providers.')} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6 max-[760px]:px-4">
      <div className="mx-auto w-full max-w-[1100px] flex flex-col gap-5">
      {/* Toolbar */}
      <div className={integrationsUi.toolbar}>
        <label className={integrationsUi.search}>
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
          />
        </label>
        <div className={integrationsUi.chips} role="tablist" aria-label="Plugin shelves">
          {(
            [
              { id: 'all', label: 'All', count: providers.length },
              { id: 'installed', label: 'Installed', count: installedCount },
              { id: 'available', label: 'Available', count: providers.length - installedCount },
              { id: 'browse', label: 'Browse all' },
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
              {'count' in chip ? <span className={integrationsUi.chipCount}>{chip.count}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {shelf === 'browse' ? (
        <CatalogTab workspaceId={workspaceId} />
      ) : visible.length === 0 ? (
        <p className={integrationsUi.empty}>No plugins match that search.</p>
      ) : shelf === 'all' ? (
        <div className="flex flex-col gap-6">
          {connectedVisible.length > 0 ? (
            <ProviderSection
              label="Connected"
              count={connectedVisible.length}
              providers={connectedVisible}
              workspaceId={workspaceId}
              connectionsByProvider={connectionsByProvider}
            />
          ) : null}
          {availableVisible.length > 0 ? (
            <ProviderSection
              label="Available"
              count={availableVisible.length}
              providers={availableVisible}
              workspaceId={workspaceId}
              connectionsByProvider={connectionsByProvider}
            />
          ) : null}
        </div>
      ) : (
        <div className={integrationsUi.catalogGrid}>
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
    </div>
  )
}
