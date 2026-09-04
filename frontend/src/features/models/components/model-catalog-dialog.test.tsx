import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelCatalogDialog } from '@/features/models/components/model-catalog-dialog'
import { renderWithClient } from '@/test/utils'
import * as modelsApi from '@/features/models/api'
import type { ModelCatalog } from '@/features/models/types'

vi.mock('@/features/models/api')
const mockedModelsApi = vi.mocked(modelsApi)

const CATALOG: ModelCatalog = {
  activeProvider: 'openai',
  defaultModel: 'gpt-4o',
  groups: [
    { provider: 'openai', models: [{ id: 'gpt-4o', label: 'GPT-4o' }] },
    { provider: 'anthropic', models: [{ id: 'claude-4', label: 'Claude 4' }] },
  ],
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ModelCatalogDialog fetch-on-open', () => {
  it('does not fetch the catalog while closed', () => {
    mockedModelsApi.fetchModelCatalog.mockResolvedValue(CATALOG)
    renderWithClient(
      <ModelCatalogDialog
        workspaceId="ws-1"
        open={false}
        onOpenChange={vi.fn()}
        isSelected={() => false}
        onToggle={vi.fn()}
      />,
    )
    expect(mockedModelsApi.fetchModelCatalog).not.toHaveBeenCalled()
  })

  it('fetches the full catalog fresh as soon as it opens', async () => {
    mockedModelsApi.fetchModelCatalog.mockResolvedValue(CATALOG)
    renderWithClient(
      <ModelCatalogDialog
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
        isSelected={() => false}
        onToggle={vi.fn()}
      />,
    )

    await waitFor(() => expect(mockedModelsApi.fetchModelCatalog).toHaveBeenCalledWith('ws-1'))
    expect(await screen.findByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('Claude 4')).toBeInTheDocument()
    // Grouped by provider (the "categories" from the wire response).
    expect(screen.getByText('openai')).toBeInTheDocument()
    expect(screen.getByText('anthropic')).toBeInTheDocument()
  })

  it('fetches again on every open, not just the first time (no indefinite caching)', async () => {
    mockedModelsApi.fetchModelCatalog.mockResolvedValue(CATALOG)
    const { rerender, client } = renderWithClient(
      <ModelCatalogDialog
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
        isSelected={() => false}
        onToggle={vi.fn()}
      />,
    )
    await waitFor(() => expect(mockedModelsApi.fetchModelCatalog).toHaveBeenCalledTimes(1))

    // Close, then reopen — a second real open must trigger a second fetch.
    const { QueryClientProvider } = await import('@tanstack/react-query')
    rerender(
      <QueryClientProvider client={client}>
        <ModelCatalogDialog
          workspaceId="ws-1"
          open={false}
          onOpenChange={vi.fn()}
          isSelected={() => false}
          onToggle={vi.fn()}
        />
      </QueryClientProvider>,
    )
    rerender(
      <QueryClientProvider client={client}>
        <ModelCatalogDialog
          workspaceId="ws-1"
          open
          onOpenChange={vi.fn()}
          isSelected={() => false}
          onToggle={vi.fn()}
        />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(mockedModelsApi.fetchModelCatalog).toHaveBeenCalledTimes(2))
  })
})

describe('ModelCatalogDialog ticking', () => {
  it('calls onToggle with the exact model+provider when a checkbox is ticked', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchModelCatalog.mockResolvedValue(CATALOG)
    const onToggle = vi.fn()
    renderWithClient(
      <ModelCatalogDialog
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
        isSelected={() => false}
        onToggle={onToggle}
      />,
    )

    await screen.findByText('GPT-4o')
    await user.click(screen.getByText('GPT-4o'))

    expect(onToggle).toHaveBeenCalledWith({ id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' })
  })

  it('renders a ticked model as checked using isSelected', async () => {
    mockedModelsApi.fetchModelCatalog.mockResolvedValue(CATALOG)
    renderWithClient(
      <ModelCatalogDialog
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
        isSelected={(provider, id) => provider === 'openai' && id === 'gpt-4o'}
        onToggle={vi.fn()}
      />,
    )

    await screen.findByText('GPT-4o')
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    const gptCheckbox = checkboxes.find((c) => c.checked)
    expect(gptCheckbox).toBeDefined()
  })

  it('closing without an explicit confirm keeps whatever was already toggled (no discard path)', async () => {
    // This test documents the resolved ambiguity: ticks are written to the
    // store immediately on toggle (via onToggle), so "close" never needs
    // to discard anything — there is no separate draft/confirm state to
    // roll back. Closing just calls onOpenChange(false); it must not call
    // onToggle again to "undo" prior ticks.
    const user = userEvent.setup()
    mockedModelsApi.fetchModelCatalog.mockResolvedValue(CATALOG)
    const onToggle = vi.fn()
    const onOpenChange = vi.fn()
    renderWithClient(
      <ModelCatalogDialog
        workspaceId="ws-1"
        open
        onOpenChange={onOpenChange}
        isSelected={() => false}
        onToggle={onToggle}
      />,
    )

    await screen.findByText('GPT-4o')
    await user.click(screen.getByText('GPT-4o'))
    expect(onToggle).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /^done$/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
    // No extra/undo toggle call fired on close.
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('allows adding a custom model for an existing or custom provider', async () => {
    const user = userEvent.setup()
    mockedModelsApi.fetchModelCatalog.mockResolvedValue(CATALOG)
    const onToggle = vi.fn()
    renderWithClient(
      <ModelCatalogDialog
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
        isSelected={() => false}
        onToggle={onToggle}
      />,
    )

    await screen.findByText('GPT-4o')
    await user.type(screen.getByLabelText(/custom model id/i), 'mistral-large')
    await user.type(screen.getByLabelText(/custom model display name/i), 'Mistral Large')
    await user.selectOptions(screen.getByLabelText(/custom model provider/i), 'openai')
    await user.click(screen.getByRole('button', { name: /add custom model/i }))

    expect(onToggle).toHaveBeenCalledWith({
      id: 'mistral-large',
      label: 'Mistral Large',
      provider: 'openai',
    })
  })
})
