import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceChat } from '@/features/chat/components/workspace-chat'
import { renderWithClient } from '@/test/utils'
import * as agentHistoryApi from '@/features/agent-history/api'
import * as chatApi from '@/features/chat/api'

vi.mock('@/features/agent-history/api')
vi.mock('@/features/chat/api', async () => {
  const actual = await vi.importActual<typeof chatApi>('@/features/chat/api')
  return { ...actual, createSession: vi.fn(), getSessionStatus: vi.fn(), chatStreamUrl: vi.fn(() => 'http://gateway.test/stream') }
})

const mockedAgentHistoryApi = vi.mocked(agentHistoryApi)
const mockedChatApi = vi.mocked(chatApi)

class MockEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
})

function renderChat(initialUrl: string) {
  vi.stubGlobal('EventSource', MockEventSource)
  // createMemoryRouter (not the plain <MemoryRouter> component) so tests
  // can read `router.state.location` directly — needed to assert the URL
  // actually changed (e.g. New chat clearing `?session=`), not just that
  // the rendered content changed.
  const router = createMemoryRouter(
    [{ path: '*', element: <WorkspaceChat workspaceId="ws-1" workspaceName="Test Workspace" /> }],
    { initialEntries: [initialUrl] },
  )
  return { router, ...renderWithClient(<RouterProvider router={router} />) }
}

describe('WorkspaceChat agent + sessionStorage selection', () => {
  it('loads messages for the session stored in sessionStorage for the URL agent', async () => {
    window.sessionStorage.setItem('hermano.chat.selected.ws-1.agent-b', 'sess-from-store')
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }, { name: 'agent-b', isWorking: false }] })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'restored from history', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat?agent=agent-b')

    await screen.findByText('restored from history')
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledWith('ws-1', 'agent-b', 'sess-from-store')
    expect(mockedChatApi.createSession).not.toHaveBeenCalled()
  })

  it('defaults ?agent= to the first real agent when the URL has none yet', async () => {
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }] })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
    mockedChatApi.createSession.mockResolvedValue({ sessionId: 'auto-session' })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat')

    await waitFor(() => expect(screen.getByText('agent-a')).toBeInTheDocument())
  })

  it('shows the new-chat empty state when the agent has no sessionStorage entry', async () => {
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }] })

    renderChat('/workspaces/ws-1/chat?agent=agent-a')

    await screen.findByText(/Start a new conversation/i)
    expect(mockedAgentHistoryApi.listAgentMessages).not.toHaveBeenCalled()
    expect(mockedChatApi.getSessionStatus).not.toHaveBeenCalled()
  })

  it('switching agent via the sidebar uses each agent own sessionStorage entry', async () => {
    const user = userEvent.setup()
    window.sessionStorage.setItem('hermano.chat.selected.ws-1.agent-a', 'agent-a-session')
    window.sessionStorage.setItem('hermano.chat.selected.ws-1.agent-b', 'agent-b-session')
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }, { name: 'agent-b', isWorking: false }] })
    mockedAgentHistoryApi.listAgentSessions.mockResolvedValue({ sessions: [], limit: 50, offset: 0 })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat?agent=agent-a')

    // "agent-a" now appears twice (sidebar item + plain header text, since
    // this screen has no agent picker of its own anymore) — wait for the
    // sidebar list to actually be populated before scoping into it.
    await waitFor(() => {
      const section = screen.getByTestId('sidebar-chat-section')
      expect(within(section).queryByText('agent-b')).not.toBeNull()
    })
    const sidebarChatSection = screen.getByTestId('sidebar-chat-section')
    await user.click(within(sidebarChatSection).getByText('agent-b'))

    await waitFor(() =>
      expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledWith('ws-1', 'agent-b', 'agent-b-session'),
    )
    expect(mockedAgentHistoryApi.listAgentMessages).not.toHaveBeenCalledWith('ws-1', 'agent-b', 'agent-a-session')
  })

  it('clicking an agent in the sidebar switches the real chat to that agent stored session', async () => {
    const user = userEvent.setup()
    window.sessionStorage.setItem('hermano.chat.selected.ws-1.agent-a', 'agent-a-session')
    window.sessionStorage.setItem('hermano.chat.selected.ws-1.agent-b', 'agent-b-session')
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }, { name: 'agent-b', isWorking: false }] })
    mockedAgentHistoryApi.listAgentSessions.mockResolvedValue({ sessions: [], limit: 50, offset: 0 })
    mockedAgentHistoryApi.listAgentMessages.mockImplementation((_ws, agentName) =>
      Promise.resolve({
        messages: [{ role: 'assistant', content: `hello from ${agentName}`, timestamp: 1 }],
        limit: 50,
        offset: 0,
        total: 1,
      }),
    )
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat?agent=agent-a')

    await screen.findByText('hello from agent-a')

    // Scope to the sidebar's CHAT list explicitly since the header also
    // renders the agent's name as plain text now.
    const sidebarChatSection = screen.getByTestId('sidebar-chat-section')
    await user.click(within(sidebarChatSection).getByText('agent-b'))

    // The real chat pane switched to agent-b's OWN session (not agent-a's
    // stale one) — this is the whole point: previously a sidebar click
    // only ever changed the AUDIENCE panel's own separate selection, the
    // real chat never moved and the URL never updated.
    await screen.findByText('hello from agent-b')
    expect(mockedAgentHistoryApi.listAgentMessages).not.toHaveBeenCalledWith('ws-1', 'agent-b', 'agent-a-session')
  })
})

describe('WorkspaceChat new chat', () => {
  it('clears sessionStorage and starts a genuinely new session on the next send', async () => {
    const user = userEvent.setup()
    window.sessionStorage.setItem('hermano.chat.selected.ws-1.agent-a', 'old-session')
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }] })
    mockedAgentHistoryApi.listAgentSessions.mockResolvedValue({ sessions: [], limit: 50, offset: 0 })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({
      messages: [{ role: 'user', content: 'old conversation', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })
    mockedChatApi.createSession.mockResolvedValue({ sessionId: 'brand-new-session' })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat?agent=agent-a')

    await screen.findByText('old conversation')

    await user.click(screen.getByRole('button', { name: /new chat/i }))

    expect(screen.queryByText('old conversation')).not.toBeInTheDocument()
    expect(window.sessionStorage.getItem('hermano.chat.selected.ws-1.agent-a')).toBeNull()

    await user.type(screen.getByPlaceholderText(/message this agent/i), 'fresh start{enter}')

    await waitFor(() => expect(mockedChatApi.createSession).toHaveBeenCalledWith('ws-1', 'agent-a'))
  })

  it('disables the New chat button while a turn is actively streaming', async () => {
    window.sessionStorage.setItem('hermano.chat.selected.ws-1.agent-a', 'some-session')
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }] })
    mockedAgentHistoryApi.listAgentSessions.mockResolvedValue({ sessions: [], limit: 50, offset: 0 })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: 'live-stream' })

    renderChat('/workspaces/ws-1/chat?agent=agent-a')

    await waitFor(() => expect(screen.getByRole('button', { name: /new chat/i })).toBeDisabled())
  })
})
