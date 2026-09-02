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

  it('renders bare https URLs as clickable links that open in a new tab', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={[
          {
            id: '1',
            role: 'assistant',
            text: 'Go to https://miro.com/app/settings/user-profile/apps',
            at: Date.now(),
          },
        ]}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
      />,
    )

    const link = screen.getByRole('link', {
      name: 'https://miro.com/app/settings/user-profile/apps',
    })
    expect(link).toHaveAttribute('href', 'https://miro.com/app/settings/user-profile/apps')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('scrolls wide bubble content instead of overflowing the transcript', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={[
          {
            id: '1',
            role: 'user',
            text: 'DELEGATION BATCH COMPLETE ' + 'x'.repeat(80),
            at: Date.now(),
          },
        ]}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
      />,
    )

    const bubble = screen.getByText(/DELEGATION BATCH COMPLETE/).closest('[data-bubble-tone="outgoing"]')
    expect(bubble).not.toBeNull()
    expect(bubble?.className).toMatch(/\bchat-bubble\b/)
    expect(bubble?.className).toMatch(/\boverflow-x-auto\b/)
    expect(bubble?.className).toMatch(/\bmin-w-0\b/)
    expect(bubble?.className).toMatch(/\bmax-w-full\b/)
  })
})

describe('ChatMessageList attachments', () => {
  it('renders a real <img> thumbnail for an image attachment, sourced from the real /api/file/raw route', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={[
          {
            id: '1',
            role: 'user',
            text: 'check this out',
            at: Date.now(),
            attachments: [
              { name: 'photo.png', path: '/state/attachments/s1/photo.png', mime: 'image/png', size: 42, isImage: true },
            ],
          },
        ]}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
        workspaceId="ws-1"
        sessionId="session-a"
      />,
    )

    const img = screen.getByRole('img', { name: 'photo.png' })
    // A real, servable URL — not a client-only blob:/data: placeholder,
    // and not an invented scheme. See `attachmentFileUrl`'s doc comment
    // in `features/chat/api.ts` for exactly which upstream route this is.
    expect(img.getAttribute('src')).toContain('/api/file/raw')
    expect(img.getAttribute('src')).toContain('session_id=session-a')
    expect(img.getAttribute('src')).toContain('path=photo.png')
  })

  it('renders a filename+icon chip (no <img>) for a non-image attachment', () => {
    const { container } = render(
      <ChatMessageList
        agent="agent-a"
        turns={[
          {
            id: '1',
            role: 'user',
            text: 'the report',
            at: Date.now(),
            attachments: [
              { name: 'report.pdf', path: '/state/attachments/s1/report.pdf', mime: 'application/pdf', size: 2048, isImage: false },
            ],
          },
        ]}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
        workspaceId="ws-1"
        sessionId="session-a"
      />,
    )

    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    // Scoped to real HTML <img> elements — `queryByRole('img')` would also
    // match the unrelated user/agent avatar (an inline SVG with
    // `role="img"`), so assert on the tag itself instead.
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('falls back to a filename chip for an image attachment when there is no session context to build a real URL from', () => {
    // Without workspaceId/sessionId there is no real serving URL available
    // — must NOT emit a broken <img src> that 404s. See
    // `ChatAttachmentList`'s own doc comment for this fallback rule.
    render(
      <ChatMessageList
        agent="agent-a"
        turns={[
          {
            id: '1',
            role: 'user',
            text: 'check this out',
            at: Date.now(),
            attachments: [
              { name: 'photo.png', path: '/state/attachments/s1/photo.png', mime: 'image/png', size: 42, isImage: true },
            ],
          },
        ]}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
      />,
    )

    expect(screen.queryByRole('img', { name: 'photo.png' })).not.toBeInTheDocument()
    expect(screen.getByText('photo.png')).toBeInTheDocument()
  })

  it('renders nothing extra for a turn with no attachments', () => {
    render(
      <ChatMessageList
        agent="agent-a"
        turns={turns}
        isStreaming={false}
        streamingText=""
        reasoningText=""
        tools={[]}
        workspaceId="ws-1"
        sessionId="session-a"
      />,
    )

    expect(screen.queryByLabelText('Attachments')).not.toBeInTheDocument()
  })
})
