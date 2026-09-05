import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchIntegrations } from '@/features/integrations/api'

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response
}

beforeEach(() => {
  vi.stubEnv('VITE_GATEWAY_URL', 'http://localhost:8080')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('fetchIntegrations', () => {
  it('uses the API namespace instead of the colliding SPA page URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: [
          {
            provider_id: 'github',
            status: 'connected',
            account_label: 'sammyview80',
            last_error: null,
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchIntegrations('workspace-1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://localhost:8080/api/workspaces/workspace-1/integrations',
    )
    expect(result).toEqual([
      {
        providerId: 'github',
        status: 'connected',
        accountLabel: 'sammyview80',
        lastError: null,
      },
    ])
  })
})
