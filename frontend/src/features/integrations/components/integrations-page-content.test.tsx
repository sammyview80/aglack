import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntegrationsPageContent } from '@/features/integrations/components/integrations-page-content'
import { renderWithClient } from '@/test/utils'
import * as integrationsApi from '@/features/integrations/api'
import * as agentHistoryApi from '@/features/agent-history/api'
import type { IntegrationConnection, ProviderSummary } from '@/features/integrations/types'

vi.mock('@/features/integrations/api')
vi.mock('@/features/agent-history/api')
const mockedApi = vi.mocked(integrationsApi)
const mockedAgentHistoryApi = vi.mocked(agentHistoryApi)

const PROVIDERS: ProviderSummary[] = [
  { id: 'github', name: 'GitHub', icon: 'github', description: 'Repos and issues', oauthAvailable: false },
  { id: 'slack', name: 'Slack', icon: 'slack', description: 'Channels and messages', oauthAvailable: false },
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setup(connections: IntegrationConnection[] = []) {
  mockedApi.fetchProviders.mockResolvedValue(PROVIDERS)
  mockedApi.fetchIntegrations.mockResolvedValue(connections)
  mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [{ name: 'writer', isWorking: false }] })
  mockedApi.fetchAgentIntegrationEnablement.mockResolvedValue({ writer: false })
}

describe('IntegrationsPageContent', () => {
  it('renders one card per provider from the API, not a hardcoded list', async () => {
    setup()
    renderWithClient(<IntegrationsPageContent workspaceId="ws-1" />)

    expect(await screen.findByText('GitHub')).toBeInTheDocument()
    expect(screen.getByText('Slack')).toBeInTheDocument()
  })

  it('shows Connect for an unconnected provider and Disconnect for a connected one', async () => {
    setup([{ providerId: 'github', status: 'connected', accountLabel: 'octocat', lastError: null }])
    renderWithClient(<IntegrationsPageContent workspaceId="ws-1" />)

    await screen.findByText('GitHub')
    const githubCard = screen.getByText('GitHub').closest('[data-slot="card"]') as HTMLElement
    expect(within(githubCard).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()

    const slackCard = screen.getByText('Slack').closest('[data-slot="card"]') as HTMLElement
    expect(within(slackCard).getByRole('button', { name: 'Connect' })).toBeInTheDocument()
  })

  it('connect dialog submits the workspace id and provider id it was opened for', async () => {
    setup()
    mockedApi.connectIntegration.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderWithClient(<IntegrationsPageContent workspaceId="ws-42" />)

    await screen.findByText('GitHub')
    const connectButtons = screen.getAllByRole('button', { name: 'Connect' })
    await user.click(connectButtons[0])

    const input = await screen.findByLabelText('API key')
    await user.type(input, 'ghp_secret')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(mockedApi.connectIntegration).toHaveBeenCalledWith('ws-42', 'github', 'ghp_secret')
    })
  })

  it('OAuth-capable provider opens a popup via oauth/start instead of the API-key dialog', async () => {
    mockedApi.fetchProviders.mockResolvedValue([
      { id: 'github', name: 'GitHub', icon: 'github', description: null, oauthAvailable: true },
    ])
    mockedApi.fetchIntegrations.mockResolvedValue([])
    mockedAgentHistoryApi.listAgents.mockResolvedValue({ agents: [] })
    mockedApi.fetchAgentIntegrationEnablement.mockResolvedValue({})
    mockedApi.startOAuthConnect.mockResolvedValue('https://github.com/login/oauth/authorize?client_id=abc')
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window)
    const user = userEvent.setup()

    renderWithClient(<IntegrationsPageContent workspaceId="ws-oauth" />)
    await user.click(await screen.findByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(mockedApi.startOAuthConnect).toHaveBeenCalledWith('ws-oauth', 'github')
    })
    expect(windowOpen).toHaveBeenCalledWith(
      'https://github.com/login/oauth/authorize?client_id=abc',
      '_blank',
      expect.any(String),
    )
    // The api_key dialog must never mount for an OAuth-capable provider —
    // no "API key" field should exist anywhere on the page.
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()

    windowOpen.mockRestore()
  })

  it('per-agent toggle calls setAgentIntegrationEnabled with this workspace id, not a different one', async () => {
    setup()
    mockedApi.setAgentIntegrationEnabled.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderWithClient(<IntegrationsPageContent workspaceId="ws-only-this-one" />)

    const toggle = await screen.findByRole('switch')
    await user.click(toggle)

    await waitFor(() => {
      expect(mockedApi.setAgentIntegrationEnabled).toHaveBeenCalledWith(
        'ws-only-this-one',
        'writer',
        true,
      )
    })
  })
})
