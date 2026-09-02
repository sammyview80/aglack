import { useEffect, useState } from 'react'
import { ArrowLeft, RotateCw, X } from 'lucide-react'
import { Hint } from '@/components/ui/tooltip'
import { PixelAvatar } from '@/components/threads-shell'
import { errorMessage } from '@/lib/api'
import { handleError } from '@/lib/handle-error'
import type { AgentMessage, AgentSession } from '@/features/agent-history/types'
import { relativeTime } from '@/features/agent-history/components/relative-time'
import { AgentsSkeleton } from '@/features/agent-history/components/agents-skeleton'
import { SessionsSkeleton } from '@/features/agent-history/components/sessions-skeleton'
import { MessagesSkeleton } from '@/features/agent-history/components/messages-skeleton'
import {
  useAgentHistoryPrefetch,
  useAgentMessages,
  useAgentSessions,
  useAgents,
} from '@/features/agent-history/hooks/use-agent-history'

type View = 'sessions' | 'messages'

export function AgentHistoryPanel({ workspaceId, open }: { workspaceId?: string; open: boolean }) {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [view, setView] = useState<View>('sessions')
  const [selectedSession, setSelectedSession] = useState<AgentSession | null>(null)

  const agentsQuery = useAgents(workspaceId, open)
  const sessionsQuery = useAgentSessions(workspaceId, selectedAgent, open)
  const messagesQuery = useAgentMessages(
    workspaceId,
    selectedAgent,
    selectedSession?.sessionId ?? null,
    open,
  )
  const { prefetchSessions, prefetchMessages } = useAgentHistoryPrefetch(workspaceId)

  const agents = agentsQuery.data?.agents ?? []
  const sessions = sessionsQuery.data?.sessions ?? []
  const messages = messagesQuery.data?.messages ?? []

  const agentsError = agentsQuery.isError ? errorMessage(agentsQuery.error, 'Could not load agents') : null
  const sessionsError = sessionsQuery.isError
    ? errorMessage(sessionsQuery.error, 'Could not load sessions')
    : null
  const messagesError = messagesQuery.isError
    ? errorMessage(messagesQuery.error, 'Could not load messages')
    : null

  useEffect(() => {
    if (agentsQuery.isError) handleError(agentsQuery.error, { toast: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsQuery.isError, agentsQuery.error])

  useEffect(() => {
    if (sessionsQuery.isError) handleError(sessionsQuery.error, { toast: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsQuery.isError, sessionsQuery.error])

  useEffect(() => {
    if (messagesQuery.isError) handleError(messagesQuery.error, { toast: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesQuery.isError, messagesQuery.error])

  // Prefetch the most-likely-next click once a session list resolves: the
  // first (newest) session's messages — never fan out to every session.
  useEffect(() => {
    if (!selectedAgent || sessions.length === 0) return
    prefetchMessages(selectedAgent, sessions[0].sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent, sessions[0]?.sessionId])

  function selectAgent(agentName: string) {
    setSelectedAgent(agentName)
    setView('sessions')
    setSelectedSession(null)
  }

  function selectSession(session: AgentSession) {
    setSelectedSession(session)
    setView('messages')
  }

  function backToSessions() {
    setView('sessions')
    setSelectedSession(null)
  }

  function closeAgent() {
    setSelectedAgent(null)
    setSelectedSession(null)
  }

  function refresh() {
    if (!selectedAgent) return
    if (view === 'sessions') {
      void sessionsQuery.refetch()
      return
    }
    void messagesQuery.refetch()
  }

  if (!workspaceId) {
    return (
      <div className="audience-grid">
        <p className="audience-empty">No workspace selected.</p>
      </div>
    )
  }

  if (selectedAgent) {
    return (
      <div className="audience-history">
        <div className="audience-history-header">
          <button
            type="button"
            className="audience-history-back"
            onClick={view === 'messages' ? backToSessions : closeAgent}
            aria-label={view === 'messages' ? 'Back to sessions' : 'Back to agents'}
          >
            <ArrowLeft size={14} /> {view === 'messages' ? 'Sessions' : selectedAgent}
          </button>
          <div className="audience-history-actions">
            <Hint label="Refresh" side="top">
              <button type="button" className="audience-history-icon" onClick={refresh} aria-label="Refresh history">
                <RotateCw size={14} />
              </button>
            </Hint>
            <Hint label="Close" side="top">
              <button type="button" className="audience-history-icon" onClick={closeAgent} aria-label="Close agent history">
                <X size={14} />
              </button>
            </Hint>
          </div>
        </div>

        {view === 'sessions' ? (
          <SessionsList
            sessions={sessions}
            loading={sessionsQuery.isPending}
            error={sessionsError}
            onSelect={selectSession}
            onHoverSession={(session) => prefetchMessages(selectedAgent, session.sessionId)}
          />
        ) : (
          <MessagesList
            title={selectedSession?.title ?? ''}
            messages={messages}
            loading={messagesQuery.isPending}
            error={messagesError}
          />
        )}
      </div>
    )
  }

  if (agentsQuery.isPending) {
    return <AgentsSkeleton />
  }

  if (agentsError) {
    return (
      <div className="audience-grid">
        <p className="audience-empty">{agentsError}</p>
        <Hint label="Retry" side="top">
          <button
            type="button"
            className="audience-history-icon"
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
      <div className="audience-grid">
        <p className="audience-empty">No agents yet.</p>
      </div>
    )
  }

  return (
    <div className="audience-grid">
      {agents.map((agent) => (
        <Hint key={agent.name} label={agent.name} side="top">
          <button
            type="button"
            className="audience-avatar-btn"
            onClick={() => selectAgent(agent.name)}
            onMouseEnter={() => prefetchSessions(agent.name)}
            onFocus={() => prefetchSessions(agent.name)}
            aria-label={agent.name}
          >
            <PixelAvatar seed={agent.name} small />
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
  if (error) return <p className="audience-empty">{error}</p>
  if (sessions.length === 0) return <p className="audience-empty">No history yet.</p>

  return (
    <ul className="audience-session-list">
      {sessions.map((session) => (
        <li key={session.sessionId}>
          <button
            type="button"
            className="audience-session-item"
            onClick={() => onSelect(session)}
            onMouseEnter={() => onHoverSession(session)}
            onFocus={() => onHoverSession(session)}
          >
            <span className="audience-session-title">{session.title || 'Untitled session'}</span>
            <span className="audience-session-meta">
              {relativeTime(session.lastMessageAt)} · {session.messageCount} msg
              {session.messageCount === 1 ? '' : 's'}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function MessagesList({
  title,
  messages,
  loading,
  error,
}: {
  title: string
  messages: AgentMessage[]
  loading: boolean
  error: string | null
}) {
  return (
    <div className="audience-messages">
      {title ? <p className="audience-messages-title">{title}</p> : null}
      {loading ? <MessagesSkeleton /> : null}
      {!loading && error ? <p className="audience-empty">{error}</p> : null}
      {!loading && !error && messages.length === 0 ? (
        <p className="audience-empty">No history yet.</p>
      ) : null}
      {!loading && !error && messages.length > 0 ? (
        <ul className="audience-message-list">
          {messages.map((message, index) => (
            <li key={index} className="audience-message-item">
              <span className="audience-message-role">{message.role}</span>
              <p className="audience-message-content">{message.content}</p>
              <span className="audience-message-time">{relativeTime(message.timestamp)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
