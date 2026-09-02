import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { shouldRetryQuery } from '@/lib/query-client'

describe('shouldRetryQuery', () => {
  it('never retries a workspace_not_found 4xx, even on the first failure', () => {
    const err = new ApiError({ code: 'workspace_not_found', message: 'nope' })
    expect(shouldRetryQuery(0, err)).toBe(false)
  })

  it('never retries a workspace_not_ready 4xx, even on the first failure', () => {
    const err = new ApiError({ code: 'workspace_not_ready', message: 'nope' })
    expect(shouldRetryQuery(0, err)).toBe(false)
  })

  it('retries a network error exactly once', () => {
    const err = new ApiError({ code: 'network', message: 'down' })
    expect(shouldRetryQuery(0, err)).toBe(true)
    expect(shouldRetryQuery(1, err)).toBe(false)
  })

  it('retries an invalid_response error exactly once', () => {
    const err = new ApiError({ code: 'invalid_response', message: 'bad' })
    expect(shouldRetryQuery(0, err)).toBe(true)
    expect(shouldRetryQuery(1, err)).toBe(false)
  })

  it('gives a non-ApiError throwable its one retry too', () => {
    const err = new Error('boom')
    expect(shouldRetryQuery(0, err)).toBe(true)
    expect(shouldRetryQuery(1, err)).toBe(false)
  })
})
