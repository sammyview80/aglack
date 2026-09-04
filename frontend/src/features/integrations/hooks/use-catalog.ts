import { useEffect, useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { connectCatalogProvider, fetchCatalog } from '@/features/integrations/api'
import { queryKeys } from '@/lib/query-keys'
import { handleError } from '@/lib/handle-error'

const CATALOG_PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

/**
 * Trails `value` by `delayMs`, so a fast-typed search string only becomes a
 * query-key input once the user pauses. Plain local UI debounce — NOT a
 * fetch-in-effect (the fetch itself stays in `useInfiniteQuery`).
 */
export function useDebouncedValue(value: string, delayMs = SEARCH_DEBOUNCE_MS): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

/**
 * OpenConnector's full catalog, searched + paged. Same `useInfiniteQuery`
 * convention as `useWorkspaceList`: first page sends only `search`, later
 * pages send the echoed `limit` plus an `offset` of the loaded count, and
 * a short page ends the list. `search` is debounced so the key (and the
 * request) only changes once typing settles.
 */
export function useCatalog(search: string) {
  const debouncedSearch = useDebouncedValue(search.trim())
  const searchParam = debouncedSearch || undefined
  return useInfiniteQuery({
    queryKey: queryKeys.integrations.catalog({
      search: debouncedSearch,
      limit: CATALOG_PAGE_SIZE,
      offset: 0,
    }),
    queryFn: ({ pageParam }) =>
      fetchCatalog(
        pageParam === null
          ? { search: searchParam, limit: CATALOG_PAGE_SIZE }
          : { search: searchParam, limit: pageParam.limit, offset: pageParam.offset },
      ),
    initialPageParam: null as { limit: number; offset: number } | null,
    getNextPageParam: (lastPage) => {
      if (lastPage.providers.length < lastPage.limit) return undefined
      return { limit: lastPage.limit, offset: lastPage.offset + lastPage.providers.length }
    },
  })
}

const CATALOG_CONNECT_ERRORS: Record<string, string> = {
  provider_id_conflicts_with_curated_entry:
    'This service is already available as a built-in integration — use that one instead.',
  workspace_not_ready: 'This workspace has no running container yet.',
  openconnector_connect_failed:
    'The provider rejected that credential. Double-check the API key and try again.',
}

export function useConnectCatalogProvider(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ service, apiKey }: { service: string; apiKey: string }) =>
      connectCatalogProvider(workspaceId as string, service, apiKey),
    onSuccess: () => {
      toast.success('Connected.')
      // The curated Installed shelf reads the same connections list, so a
      // catalog-connected service must show up there too.
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.connections(workspaceId ?? '') })
    },
    onError: (err) =>
      handleError(err, { fallback: 'Could not connect.', messagesByCode: CATALOG_CONNECT_ERRORS }),
  })
}
