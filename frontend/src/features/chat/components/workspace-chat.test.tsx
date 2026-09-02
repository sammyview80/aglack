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
  window.localStorage.clear()
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

describe('WorkspaceChat URL-driven agent/session', () => {
  it('picks up ?agent= and ?session= from the URL instead of always defaulting to the first agent', async () => {
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }, { name: 'agent-b', isWorking: false }] })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'restored from history', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat?agent=agent-b&session=sess-from-url')

    await screen.findByText('restored from history')
    // agent-b, not agent-a (the list's own first entry) — the URL wins.
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledWith('ws-1', 'agent-b', 'sess-from-url')
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

  it('switching agent via the sidebar clears any session bound to the previous agent', async () => {
    const user = userEvent.setup()
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }, { name: 'agent-b', isWorking: false }] })
    mockedAgentHistoryApi.listAgentSessions.mockResolvedValue({ sessions: [], limit: 50, offset: 0 })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
    mockedChatApi.createSession.mockResolvedValue({ sessionId: 'agent-b-fresh-session' })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat?agent=agent-a&session=agent-a-session')

    // "agent-a" now appears twice (sidebar item + plain header text, since
    // this screen has no agent picker of its own anymore) — wait for the
    // sidebar list to actually be populated before scoping into it.
    await waitFor(() => {
      const section = screen.getByTestId('sidebar-chat-section')
      expect(within(section).queryByText('agent-b')).not.toBeNull()
    })
    const sidebarChatSection = screen.getByTestId('sidebar-chat-section')
    await user.click(within(sidebarChatSection).getByText('agent-b'))

    // agent-b must get its OWN session, never agent-a's stale session id.
    await waitFor(() =>
      expect(mockedAgentHistoryApi.listAgentMessages).not.toHaveBeenCalledWith('ws-1', 'agent-b', 'agent-a-session'),
    )
  })

  it('clicking an agent in the sidebar CHAT list also switches the real chat + updates the URL', async () => {
    const user = userEvent.setup()
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

    renderChat('/workspaces/ws-1/chat?agent=agent-a&session=agent-a-session')

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
  it('clears the URL session param and starts a genuinely new session on the next send', async () => {
    const user = userEvent.setup()
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

    const { router } = renderChat('/workspaces/ws-1/chat?agent=agent-a&session=old-session')

    await screen.findByText('old conversation')
    expect(router.state.location.search).toContain('session=old-session')

    await user.click(screen.getByRole('button', { name: /new chat/i }))

    // Old conversation content is gone from the transcript immediately —
    // starting a new chat must not leave stale turns visible.
    expect(screen.queryByText('old conversation')).not.toBeInTheDocument()
    // The URL no longer carries the old (or any) session id — the very
    // next message creates a real new session via createSession.
    expect(router.state.location.search).not.toContain('session=')

    await waitFor(() => expect(mockedChatApi.createSession).toHaveBeenCalledWith('ws-1', 'agent-a'))
  })

  it('clears the persisted localStorage session id, not only the URL', async () => {
    const user = userEvent.setup()
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }] })
    mockedAgentHistoryApi.listAgentSessions.mockResolvedValue({ sessions: [], limit: 50, offset: 0 })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
    // Deliberately never resolves — isolates the click's IMMEDIATE effect
    // (does newChat clear the stale persisted id right away?) from
    // whatever a subsequent createSession call would separately persist,
    // which is a different, already-covered behavior.
    mockedChatApi.createSession.mockReturnValue(new Promise(() => {}))
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    // No explicit `?session=` here — this is the persisted-session path
    // (the default chat tab), which is the one clicking New chat must
    // actually clear. If newChat only cleared the URL and not
    // localStorage, this exact case (no `?session=` to begin with) would
    // rebind to the stale persisted id on the very next mount regardless.
    window.localStorage.setItem('hermano.chat.session.ws-1.agent-a', 'persisted-old-session')

    renderChat('/workspaces/ws-1/chat?agent=agent-a')
    await waitFor(() => expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /new chat/i }))

    await waitFor(() =>
      expect(window.localStorage.getItem('hermano.chat.session.ws-1.agent-a')).toBeNull(),
    )
  })

  it('disables the New chat button while a turn is actively streaming', async () => {
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a', isWorking: false }] })
    mockedAgentHistoryApi.listAgentSessions.mockResolvedValue({ sessions: [], limit: 50, offset: 0 })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
    // agent_running: true (an already-active stream) — reconnects on
    // mount without any local send(), matching the reload-recovery path.
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: 'live-stream' })

    renderChat('/workspaces/ws-1/chat?agent=agent-a&session=some-session')

    await waitFor(() => expect(screen.getByRole('button', { name: /new chat/i })).toBeDisabled())
  })
})
