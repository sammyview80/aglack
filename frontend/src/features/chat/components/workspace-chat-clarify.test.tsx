import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceChat } from '@/features/chat/components/workspace-chat'
import { renderWithClient } from '@/test/utils'
import * as agentHistoryApi from '@/features/agent-history/api'
import * as useChatModule from '@/features/chat/hooks/use-chat'

vi.mock('@/features/agent-history/api')
// useChat itself is mocked here (rather than driving it through a real SSE
// stream like workspace-chat.test.tsx does) because the thing under test is
// purely layout: does WorkspaceChat put the clarify prompt outside the
// scrollable transcript and above the composer, and does the "answer
// required" button reach the clarify input — none of that depends on how
// `clarify` state gets produced.
vi.mock('@/features/chat/hooks/use-chat')

const mockedAgentHistoryApi = vi.mocked(agentHistoryApi)
const mockedUseChat = vi.mocked(useChatModule.useChat)

function baseChat(overrides: Partial<ReturnType<typeof useChatModule.useChat>> = {}) {
  return {
    turns: [],
    isStreaming: false,
    isSending: false,
    assistantText: '',
    reasoningText: '',
    tools: [],
    approval: null,
    clarify: null,
    canRetry: false,
    sessionError: null,
    send: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    newChat: vi.fn(),
    reloadMessages: vi.fn(),
    isReloadingMessages: false,
    respondApproval: vi.fn(),
    respondClarify: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useChatModule.useChat>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderChat() {
  const router = createMemoryRouter(
    [{ path: '*', element: <WorkspaceChat workspaceId="ws-1" workspaceName="Test Workspace" /> }],
    { initialEntries: ['/workspaces/ws-1/chat?agent=agent-a'] },
  )
  return renderWithClient(<RouterProvider router={router} />)
}

describe('WorkspaceChat clarification layout', () => {
  it('renders the clarify prompt outside the scrollable transcript, above the composer', async () => {
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    mockedUseChat.mockReturnValue(
      baseChat({
        clarify: { clarifyId: 'c1', question: 'Which environment?', choicesOffered: ['staging', 'prod'] },
      }),
    )

    renderChat()

    const clarifyRegion = await screen.findByRole('region', { name: /clarification required/i })
    const transcript = document.querySelector('.chat-transcript')
    expect(transcript).not.toBeNull()
    // The prompt must be a sibling of (not nested inside) the scrollable
    // transcript region — nesting it there was the bug: it would scroll
    // out of view along with old messages instead of staying pinned.
    expect(transcript?.contains(clarifyRegion)).toBe(false)

    const composer = document.querySelector('.chat-composer')
    expect(composer).not.toBeNull()
    // DOCUMENT_POSITION_FOLLOWING (4) means clarifyRegion comes before composer.
    expect(clarifyRegion.compareDocumentPosition(composer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not show the "answer required" scroll button when there is no pending clarification', async () => {
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    mockedUseChat.mockReturnValue(baseChat())

    renderChat()

    // 'agent-a' matches multiple elements (sidebar list + chat header), so
    // wait on the header's unique meta line instead of the ambiguous name.
    await screen.findByText('New conversation')
    expect(screen.queryByRole('button', { name: /scroll to required clarification input/i })).not.toBeInTheDocument()
  })

  it('the "answer required" button scrolls to and focuses the clarify input', async () => {
    const user = userEvent.setup()
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    mockedUseChat.mockReturnValue(
      baseChat({
        clarify: { clarifyId: 'c1', question: 'Which environment?', choicesOffered: [] },
      }),
    )

    renderChat()

    const input = await screen.findByLabelText('Clarify answer')
    const scrollIntoView = vi.fn()
    input.scrollIntoView = scrollIntoView

    const button = screen.getByRole('button', { name: /scroll to required clarification input/i })
    await user.click(button)

    expect(scrollIntoView).toHaveBeenCalled()
    expect(input).toHaveFocus()
  })

  it('renders exactly one pending-input panel when both approval and clarify are set (approval wins)', async () => {
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    mockedUseChat.mockReturnValue(
      baseChat({
        approval: {
          approvalId: 'a1',
          description: 'Run deploy script',
          command: 'npm run deploy',
        },
        clarify: { clarifyId: 'c1', question: 'Which environment?', choicesOffered: ['staging'] },
      }),
    )

    renderChat()

    expect(await screen.findByRole('region', { name: /approval requested/i })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /clarification required/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /scroll to required clarification input/i })).not.toBeInTheDocument()
  })
})
