import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { ChatMessageList } from '@/features/chat/components/chat-message-list'
import type { ChatTurn } from '@/features/chat/hooks/use-chat'

afterEach(() => cleanup())

const turns: ChatTurn[] = [
  { id: '1', role: 'user', text: 'hello there', at: Date.now() },
  { id: '2', role: 'assistant', text: 'hi, how can I help?', at: Date.now() },
]

describe('ChatMessageList alignment and contrast', () => {
  it('renders user turns right-aligned and assistant turns left-aligned', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={turns}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
      />,
    )

    expect(screen.getByText('hello there').closest('.justify-end')).not.toBeNull()
    expect(screen.getByText('hi, how can I help?').closest('.justify-start')).not.toBeNull()
  })

  it('wraps messages in contrast bubbles', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={turns}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
      />,
    )

    expect(screen.getByText('hello there').closest('[data-bubble-tone="outgoing"]')).not.toBeNull()
    expect(screen.getByText('hi, how can I help?').closest('[data-bubble-tone="incoming"]')).not.toBeNull()
  })

  it('shows avatars beside messages without agent name labels', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={turns}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
      />,
    )

    expect(screen.queryByText('agent-a')).not.toBeInTheDocument()
    expect(screen.queryByText('You')).not.toBeInTheDocument()
    expect(screen.getAllByRole('time')).toHaveLength(2)
  })

  it('always shows timestamps outside message bubbles', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={turns}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
      />,
    )

    const times = screen.getAllByRole('time')
    expect(times).toHaveLength(2)
    expect(times[0].closest('.justify-end')).not.toBeNull()
    expect(times[1].closest('.justify-start')).not.toBeNull()
    expect(times[0].closest('[data-bubble-tone="outgoing"]')).toBeNull()
    expect(times[1].closest('[data-bubble-tone="incoming"]')).toBeNull()
  })

  it('shows a centered empty state with starter prompts when there are no turns', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={[]}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
        onSuggest={() => {}}
      />,
    )

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'agent-a' })).toBeInTheDocument()
    expect(screen.getByText(/Start a new conversation/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /What can you help me with/i })).toBeInTheDocument()
  })
})
