import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useWorkspaceList } from '@/features/workspace/hooks/use-workspace-list'
import { createTestQueryClient } from '@/test/utils'
import * as api from '@/features/workspace/api'
import type { WorkspaceListItem } from '@/features/workspace/types'

vi.mock('@/features/workspace/api')

const mockedApi = vi.mocked(api)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function makeRow(id: string): WorkspaceListItem {
  return {
    workspaceId: id,
    name: id,
    status: 'ready',
    healthy: true,
    hostPort: null,
    desktopPort: null,
    createdAt: new Date().toISOString(),
  } as WorkspaceListItem
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

describe('useWorkspaceList pagination', () => {
  const ECHOED_LIMIT = 7

  it('sends no limit/offset on the first page, then the echoed limit and loaded-count offset on loadMore', async () => {
    const firstPage = {
      workspaces: Array.from({ length: ECHOED_LIMIT }, (_, i) => makeRow(`ws-${i}`)),
      limit: ECHOED_LIMIT,
      offset: 0,
    }
    const secondPage = {
      workspaces: [makeRow('ws-extra')],
      limit: ECHOED_LIMIT,
      offset: ECHOED_LIMIT,
    }

    mockedApi.listWorkspaces.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage)

    const { result } = renderHook(() => useWorkspaceList(), { wrapper })

    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(mockedApi.listWorkspaces).toHaveBeenNthCalledWith(1, {})
    expect(result.current.items).toHaveLength(ECHOED_LIMIT)
    expect(result.current.lastPageFull).toBe(true)

    result.current.loadMore()

    await waitFor(() => expect(mockedApi.listWorkspaces).toHaveBeenCalledTimes(2))
    expect(mockedApi.listWorkspaces).toHaveBeenNthCalledWith(2, {
      limit: ECHOED_LIMIT,
      offset: ECHOED_LIMIT,
    })

    await waitFor(() => expect(result.current.items).toHaveLength(ECHOED_LIMIT + 1))
  })

  it('stops paginating once a page comes back short of its limit', async () => {
    const shortPage = {
      workspaces: [makeRow('ws-only')],
      limit: 50,
      offset: 0,
    }
    mockedApi.listWorkspaces.mockResolvedValueOnce(shortPage)

    const { result } = renderHook(() => useWorkspaceList(), { wrapper })

    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.lastPageFull).toBe(false)

    act(() => {
      result.current.loadMore()
    })

    // No further fetch should be issued for a short page.
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(mockedApi.listWorkspaces).toHaveBeenCalledTimes(1)
  })
})
