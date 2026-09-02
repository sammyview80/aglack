import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentHistoryPanel } from '@/features/agent-history/components/agent-history-panel'
import { renderWithClient } from '@/test/utils'
import * as api from '@/features/agent-history/api'

vi.mock('@/features/agent-history/api')

const mockedApi = vi.mocked(api)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// This panel prefetches the newest session's messages on hover/list-load
// (feeds the real chat pane's cache — see agent-history-panel.tsx's own
// comment on the prefetch effect) even though it never renders a
// transcript itself. Give the mock a benign default so that prefetch
// never produces an unhandled "Query data cannot be undefined" warning
// in tests that don't care about it. beforeEach, not a one-time top-level
// call: afterEach's clearAllMocks wipes this too, and it must survive
// every single test, not just the first.
beforeEach(() => {
  mockedApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('AgentHistoryPanel fetch gating', () => {
  it('does not fetch agents while the panel is closed', () => {
    mockedApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    renderWithClient(<AgentHistoryPanel workspaceId="ws-1" open={false} />)

    expect(mockedApi.listAgents).not.toHaveBeenCalled()
    expect(mockedApi.listAgentSessions).not.toHaveBeenCalled()
    expect(mockedApi.listAgentMessages).not.toHaveBeenCalled()
  })

  it('fetches agents once the panel opens', async () => {
    mockedApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    renderWithClient(<AgentHistoryPanel workspaceId="ws-1" open={true} />)

    await waitFor(() => expect(mockedApi.listAgents).toHaveBeenCalledTimes(1))
  })
})

describe('AgentHistoryPanel agent switching', () => {
  it('never shows the previous agent sessions while the new agent is still loading', async () => {
    const user = userEvent.setup()
    mockedApi.listAgents.mockResolvedValue({
      agents: [{ name: 'agent-a' }, { name: 'agent-b' }],
    })

    const sessionsA = {
      sessions: [
        {
          sessionId: 'a-1',
          title: 'Agent A session title',
          messageCount: 1,
          updatedAt: 1,
          lastMessageAt: 1,
        },
      ],
      limit: 50,
      offset: 0,
    }
    const pendingB = deferred<Awaited<ReturnType<typeof api.listAgentSessions>>>()

    mockedApi.listAgentSessions.mockImplementation((_ws, agentName) => {
      if (agentName === 'agent-a') return Promise.resolve(sessionsA)
      return pendingB.promise
    })

    renderWithClient(<AgentHistoryPanel workspaceId="ws-1" open={true} />)

    await screen.findByLabelText('agent-a')
    await user.click(screen.getByLabelText('agent-a'))
    await screen.findByText('Agent A session title')

    await user.click(screen.getByLabelText('Back to agents'))
    await screen.findByLabelText('agent-b')
    await user.click(screen.getByLabelText('agent-b'))

    // agent-b's sessions are still pending: agent-a's title must not leak through.
    expect(screen.queryByText('Agent A session title')).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)

    await act(async () => {
      pendingB.resolve({ sessions: [], limit: 50, offset: 0 })
    })
    await screen.findByText('No history yet.')
  })
})

describe('AgentHistoryPanel onSelectSession', () => {
  it('fires onSelectSession with the exact agent and session clicked, and stays on the sessions list', async () => {
    const user = userEvent.setup()
    mockedApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    const session = {
      sessionId: 'sess-1',
      title: 'Clicked session',
      messageCount: 3,
      updatedAt: 1,
      lastMessageAt: 1,
    }
    mockedApi.listAgentSessions.mockResolvedValue({ sessions: [session], limit: 50, offset: 0 })
    const onSelectSession = vi.fn()

    renderWithClient(<AgentHistoryPanel workspaceId="ws-1" open={true} onSelectSession={onSelectSession} />)

    await screen.findByLabelText('agent-a')
    await user.click(screen.getByLabelText('agent-a'))
    await screen.findByText('Clicked session')
    await user.click(screen.getByText('Clicked session'))

    expect(onSelectSession).toHaveBeenCalledWith('agent-a', session)
    // This panel is sessions-list-only now — it never has its own separate
    // transcript view to navigate into (a real chat pane elsewhere owns
    // that). The clicked session's row must still be right there — no
    // "messages" view ever replaces this list.
    expect(screen.getByText('Clicked session')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: /messages/i })).not.toBeInTheDocument()
  })

  it('never navigates to a transcript view itself, even without onSelectSession wired', async () => {
    const user = userEvent.setup()
    mockedApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    mockedApi.listAgentSessions.mockResolvedValue({
      sessions: [{ sessionId: 'sess-1', title: 'No callback wired', messageCount: 1, updatedAt: 1, lastMessageAt: 1 }],
      limit: 50,
      offset: 0,
    })

    renderWithClient(<AgentHistoryPanel workspaceId="ws-1" open={true} />)

    await screen.findByLabelText('agent-a')
    await user.click(screen.getByLabelText('agent-a'))
    await screen.findByText('No callback wired')
    await user.click(screen.getByText('No callback wired'))

    // The click stays on the sessions list — no crash, no navigation, no
    // separate transcript view, even with no callback to report to.
    expect(screen.getByText('No callback wired')).toBeInTheDocument()
    expect(screen.getByLabelText('Back to agents')).toBeInTheDocument()
  })
})

describe('AgentHistoryPanel skeleton behavior', () => {
  it('shows a skeleton only on first load, not on a refetch that keeps prior content', async () => {
    mockedApi.listAgents.mockResolvedValue({ agents: [{ name: 'agent-a' }] })
    mockedApi.listAgentSessions.mockResolvedValue({
      sessions: [
        { sessionId: 's-1', title: 'First session', messageCount: 1, updatedAt: 1, lastMessageAt: 1 },
      ],
      limit: 50,
      offset: 0,
    })

    const user = userEvent.setup()
    renderWithClient(<AgentHistoryPanel workspaceId="ws-1" open={true} />)

    await screen.findByLabelText('agent-a')
    // Initial agents load rendered a skeleton before agents arrived — confirm the grid shows real content now.
    expect(screen.queryByLabelText('agent-a')).toBeInTheDocument()

    await user.click(screen.getByLabelText('agent-a'))
    await screen.findByText('First session')

    await user.click(screen.getByLabelText('Refresh history'))

    // A refetch must not rip the already-rendered session out for a skeleton.
    expect(screen.getByText('First session')).toBeInTheDocument()
    const history = screen.getByTestId('audience-history')
    expect(within(history).queryAllByRole('listitem').length).toBeGreaterThan(0)
  })

  it('renders a skeleton during the initial pending fetch', () => {
    const pending = deferred<Awaited<ReturnType<typeof api.listAgents>>>()
    mockedApi.listAgents.mockReturnValue(pending.promise)

    renderWithClient(<AgentHistoryPanel workspaceId="ws-1" open={true} />)

    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })
})
