import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'

/**
 * Never retry a structured 4xx application error (`workspace_not_found`,
 * `workspace_not_ready`, etc) — retrying a 404 is pure latency for the
 * user. `network` (fetch threw) and `invalid_response` (non-envelope body,
 * which `apiFetch` uses for 5xx/unreachable-wrapper responses too) are the
 * only codes worth one retry.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false
  if (error instanceof ApiError) {
    return error.code === 'network' || error.code === 'invalid_response'
  }
  return true
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
    },
    mutations: {
      retry: 0,
    },
  },
})
