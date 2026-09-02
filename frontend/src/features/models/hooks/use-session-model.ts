import { useQuery } from '@tanstack/react-query'
import { fetchSessionModel } from '@/features/models/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * What model the CURRENT chat session is actually on, not just the
 * agent's default — see `fetchSessionModel`'s doc comment in `api.ts` for
 * why `GET /api/session/status`'s own `model` field is the right source
 * of truth for this, and `types.ts`'s `SessionModel` for why that field
 * changes on its own once a turn is sent after the agent default changes.
 *
 * Gated on both `workspaceId` and `sessionId` — there is nothing to show
 * before a session exists (new-chat empty state has no session id yet,
 * matching `useChat`'s own session-gated queries in
 * `chat/hooks/use-chat.ts`).
 */
export function useSessionModel(workspaceId: string | undefined, sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.models.sessionModel(workspaceId ?? '', sessionId ?? ''),
    queryFn: () => fetchSessionModel(workspaceId as string, sessionId as string),
    enabled: Boolean(workspaceId && sessionId),
  })
}
