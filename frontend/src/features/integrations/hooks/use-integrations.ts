import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  connectIntegration,
  disconnectIntegration,
  fetchIntegrations,
} from '@/features/integrations/api'
import { queryKeys } from '@/lib/query-keys'
import { handleError } from '@/lib/handle-error'

/** Workspace's connected providers. Short `staleTime` (not `0`, unlike
 * the model catalog's own "always fresh" requirement) — this page is the
 * primary consumer and refetches on window focus by default is disabled
 * app-wide (see `lib/query-client.ts`), so a manual `refetch` after
 * connect/disconnect (via `invalidateQueries` below) is what actually
 * keeps this current, not polling. */
export function useIntegrations(workspaceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.integrations.connections(workspaceId ?? ''),
    queryFn: () => fetchIntegrations(workspaceId as string),
    enabled: Boolean(workspaceId),
  })
}

const CONNECT_ERRORS: Record<string, string> = {
  unknown_provider: 'Unknown provider.',
  openconnector_connect_failed:
    'The provider rejected that credential. Double-check the API key and try again.',
  workspace_not_ready: 'This workspace has no running container yet.',
}

export function useConnectIntegration(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ providerId, apiKey }: { providerId: string; apiKey: string }) =>
      connectIntegration(workspaceId as string, providerId, apiKey),
    onSuccess: () => {
      toast.success('Connected.')
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.connections(workspaceId ?? '') })
    },
    onError: (err) => handleError(err, { fallback: 'Could not connect.', messagesByCode: CONNECT_ERRORS }),
  })
}

export function useDisconnectIntegration(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (providerId: string) => disconnectIntegration(workspaceId as string, providerId),
    onSuccess: () => {
      toast.success('Disconnected.')
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.connections(workspaceId ?? '') })
    },
    onError: (err) => handleError(err, { fallback: 'Could not disconnect.' }),
  })
}
