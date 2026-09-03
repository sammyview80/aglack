import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchAgentIntegrationEnablement,
  setAgentIntegrationEnabled,
} from '@/features/integrations/api'
import { queryKeys } from '@/lib/query-keys'
import { handleError } from '@/lib/handle-error'

export function useAgentIntegrationEnablement(workspaceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.integrations.agentEnablement(workspaceId ?? ''),
    queryFn: () => fetchAgentIntegrationEnablement(workspaceId as string),
    enabled: Boolean(workspaceId),
  })
}

export function useSetAgentIntegrationEnabled(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentSlug, enabled }: { agentSlug: string; enabled: boolean }) =>
      setAgentIntegrationEnabled(workspaceId as string, agentSlug, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrations.agentEnablement(workspaceId ?? ''),
      })
    },
    onError: (err) => handleError(err, { fallback: 'Could not update that agent.' }),
  })
}
