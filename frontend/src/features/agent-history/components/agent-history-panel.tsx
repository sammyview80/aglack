import { useEffect, useState } from 'react'
import { ChevronRight, MessageSquare, RotateCw, X } from 'lucide-react'
import { Hint } from '@/components/ui/tooltip'
import { RandomAvatar } from '@/components/random-avatar'
import { errorMessage } from '@/lib/api'
import { handleError } from '@/lib/handle-error'
import type { AgentSession } from '@/features/agent-history/types'
import { relativeTime } from '@/features/agent-history/components/relative-time'
import { AgentsSkeleton } from '@/features/agent-history/components/agents-skeleton'
import { SessionsSkeleton } from '@/features/agent-history/components/sessions-skeleton'
import { useAgentHistoryPrefetch, useAgentSessions, useAgents } from '@/features/agent-history/hooks/use-agent-history'
import { AnimatedPanel, motionPresets } from '@/components/motion'
import { threadsUi } from '@/components/threads-ui'

export function AgentHistoryPanel({
  workspaceId,
  open,
  selectedAgent: selectedAgentProp,
  onSelectedAgentChange,
  onSelectSession,
}: {
  workspaceId?: string
  open: boolean
  /** Optional external selection (e.g. the sidebar's real agent list in
   * threads-shell). When provided, clicking an agent there drives this
   * panel; the panel still owns its own agent selection and reports
   * changes back through onSelectedAgentChange. */
  selectedAgent?: string | null
  onSelectedAgentChange?: (name: string | null) => void
  /** Fired when a session row is clicked — lets a parent (the real chat
   * pane) load that exact session as the live, sendable conversation.
   * This panel itself only ever shows the sessions LIST, never a
   * transcript of its own — clicking a row does not navigate anywhere
   * inside this panel, only reports the click outward. */
  onSelectSession?: (agentName: string, session: AgentSession) => void
}) {
  const [selectedAgent, setSelectedAgentState] = useState<string | null>(null)

  function setSelectedAgent(name: string | null) {
    setSelectedAgentState(name)
    onSelectedAgentChange?.(name)
  }

  // Sync an externally-driven selection (sidebar click).
  useEffect(() => {
    if (selectedAgentProp === undefined) return
    if (selectedAgentProp === selectedAgent) return
    setSelectedAgentState(selectedAgentProp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentProp])

  const agentsQuery = useAgents(workspaceId, open)
  const sessionsQuery = useAgentSessions(workspaceId, selectedAgent, open)
  const { prefetchSessions, prefetchMessages } = useAgentHistoryPrefetch(workspaceId)

  const agents = agentsQuery.data?.agents ?? []
  const sessions = sessionsQuery.data?.sessions ?? []

  const agentsError = agentsQuery.isError ? errorMessage(agentsQuery.error, 'Could not load agents') : null
  const sessionsError = sessionsQuery.isError
    ? errorMessage(sessionsQuery.error, 'Could not load sessions')
    : null

  useEffect(() => {
    if (agentsQuery.isError) handleError(agentsQuery.error, { toast: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsQuery.isError, agentsQuery.error])

  useEffect(() => {
    if (sessionsQuery.isError) handleError(sessionsQuery.error, { toast: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsQuery.isError, sessionsQuery.error])

  // Prefetch the most-likely-next click once a session list resolves: the
  // first (newest) session's messages — never fan out to every session.
  // Still useful even though this panel no longer shows a transcript
  // itself: the real chat pane (WorkspaceChat) reads from the SAME
  // agent-history query cache when a session is selected, so this
  // prefetch still saves it a real network round trip.
  useEffect(() => {
    if (!selectedAgent || sessions.length === 0) return
    prefetchMessages(selectedAgent, sessions[0].sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent, sessions[0]?.sessionId])

  function selectAgent(agentName: string) {
    setSelectedAgent(agentName)
  }

  function selectSession(session: AgentSession) {
    if (selectedAgent) onSelectSession?.(selectedAgent, session)
  }

  function closeAgent() {
    setSelectedAgent(null)
  }

  function refresh() {
    if (!selectedAgent) return
    void sessionsQuery.refetch()
  }

  if (!workspaceId) {
    return (
      <div className={threadsUi.audienceGrid}>
        <p className={threadsUi.audienceEmpty}>No workspace selected.</p>
      </div>
    )
  }

  if (selectedAgent) {
    const sessionCount = sessions.length
    return (
      <AnimatedPanel swapKey={selectedAgent} className={threadsUi.audienceHistory} animation={motionPresets.contentSwap}>
        <div data-testid="audience-history">
        <div className={threadsUi.audienceHistoryHeader}>
          <div className={threadsUi.audienceHistoryIdentity}>
            <RandomAvatar seed={selectedAgent} size={30} />
            <div className={threadsUi.audienceHistoryIdentityCopy}>
              <span className={threadsUi.audienceHistoryBack}>{selectedAgent}</span>
              {!sessionsQuery.isPending && !sessionsError ? (
                <span className={threadsUi.audienceHistoryCount}>
                  {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
                </span>
              ) : null}
            </div>
          </div>
          <div className={threadsUi.audienceHistoryActions}>
            <Hint label="Refresh" side="top">
              <button type="button" className={threadsUi.audienceHistoryIcon} onClick={refresh} aria-label="Refresh history">
                <RotateCw size={14} />
              </button>
            </Hint>
            <Hint label="Close" side="top">
              <button type="button" className={threadsUi.audienceHistoryIcon} onClick={closeAgent} aria-label="Close agent history">
                <X size={14} />
              </button>
            </Hint>
          </div>
        </div>

        <SessionsList
          sessions={sessions}
          loading={sessionsQuery.isPending}
          error={sessionsError}
          onSelect={selectSession}
          onHoverSession={(session) => prefetchMessages(selectedAgent, session.sessionId)}
        />
        </div>
      </AnimatedPanel>
    )
  }

  if (agentsQuery.isPending) {
    return <AgentsSkeleton />
  }

  if (agentsError) {
    return (
      <div className={threadsUi.audienceGrid}>
        <p className={threadsUi.audienceEmpty}>{agentsError}</p>
        <Hint label="Retry" side="top">
          <button
            type="button"
            className={threadsUi.audienceHistoryIcon}
            onClick={() => void agentsQuery.refetch()}
            aria-label="Retry loading agents"
          >
            <RotateCw size={14} />
          </button>
        </Hint>
      </div>
    )
  }

  if (agents.length === 0) {
    return (
      <div className={threadsUi.audienceGrid}>
        <p className={threadsUi.audienceEmpty}>No agents yet.</p>
      </div>
    )
  }

  return (
    <div className={threadsUi.audienceGrid}>
      {agents.map((agent) => (
        <Hint key={agent.name} label={agent.name} side="top">
          <button
            type="button"
            className={threadsUi.audienceAvatarBtn}
            onClick={() => selectAgent(agent.name)}
            onMouseEnter={() => prefetchSessions(agent.name)}
            onFocus={() => prefetchSessions(agent.name)}
            aria-label={agent.name}
          >
            <RandomAvatar seed={agent.name} size={54} />
          </button>
        </Hint>
      ))}
    </div>
  )
}

function SessionsList({
  sessions,
  loading,
  error,
  onSelect,
  onHoverSession,
}: {
  sessions: AgentSession[]
  loading: boolean
  error: string | null
  onSelect: (session: AgentSession) => void
  onHoverSession: (session: AgentSession) => void
}) {
  if (loading) return <SessionsSkeleton />
  if (error) return <p className={threadsUi.audienceEmpty}>{error}</p>
  if (sessions.length === 0) return <p className={threadsUi.audienceEmpty}>No history yet.</p>

  return (
    <ul className={threadsUi.audienceSessionList}>
      {sessions.map((session, index) => (
        <li
          key={session.sessionId}
          className={motionPresets.messageEnter}
          style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}
        >
          <button
            type="button"
            className={threadsUi.audienceSessionItem}
            onClick={() => onSelect(session)}
            onMouseEnter={() => onHoverSession(session)}
            onFocus={() => onHoverSession(session)}
          >
            <span className={threadsUi.audienceSessionCopy}>
              <span className={threadsUi.audienceSessionTitle}>{session.title || 'Untitled session'}</span>
              <span className={threadsUi.audienceSessionMeta}>
                {relativeTime(session.lastMessageAt)}
                <span className={threadsUi.audienceSessionMetaDot} aria-hidden="true" />
                <MessageSquare size={11} strokeWidth={2.2} aria-hidden="true" />
                {session.messageCount}
              </span>
            </span>
            <ChevronRight size={15} strokeWidth={2} className={threadsUi.audienceSessionChevron} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )
}


