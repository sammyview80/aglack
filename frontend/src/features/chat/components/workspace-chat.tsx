import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ThreadsShell } from '@/components/threads-shell'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgents } from '@/features/agent-history/hooks/use-agent-history'
import { useChat } from '@/features/chat/hooks/use-chat'
import { ChatMessageList } from '@/features/chat/components/chat-message-list'
import { ChatComposer } from '@/features/chat/components/chat-composer'
import { ApprovalPrompt } from '@/features/chat/components/approval-prompt'
import { ClarifyPrompt } from '@/features/chat/components/clarify-prompt'

type WorkspaceChatProps = {
  workspaceId: string
  workspaceName: string
}

/**
 * Real streaming chat, per agent (Hermes profile). Each agent gets its own
 * session and SSE stream — `useChat` threads `agent` through every gateway
 * call as `?agent=<name>`, never a hidden global.
 */
export function WorkspaceChat({ workspaceId, workspaceName }: WorkspaceChatProps) {
  const agentsQuery = useAgents(workspaceId, true)
  const agents = agentsQuery.data?.agents ?? []
  const [agent, setAgent] = useState<string | null>(null)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)

  useEffect(() => {
    if (!agent && agents.length > 0) setAgent(agents[0].name)
  }, [agent, agents])

  const chat = useChat(workspaceId, agent)

  return (
    <ThreadsShell workspaceId={workspaceId} workspaceName={workspaceName} title="Thread">
      <div className="thread-scroll">
        <article className="thread-card">
          <div className="thread-main">
            <div className="post-author">
              <div>
                <div className="author-line">
                  <strong>Chat</strong>
                </div>
                <div className="meta-line">
                  <button
                    type="button"
                    className="chat-agent-picker"
                    onClick={() => setAgentMenuOpen((v) => !v)}
                    disabled={agents.length === 0}
                  >
                    {agent ?? 'No agent'} <ChevronDown size={13} />
                  </button>
                  {agentMenuOpen ? (
                    <div className="chat-agent-menu">
                      {agents.map((row) => (
                        <button
                          key={row.name}
                          type="button"
                          onClick={() => {
                            setAgent(row.name)
                            setAgentMenuOpen(false)
                          }}
                        >
                          {row.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="divider" />

            {agentsQuery.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : agents.length === 0 ? (
              <p className="empty-search">No agents are set up for this workspace yet.</p>
            ) : chat.sessionError ? (
              <p className="chat-message-error">{chat.sessionError}</p>
            ) : agent ? (
              <>
                <ChatMessageList
                  agent={agent}
                  turns={chat.turns}
                  isStreaming={chat.isStreaming}
                  streamingText={chat.assistantText}
                  reasoningText={chat.reasoningText}
                  tools={chat.tools}
                />
                {chat.approval ? (
                  <ApprovalPrompt prompt={chat.approval} onRespond={chat.respondApproval} />
                ) : null}
                {chat.clarify ? (
                  <ClarifyPrompt prompt={chat.clarify} onRespond={chat.respondClarify} />
                ) : null}
                {chat.canRetry ? (
                  <p className="chat-message-error">
                    Connection lost.{' '}
                    <button type="button" className="chat-retry-button" onClick={chat.retry}>
                      Retry
                    </button>
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          {agent ? (
            <ChatComposer
              disabled={chat.isSending || !agent}
              isStreaming={chat.isStreaming}
              onSend={chat.send}
              onStop={chat.stop}
            />
          ) : null}
        </article>
      </div>
    </ThreadsShell>
  )
}
