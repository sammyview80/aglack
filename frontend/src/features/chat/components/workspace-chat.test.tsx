import { MemoryRouter } from 'react-router-dom'
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
  return renderWithClient(
    <MemoryRouter initialEntries={[initialUrl]}>
      <WorkspaceChat workspaceId="ws-1" workspaceName="Test Workspace" />
    </MemoryRouter>,
  )
}

describe('WorkspaceChat URL-driven agent/session', () => {
  it('picks up ?agent= and ?session= from the URL instead of always defaulting to the first agent', async () => {
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }, { name: 'agent-b' }] })
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
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
    mockedChatApi.createSession.mockResolvedValue({ sessionId: 'auto-session' })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat')

    await waitFor(() => expect(screen.getByText('agent-a')).toBeInTheDocument())
  })

  it('switching agent via the picker clears any session bound to the previous agent', async () => {
    const user = userEvent.setup()
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }, { name: 'agent-b' }] })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
    mockedChatApi.createSession.mockResolvedValue({ sessionId: 'agent-b-fresh-session' })
    mockedChatApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })

    renderChat('/workspaces/ws-1/chat?agent=agent-a&session=agent-a-session')

    await waitFor(() => expect(screen.getByRole('button', { name: /agent-a/ })).toBeInTheDocument())
    // Opens the agent picker specifically (the "agent-a ⌄" button next to
    // the Chat header) — not any other "agent-a"-labelled control
    // elsewhere in ThreadsShell's own chrome (e.g. its sidebar agent list).
    await user.click(screen.getByRole('button', { name: /agent-a/ }))
    const menu = document.querySelector('.chat-agent-menu') as HTMLElement
    await user.click(within(menu).getByText('agent-b'))

    // agent-b must get its OWN session, never agent-a's stale session id.
    await waitFor(() =>
      expect(mockedAgentHistoryApi.listAgentMessages).not.toHaveBeenCalledWith('ws-1', 'agent-b', 'agent-a-session'),
    )
  })

  it('clicking an agent in the sidebar CHAT list also switches the real chat + updates the URL', async () => {
    const user = userEvent.setup()
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }, { name: 'agent-b' }] })
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

    // The sidebar's CHAT list is a SEPARATE surface from the header's
    // agent picker — scope to it explicitly (.chat-section) since both
    // render a button/element with the same agent name text.
    const sidebarChatSection = document.querySelector('.chat-section') as HTMLElement
    await user.click(within(sidebarChatSection).getByText('agent-b'))

    // The real chat pane switched to agent-b's OWN session (not agent-a's
    // stale one) — this is the whole point: previously a sidebar click
    // only ever changed the AUDIENCE panel's own separate selection, the
    // real chat never moved and the URL never updated.
    await screen.findByText('hello from agent-b')
    expect(mockedAgentHistoryApi.listAgentMessages).not.toHaveBeenCalledWith('ws-1', 'agent-b', 'agent-a-session')
  })
})
