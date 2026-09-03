import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { StatusAlert } from '@/components/status-alert'
import { Skeleton } from '@/components/ui/skeleton'
import { CatalogProviderMark } from '@/features/integrations/components/catalog-provider-mark'
import { ConnectDialog } from '@/features/integrations/components/connect-dialog'
import { integrationsUi } from '@/features/integrations/integrations-ui'
import { useCatalog, useConnectCatalogProvider } from '@/features/integrations/hooks/use-catalog'
import { useIntegrations } from '@/features/integrations/hooks/use-integrations'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { CatalogProvider, IntegrationConnection } from '@/features/integrations/types'

function isInstalled(connection: IntegrationConnection | undefined) {
  return connection?.status === 'connected' || connection?.status === 'pending'
}

/**
 * "Browse all" shelf: OpenConnector's full catalog, searched + paged via
 * `useCatalog`. Own search state — it drives a separate, server-paged query,
 * not the curated list's client-side filter. Connected state is read from
 * the same `useIntegrations` query the curated shelves use (TanStack Query
 * dedupes by key, so this is a cache read, not a second request).
 * Deliberately no disconnect here — an installed catalog row is the same
 * connection the Installed shelf already lets you disconnect.
 */
export function CatalogTab({ workspaceId }: { workspaceId: string }) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<CatalogProvider | null>(null)
  const catalogQuery = useCatalog(search)
  const connectionsQuery = useIntegrations(workspaceId)
  const connect = useConnectCatalogProvider(workspaceId)

  const connectionsByProvider = useMemo(
    () =>
      new Map(
        (connectionsQuery.data ?? []).map((connection) => [connection.providerId, connection]),
      ),
    [connectionsQuery.data],
  )

  const providers = catalogQuery.data?.pages.flatMap((page) => page.providers) ?? []
  const total = catalogQuery.data?.pages[0]?.total

  return (
    <>
      <div className={integrationsUi.toolbar}>
        <label className={integrationsUi.search}>
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search the full catalog"
            aria-label="Search the full catalog"
          />
        </label>
        {total !== undefined ? (
          <p className={integrationsUi.meta}>
            {total} {total === 1 ? 'service' : 'services'}
          </p>
        ) : null}
      </div>

      {catalogQuery.isPending ? (
        <div>
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="mt-3 h-16 w-full rounded-lg" />
        </div>
      ) : catalogQuery.isError ? (
        <div className="flex flex-col gap-3">
          <StatusAlert
            message={errorMessage(catalogQuery.error, 'Could not load catalog providers.')}
          />
          <div>
            <button
              type="button"
              className={integrationsUi.disconnect}
              onClick={() => catalogQuery.refetch()}
            >
              Retry
            </button>
          </div>
        </div>
      ) : providers.length === 0 ? (
        <p className={integrationsUi.empty}>No catalog providers match that search.</p>
      ) : (
        <>
          <div className={integrationsUi.catalogGrid}>
            {providers.map((provider) => {
              const installed = isInstalled(connectionsByProvider.get(provider.service))
              return (
                <button
                  key={provider.service}
                  type="button"
                  className={cn(
                    integrationsUi.catalogCard,
                    installed && integrationsUi.catalogCardInstalled,
                  )}
                  onClick={() => setSelected(provider)}
                >
                  <div className={integrationsUi.catalogCardTop}>
                    <CatalogProviderMark
                      service={provider.service}
                      displayName={provider.displayName}
                      homepageUrl={provider.homepageUrl}
                    />
                    <div className={integrationsUi.catalogCardBody}>
                      <p className={integrationsUi.catalogCardName}>{provider.displayName}</p>
                      {provider.categories.length > 0 ? (
                        <p className={integrationsUi.catalogCardCategories}>
                          {provider.categories.join(' · ')}
                        </p>
                      ) : null}
                      {provider.homepageUrl ? (
                        <p className={integrationsUi.catalogCardUrl}>
                          {provider.homepageUrl.replace(/^https?:\/\//, '')}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className={integrationsUi.catalogCardFooter}>
                    <span className={integrationsUi.catalogCardAuthType}>
                      {provider.authTypes[0]?.replace(/_/g, ' ') ?? 'api key'}
                    </span>
                    {installed ? (
                      <span className={integrationsUi.badge}>Connected</span>
                    ) : (
                      <span className={integrationsUi.catalogCardAction}>Connect →</span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
          {catalogQuery.hasNextPage ? (
            <div className="flex justify-center py-3">
              <button
                type="button"
                className={integrationsUi.disconnect}
                disabled={catalogQuery.isFetchingNextPage}
                onClick={() => catalogQuery.fetchNextPage()}
              >
                {catalogQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      )}

      {selected ? (
        <ConnectDialog
          workspaceId={workspaceId}
          provider={{ id: selected.service, name: selected.displayName, description: null }}
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null)
          }}
          submit={{
            connect: (apiKey, callbacks) =>
              connect.mutate({ service: selected.service, apiKey }, callbacks),
            isPending: connect.isPending,
          }}
        />
      ) : null}
    </>
  )
}
