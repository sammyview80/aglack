import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelPicker } from '@/features/models/components/model-picker'
import { writeSelectedModels } from '@/features/models/selected-models-store'
import { renderWithClient } from '@/test/utils'
import * as modelsApi from '@/features/models/api'

vi.mock('@/features/models/api')
const mockedModelsApi = vi.mocked(modelsApi)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('ModelPicker empty state', () => {
  it('prompts to add models instead of rendering an empty confusing menu', async () => {
    const user = userEvent.setup()
    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" />)

    await user.click(screen.getByRole('button', { name: /add model/i }))

    expect(screen.getByText(/no models picked yet/i)).toBeInTheDocument()
  })

  it('renders nothing when there is no active agent', () => {
    const { container } = renderWithClient(<ModelPicker workspaceId="ws-1" agent={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ModelPicker shows only ticked models, grouped by provider', () => {
  it('lists only the models stored for this workspace+agent, grouped by provider', async () => {
    const user = userEvent.setup()
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
      { id: 'claude-4', label: 'Claude 4', provider: 'anthropic' },
    ])
    // A different agent's shortlist must never leak into this menu.
    writeSelectedModels('ws-1', 'agent-b', [
      { id: 'other-model', label: 'Other Model', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" />)
    await user.click(screen.getByRole('button', { name: /model/i }))

    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('Claude 4')).toBeInTheDocument()
    expect(screen.getByText('openai')).toBeInTheDocument()
    expect(screen.getByText('anthropic')).toBeInTheDocument()
    expect(screen.queryByText('Other Model')).not.toBeInTheDocument()
  })
})

describe('ModelPicker selection calls setActiveModel', () => {
  it('calls setActiveModel with the workspace, agent, provider and model id of the clicked item', async () => {
    const user = userEvent.setup()
    mockedModelsApi.setActiveModel.mockResolvedValue(undefined)
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" />)
    await user.click(screen.getByRole('button', { name: /model/i }))
    await user.click(screen.getByText('GPT-4o'))

    await waitFor(() =>
      expect(mockedModelsApi.setActiveModel).toHaveBeenCalledWith('ws-1', 'agent-a', 'openai', 'gpt-4o'),
    )
  })

  it('shows an error message when setActiveModel fails', async () => {
    const user = userEvent.setup()
    mockedModelsApi.setActiveModel.mockRejectedValue(new Error('model set failed'))
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" />)
    await user.click(screen.getByRole('button', { name: /model/i }))
    await user.click(screen.getByText('GPT-4o'))

    expect(await screen.findByText('model set failed')).toBeInTheDocument()
  })
})

describe('ModelPicker Add model action', () => {
  it('opens the full catalog dialog from the compact picker', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchModelCatalog.mockResolvedValue({
      activeProvider: null,
      defaultModel: '',
      groups: [{ provider: 'openai', models: [{ id: 'gpt-4o', label: 'GPT-4o' }] }],
    })

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" />)
    await user.click(screen.getByRole('button', { name: /add model/i }))
    const menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('button', { name: /^add model$/i }))

    expect(await screen.findByRole('heading', { name: /add model/i })).toBeInTheDocument()
    await waitFor(() => expect(mockedModelsApi.fetchModelCatalog).toHaveBeenCalledWith('ws-1'))
  })
})
