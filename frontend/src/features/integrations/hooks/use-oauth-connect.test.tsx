import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useOAuthConnect } from '@/features/integrations/hooks/use-oauth-connect'
import { createTestQueryClient } from '@/test/utils'
import * as api from '@/features/integrations/api'
import { handleError } from '@/lib/handle-error'
import type { IntegrationConnection } from '@/features/integrations/types'

vi.mock('@/features/integrations/api')
vi.mock('@/lib/handle-error', () => ({ handleError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockedApi = vi.mocked(api)
const mockedHandleError = vi.mocked(handleError)

const POLL_INTERVAL_MS = 2000
const WORKSPACE_ID = 'ws-1'
const PROVIDER_ID = 'github'

class MockPopup {
  closed = false
  opener: unknown = { stillLinked: true }
  close() {
    this.closed = true
  }
}

let popup: MockPopup
const openSpy = vi.fn<(...args: unknown[]) => Window | null>()

function pendingRow(): IntegrationConnection[] {
  return [{ providerId: PROVIDER_ID, status: 'pending', accountLabel: null, lastError: null }]
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

/** Advance one poll tick and flush the microtasks the async tick schedules. */
async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
  }
}

async function startConnect() {
  const { result } = renderHook(() => useOAuthConnect(WORKSPACE_ID), { wrapper })
  await act(async () => {
    await result.current.start(PROVIDER_ID)
  })
  return result
}

beforeEach(() => {
  vi.useFakeTimers()
  popup = new MockPopup()
  openSpy.mockImplementation(() => popup as unknown as Window)
  vi.stubGlobal('open', openSpy)
  mockedApi.startOAuthConnect.mockResolvedValue('https://provider.example/authorize?state=abc')
  mockedApi.fetchIntegrations.mockResolvedValue(pendingRow())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useOAuthConnect', () => {
  it('stops polling once the popup is closed, after at most one final refetch', async () => {
    await startConnect()

    await tick()
    expect(mockedApi.fetchIntegrations).toHaveBeenCalledTimes(1)

    popup.closed = true
    await tick()
    const callsAfterClose = mockedApi.fetchIntegrations.mock.calls.length
    expect(callsAfterClose).toBeLessThanOrEqual(2)

    await tick(5)
    expect(mockedApi.fetchIntegrations).toHaveBeenCalledTimes(callsAfterClose)
    expect(mockedHandleError).not.toHaveBeenCalled()
  })

  it('gives up and reports once after 3 consecutive poll failures', async () => {
    mockedApi.fetchIntegrations.mockRejectedValue(new Error('gateway down'))
    await startConnect()

    await tick(3)
    expect(mockedApi.fetchIntegrations).toHaveBeenCalledTimes(3)
    expect(mockedHandleError).toHaveBeenCalledTimes(1)
    expect(mockedHandleError).toHaveBeenCalledWith(expect.any(Error), {
      fallback: 'Lost contact with the gateway while connecting.',
    })

    await tick(5)
    expect(mockedApi.fetchIntegrations).toHaveBeenCalledTimes(3)
    expect(mockedHandleError).toHaveBeenCalledTimes(1)
  })

  it('tolerates a single transient poll failure', async () => {
    mockedApi.fetchIntegrations
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(pendingRow())
    await startConnect()

    await tick(4)
    expect(mockedApi.fetchIntegrations).toHaveBeenCalledTimes(4)
    expect(mockedHandleError).not.toHaveBeenCalled()
  })

  it('severs the popup opener reference after opening it', async () => {
    await startConnect()

    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(popup.opener).toBeNull()
  })

  it('refuses to open a non-http(s) authorization URL', async () => {
    mockedApi.startOAuthConnect.mockResolvedValue('javascript:alert(1)')
    const result = await startConnect()

    expect(openSpy).not.toHaveBeenCalled()
    expect(mockedHandleError).toHaveBeenCalledTimes(1)
    expect(mockedHandleError).toHaveBeenCalledWith(expect.any(Error), {
      fallback: 'Received an invalid connect URL.',
    })
    expect(result.current.connectingProviderId).toBeNull()

    await tick(2)
    expect(mockedApi.fetchIntegrations).not.toHaveBeenCalled()
  })
})
