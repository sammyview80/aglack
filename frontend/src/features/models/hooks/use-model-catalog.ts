import { useQuery } from '@tanstack/react-query'
import { fetchModelCatalog } from '@/features/models/api'
import { queryKeys } from '@/lib/query-keys'

/** Gated on `open` the same way `useAgents(workspaceId, panelOpen)` gates
 * on the agent-history panel (`frontend/src/features/agent-history/hooks/
 * use-agent-history.ts`) — the catalog dialog must never fetch while it
 * isn't showing, and it must fetch again EVERY time it opens rather than
 * silently reusing a stale cached copy (task requirement: "fetches the
 * FULL catalog fresh ... every time it opens"). `staleTime: 0` plus
 * `refetchOnMount: 'always'` is what actually forces that — React Query's
 * default would otherwise happily serve the cached result from the last
 * time the dialog was open without a network call. */
export function useModelCatalog(workspaceId: string | undefined, open: boolean) {
  return useQuery({
    queryKey: queryKeys.models.catalog(workspaceId ?? ''),
    queryFn: () => fetchModelCatalog(workspaceId as string),
    enabled: Boolean(workspaceId) && open,
    staleTime: 0,
    refetchOnMount: 'always',
  })
}
