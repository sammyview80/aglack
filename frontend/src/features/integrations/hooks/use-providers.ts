import { useQuery } from '@tanstack/react-query'
import { fetchProviders } from '@/features/integrations/api'
import { queryKeys } from '@/lib/query-keys'

/** Not workspace-scoped and not gated on anything opening — the catalog
 * page needs it as soon as it mounts. */
export function useProviders() {
  return useQuery({
    queryKey: queryKeys.integrations.providers(),
    queryFn: fetchProviders,
  })
}
