import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import {
  useCatalog,
  useConnectCatalogProvider,
  useDebouncedValue,
} from '@/features/integrations/hooks/use-catalog'
import { createTestQueryClient } from '@/test/utils'
import { ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import * as integrationsApi from '@/features/integrations/api'
import type { CatalogProvider } from '@/features/integrations/types'

vi.mock('@/features/integrations/api')
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const mockedApi = vi.mocked(integrationsApi)

function provider(service: string): CatalogProvider {
  return { service, displayName: service.toUpperCase(), categories: [], authTypes: ['api_key'], homepageUrl: null }
}

function page(providers: CatalogProvider[], limit: number, offset: number, total: number) {
  return { providers, total, limit, offset }
}

function wrapperFor(client = createTestQueryClient()) {
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useDebouncedValue', () => {
  it('holds the previous value until the delay elapses, then emits only the latest', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: '' },
    })
    expect(result.current).toBe('')

    rerender({ value: 'g' })
    rerender({ value: 'gi' })
    rerender({ value: 'git' })
    expect(result.current).toBe('')

    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(result.current).toBe('')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe('git')
  })
})

describe('useCatalog', () => {
  it('debounces search: rapid changes fire one fetch after settling, not one per keystroke', async () => {
    mockedApi.fetchCatalog.mockResolvedValue(page([provider('github')], 50, 0, 1))
    const { wrapper } = wrapperFor()
    const { result, rerender } = renderHook(({ search }) => useCatalog(search), {
      initialProps: { search: '' },
      wrapper,
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockedApi.fetchCatalog).toHaveBeenCalledTimes(1)
    expect(mockedApi.fetchCatalog).toHaveBeenLastCalledWith({ search: undefined, limit: 50 })

    rerender({ search: 'g' })
    rerender({ search: 'gi' })
    rerender({ search: 'git' })
    // Still only the initial fetch — nothing fired per keystroke.
    expect(mockedApi.fetchCatalog).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(mockedApi.fetchCatalog).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(mockedApi.fetchCatalog).toHaveBeenLastCalledWith({ search: 'git', limit: 50 })
  })

  it('fetchNextPage appends the second page using the echoed limit and loaded-count offset', async () => {
    const first = Array.from({ length: 50 }, (_, i) => provider(`svc-${i}`))
    const second = [provider('svc-50'), provider('svc-51')]
    mockedApi.fetchCatalog.mockImplementation(async (params) =>
      params.offset === undefined ? page(first, 50, 0, 52) : page(second, 50, 50, 52),
    )
    const { wrapper } = wrapperFor()
    const { result } = renderHook(() => useCatalog(''), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.hasNextPage).toBe(true)

    await act(async () => {
      await result.current.fetchNextPage()
    })

    expect(mockedApi.fetchCatalog).toHaveBeenLastCalledWith({ search: undefined, limit: 50, offset: 50 })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2))
    const flat = result.current.data?.pages.flatMap((p) => p.providers) ?? []
    expect(flat).toHaveLength(52)
    expect(flat[0]?.service).toBe('svc-0')
    expect(flat[51]?.service).toBe('svc-51')
    expect(result.current.hasNextPage).toBe(false)
  })
})

describe('useConnectCatalogProvider', () => {
  it('invalidates this workspace connections key on success', async () => {
    mockedApi.connectCatalogProvider.mockResolvedValue(undefined)
    const { client, wrapper } = wrapperFor()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => useConnectCatalogProvider('ws-7'), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ service: 'notion', apiKey: 'secret' })
    })

    expect(mockedApi.connectCatalogProvider).toHaveBeenCalledWith('ws-7', 'notion', 'secret')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.integrations.connections('ws-7') })
    expect(toast.success).toHaveBeenCalledWith('Connected.')
  })

  it('maps provider_id_conflicts_with_curated_entry to the friendly message, not raw server text', async () => {
    mockedApi.connectCatalogProvider.mockRejectedValue(
      new ApiError({ code: 'provider_id_conflicts_with_curated_entry', message: 'raw backend text' }),
    )
    const { wrapper } = wrapperFor()
    const { result } = renderHook(() => useConnectCatalogProvider('ws-7'), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ service: 'github', apiKey: 'secret' }).catch(() => undefined)
    })

    expect(toast.error).toHaveBeenCalledWith(
      'This service is already available as a built-in integration — use that one instead.',
    )
    expect(toast.error).not.toHaveBeenCalledWith('raw backend text')
  })
})
