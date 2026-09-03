import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { fetchIntegrations, startOAuthConnect } from '@/features/integrations/api'
import { queryKeys } from '@/lib/query-keys'
import { handleError } from '@/lib/handle-error'
import type { IntegrationConnection } from '@/features/integrations/types'

const POLL_INTERVAL_MS = 2000
/** Matches the gateway's own `OAUTH_PENDING_TIMEOUT_SECS`
 * (`rust_gateway/src/integrations/route.rs`) — stop polling client-side
 * at roughly the same point the server gives up and marks the row
 * `error`, rather than polling forever if a popup is silently closed. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Drives one OAuth popup connect for `providerId`: opens the real
 * provider authorization URL in a popup, then polls
 * `GET /workspaces/:id/integrations` (via the query cache — see
 * `useIntegrations`) until this provider's row leaves `pending`. The
 * gateway itself detects completion (see `list_integrations_route`'s
 * reconciliation pass) — this hook only watches for that, it does not
 * finish the connection itself.
 */
export function useOAuthConnect(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  const [connectingProviderId, setConnectingProviderId] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function stopPolling() {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    intervalRef.current = null
    timeoutRef.current = null
    setConnectingProviderId(null)
  }

  useEffect(() => stopPolling, [])

  async function start(providerId: string) {
    if (!workspaceId) return
    try {
      const authorizationUrl = await startOAuthConnect(workspaceId, providerId)
      popupRef.current = window.open(authorizationUrl, '_blank', 'width=520,height=680')
      if (!popupRef.current) {
        toast.error('Could not open the connect popup. Check your browser is not blocking popups.')
        return
      }
      setConnectingProviderId(providerId)

      intervalRef.current = setInterval(async () => {
        const connections = await queryClient.fetchQuery({
          queryKey: queryKeys.integrations.connections(workspaceId),
          queryFn: () => fetchIntegrations(workspaceId),
        })
        const connection = connections.find((c: IntegrationConnection) => c.providerId === providerId)
        if (connection && connection.status !== 'pending') {
          popupRef.current?.close()
          stopPolling()
          if (connection.status === 'connected') {
            toast.success('Connected.')
          } else if (connection.lastError) {
            toast.error(connection.lastError)
          }
        }
      }, POLL_INTERVAL_MS)

      timeoutRef.current = setTimeout(() => {
        popupRef.current?.close()
        stopPolling()
      }, POLL_TIMEOUT_MS)
    } catch (err) {
      handleError(err, { fallback: 'Could not start the connect flow.' })
    }
  }

  return { start, connectingProviderId }
}
