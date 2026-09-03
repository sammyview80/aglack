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
/** Consecutive poll failures tolerated before giving up — a single
 * transient blip must not abort a connect the user is mid-way through. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

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
  const consecutiveFailuresRef = useRef(0)

  function stopPolling() {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    intervalRef.current = null
    timeoutRef.current = null
    consecutiveFailuresRef.current = 0
    setConnectingProviderId(null)
  }

  useEffect(() => stopPolling, [])

  async function start(providerId: string) {
    if (!workspaceId) return
    const wsId = workspaceId
    try {
      const authorizationUrl = await startOAuthConnect(wsId, providerId)
      if (!isHttpUrl(authorizationUrl)) {
        handleError(new Error('invalid authorization URL scheme'), {
          fallback: 'Received an invalid connect URL.',
        })
        return
      }
      popupRef.current = window.open(authorizationUrl, '_blank', 'width=520,height=680')
      if (!popupRef.current) {
        toast.error('Could not open the connect popup. Check your browser is not blocking popups.')
        return
      }
      // Sever the popup's `window.opener` so a compromised provider page
      // cannot navigate this tab (reverse tabnabbing). We still keep our
      // own reference for `.close()` and closed-detection below.
      try {
        popupRef.current.opener = null
      } catch {
        // Cross-origin — we cannot touch it, which also means it is fine.
      }
      setConnectingProviderId(providerId)

      /** One poll of the connections list. Returns true when this
       * provider's row has left `pending` (polling should stop). */
      async function pollOnce(): Promise<boolean> {
        const connections = await queryClient.fetchQuery({
          queryKey: queryKeys.integrations.connections(wsId),
          queryFn: () => fetchIntegrations(wsId),
        })
        const connection = connections.find((c: IntegrationConnection) => c.providerId === providerId)
        if (!connection || connection.status === 'pending') return false
        popupRef.current?.close()
        stopPolling()
        if (connection.status === 'connected') {
          toast.success('Connected.')
        } else if (connection.lastError) {
          toast.error(connection.lastError)
        }
        return true
      }

      intervalRef.current = setInterval(async () => {
        if (popupRef.current?.closed) {
          // User closed the popup (or the provider closed it on success).
          // Clear the timers first so no further tick can race this one,
          // but let `pollOnce()` decide success/error (and call
          // `stopPolling()` itself) BEFORE we give up — resetting
          // `connectingProviderId` here first would flip the UI to "not
          // connecting" a tick before the success/error toast lands. A
          // still-pending result is not an error — stay silent.
          if (intervalRef.current) clearInterval(intervalRef.current)
          if (timeoutRef.current) clearTimeout(timeoutRef.current)
          intervalRef.current = null
          timeoutRef.current = null
          try {
            const settled = await pollOnce()
            if (!settled) stopPolling()
          } catch {
            // Nothing to surface: the flow is already over.
            stopPolling()
          }
          return
        }
        try {
          await pollOnce()
          consecutiveFailuresRef.current = 0
        } catch (err) {
          consecutiveFailuresRef.current += 1
          if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
            popupRef.current?.close()
            stopPolling()
            handleError(err, { fallback: 'Lost contact with the gateway while connecting.' })
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
