import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

mockedApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })

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
    const history = screen.getByText('First session').closest('.audience-history')
    expect(within(history as HTMLElement).queryAllByRole('listitem').length).toBeGreaterThan(0)
  })

  it('renders a skeleton during the initial pending fetch', () => {
    const pending = deferred<Awaited<ReturnType<typeof api.listAgents>>>()
    mockedApi.listAgents.mockReturnValue(pending.promise)

    renderWithClient(<AgentHistoryPanel workspaceId="ws-1" open={true} />)

    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })
})
