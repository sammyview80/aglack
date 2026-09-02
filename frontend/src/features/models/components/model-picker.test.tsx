import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelPicker } from '@/features/models/components/model-picker'
import { writeSelectedModels } from '@/features/models/selected-models-store'
import { clearPendingModel } from '@/features/models/pending-model-store'
import { createTestQueryClient, renderWithClient } from '@/test/utils'
import * as modelsApi from '@/features/models/api'

vi.mock('@/features/models/api')
const mockedModelsApi = vi.mocked(modelsApi)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
  // pending-model-store is in-memory/module-level (not per-render state,
  // matching upstream's own window._emptyComposerModelOverride) — must be
  // cleared explicitly or a pick from one test leaks into the next.
  clearPendingModel('ws-1', 'agent-a')
  clearPendingModel('ws-1', 'agent-b')
})

describe('ModelPicker empty state', () => {
  it('prompts to add models instead of rendering an empty confusing menu', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: null })
    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)

    await user.click(screen.getByRole('button', { name: /add model/i }))

    expect(screen.getByText(/no models picked yet/i)).toBeInTheDocument()
  })

  it('renders nothing when there is no active agent', () => {
    const { container } = renderWithClient(
      <ModelPicker workspaceId="ws-1" agent={null} sessionId={null} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ModelPicker shows only ticked models, grouped by provider', () => {
  it('lists only the models stored for this workspace+agent, grouped by provider', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: null })
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
      { id: 'claude-4', label: 'Claude 4', provider: 'anthropic' },
    ])
    // A different agent's shortlist must never leak into this menu.
    writeSelectedModels('ws-1', 'agent-b', [
      { id: 'other-model', label: 'Other Model', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)
    await user.click(screen.getByRole('button', { name: /model/i }))

    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('Claude 4')).toBeInTheDocument()
    expect(screen.getByText('openai')).toBeInTheDocument()
    expect(screen.getByText('anthropic')).toBeInTheDocument()
    expect(screen.queryByText('Other Model')).not.toBeInTheDocument()
  })
})

describe('ModelPicker selection calls setActiveModel (session-scoped)', () => {
  it('calls setActiveModel with the workspace, SESSION id, provider and model id of the clicked item', async () => {
    // Regression coverage: setActiveModel must be scoped to the SESSION
    // (matching the real Hermes WebUI composer's own POST
    // /api/session/update call), not the agent — an earlier, incorrect
    // version of this picker called a profile-wide default-model
    // endpoint keyed by agent instead.
    const user = userEvent.setup()
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: null })
    mockedModelsApi.setActiveModel.mockResolvedValue({ model: 'gpt-4o' })
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)
    await user.click(screen.getByRole('button', { name: /model/i }))
    await user.click(screen.getByText('GPT-4o'))

    await waitFor(() =>
      expect(mockedModelsApi.setActiveModel).toHaveBeenCalledWith('ws-1', 'sess-1', 'openai', 'gpt-4o'),
    )
  })

  it('shows an error message when setActiveModel fails', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: null })
    mockedModelsApi.setActiveModel.mockRejectedValue(new Error('model set failed'))
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)
    await user.click(screen.getByRole('button', { name: /model/i }))
    await user.click(screen.getByText('GPT-4o'))

    expect(await screen.findByText('model set failed')).toBeInTheDocument()
  })

  it('reflects the switch immediately from the mutation response, without a second fetch round trip', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: 'old-model' })
    mockedModelsApi.setActiveModel.mockResolvedValue({ model: 'gpt-4o' })
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)
    await user.click(await screen.findByRole('button', { name: /old-model/i }))
    await user.click(screen.getByText('GPT-4o'))

    // The trigger flips to the NEW model straight from setActiveModel's
    // own response — the real /api/session/update write already
    // confirmed this server-side, so no extra fetchSessionModel call is
    // needed to trust it.
    expect(await screen.findByRole('button', { name: /^gpt-4o$/i })).toBeInTheDocument()
    expect(mockedModelsApi.fetchSessionModel).toHaveBeenCalledTimes(1)
  })

  it('never lets a switch on one session affect a different session cached model', async () => {
    mockedModelsApi.fetchSessionModel.mockImplementation((_ws, sessionId) =>
      Promise.resolve({ model: sessionId === 'sess-1' ? 'sess-1-model' : 'sess-2-model' }),
    )
    mockedModelsApi.setActiveModel.mockResolvedValue({ model: 'gpt-4o' })
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])
    const user = userEvent.setup()
    // Shared QueryClient across both picker instances — this is what
    // actually exercises cache-key isolation; two independent clients
    // would trivially "pass" without proving anything.
    const client = createTestQueryClient()

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />, client)
    await user.click(await screen.findByRole('button', { name: /sess-1-model/i }))
    await user.click(screen.getByText('GPT-4o'))
    await screen.findByRole('button', { name: /^gpt-4o$/i })

    // A second picker instance bound to a DIFFERENT session, sharing the
    // SAME query client, must still show ITS OWN model, untouched by the
    // first picker's switch.
    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-2" />, client)
    expect(await screen.findByRole('button', { name: /sess-2-model/i })).toBeInTheDocument()
  })
})

describe('ModelPicker reflects the current session actual model', () => {
  it('shows the session real current model (from fetchSessionModel) as the trigger label', async () => {
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: 'gpt-4o' })
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)

    expect(await screen.findByRole('button', { name: /gpt-4o/i })).toBeInTheDocument()
  })

  it('falls back to the raw model id when the session model is not in the shortlist', async () => {
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: 'some-other-model' })
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)

    expect(await screen.findByRole('button', { name: /some-other-model/i })).toBeInTheDocument()
  })

  it('shows a generic label when the session has not started yet (model is null)', async () => {
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: null })
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)

    expect(await screen.findByRole('button', { name: /^model$/i })).toBeInTheDocument()
  })

  it('marks the session actual model as active inside the menu', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: 'claude-4' })
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
      { id: 'claude-4', label: 'Claude 4', provider: 'anthropic' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)
    await user.click(await screen.findByRole('button', { name: /claude 4/i }))

    const activeItem = screen.getByRole('menuitem', { name: 'Claude 4' })
    expect(activeItem.className).toMatch(/font-semibold/)
  })
})

describe('ModelPicker new-chat case (no session yet)', () => {
  // Regression coverage for "add model + new chat fails": before this fix,
  // picking a model with no session yet either silently no-oped or was
  // disabled entirely — the pick was lost the moment the user actually sent
  // their first message, because createSession() never carried it. Verified
  // against the real Hermes WebUI's own composer
  // (`window._emptyComposerModelOverride` in `backend/upstream/static/
  // sessions.js`), which remembers the pick and forwards it into the NEXT
  // `POST /api/session/new` call instead of trying to PATCH a session that
  // doesn't exist.
  it('does NOT call setActiveModel when there is no session yet (nothing to PATCH)', async () => {
    const user = userEvent.setup()
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId={null} />)
    await user.click(screen.getByRole('button', { name: /^model$/i }))
    await user.click(screen.getByText('GPT-4o'))

    expect(mockedModelsApi.setActiveModel).not.toHaveBeenCalled()
  })

  it('shows the pending pick as the trigger label immediately, with no session yet', async () => {
    const user = userEvent.setup()
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId={null} />)
    await user.click(screen.getByRole('button', { name: /^model$/i }))
    await user.click(screen.getByText('GPT-4o'))

    expect(await screen.findByRole('button', { name: /^gpt-4o$/i })).toBeInTheDocument()
  })

  it('items stay enabled with no session — a pick is stashed, not blocked', async () => {
    const user = userEvent.setup()
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId={null} />)
    await user.click(screen.getByRole('button', { name: /^model$/i }))

    expect(screen.getByRole('menuitem', { name: 'GPT-4o' })).not.toBeDisabled()
  })

  it('never leaks one agent pending pick into another agent with no session', async () => {
    const user = userEvent.setup()
    writeSelectedModels('ws-1', 'agent-a', [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ])
    writeSelectedModels('ws-1', 'agent-b', [
      { id: 'claude-4', label: 'Claude 4', provider: 'anthropic' },
    ])

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId={null} />)
    await user.click(screen.getByRole('button', { name: /^model$/i }))
    await user.click(screen.getByText('GPT-4o'))
    await screen.findByRole('button', { name: /^gpt-4o$/i })

    cleanup()
    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-b" sessionId={null} />)
    // agent-b never picked anything — must show its own empty state, not
    // agent-a's still-pending "gpt-4o".
    expect(screen.getByRole('button', { name: /^model$/i })).toBeInTheDocument()
  })
})

describe('ModelPicker Add model action', () => {
  it('opens the full catalog dialog from the compact picker', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchSessionModel.mockResolvedValue({ model: null })
    mockedModelsApi.fetchModelCatalog.mockResolvedValue({
      activeProvider: null,
      defaultModel: '',
      groups: [{ provider: 'openai', models: [{ id: 'gpt-4o', label: 'GPT-4o' }] }],
    })

    renderWithClient(<ModelPicker workspaceId="ws-1" agent="agent-a" sessionId="sess-1" />)
    await user.click(screen.getByRole('button', { name: /add model/i }))
    const menu = screen.getByRole('menu')
    await user.click(within(menu).getByRole('button', { name: /^add model$/i }))

    expect(await screen.findByRole('heading', { name: /add model/i })).toBeInTheDocument()
    await waitFor(() => expect(mockedModelsApi.fetchModelCatalog).toHaveBeenCalledWith('ws-1'))
  })
})
