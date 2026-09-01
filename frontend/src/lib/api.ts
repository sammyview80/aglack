/**
 * Generic client for rust_gateway's shared JSON envelope (see
 * rust_gateway/src/response.rs — the authoritative shape):
 *   success: { ok: true, data: T }
 *   error:   { ok: false, error: { code: string, message: string } }
 *
 * Every endpoint that returns this envelope should call `apiFetch` rather
 * than parsing `fetch` responses by hand, so error handling (and its
 * shape) stays in exactly one place instead of being reinvented per
 * feature. `proxy::forward`-relayed responses (arbitrary upstream bodies,
 * not this gateway's own JSON) are NOT this envelope — don't route those
 * through this helper.
 */

export type ApiErrorPayload = {
  code: string
  message: string
}

/** Thrown by `apiFetch` for both HTTP-level failures and `{ ok: false }`
 * envelope responses. `code` lets callers branch on a stable machine
 * string (e.g. `'workspace_name_taken'`) instead of matching on
 * `message`, which is human-readable and may change wording. */
export class ApiError extends Error {
  code: string

  constructor(payload: ApiErrorPayload) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
  }
}

type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiErrorPayload }

/**
 * Fetch `path` against `baseUrl`, parse the shared envelope, and either
 * return `data` (success) or throw `ApiError` (failure — including a
 * response body that isn't valid JSON, or doesn't match the envelope
 * shape, which is reported as `code: 'invalid_response'` rather than
 * surfacing a raw parse exception to the caller).
 */
export async function apiFetch<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError({
      code: 'network',
      message: 'Cannot reach the gateway. Is rust_gateway running?',
    })
  }

  let body: ApiEnvelope<T> | undefined
  try {
    body = await res.json()
  } catch {
    body = undefined
  }

  if (!body || typeof body.ok !== 'boolean') {
    throw new ApiError({
      code: 'invalid_response',
      message: unexpectedResponseMessage(res.status),
    })
  }

  if (!body.ok) {
    throw new ApiError(body.error)
  }

  return body.data
}

function unexpectedResponseMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return `The workspace is not answering yet (HTTP ${status}). It may still be starting — wait a few seconds and retry.`
  }
  if (status === 500) {
    return 'The workspace hit an internal error (HTTP 500). Retry in a moment. If it keeps failing, check the container logs.'
  }
  if (status === 404) {
    return 'Nothing answered at that URL (HTTP 404). The workspace may have been deleted.'
  }
  if (status === 401 || status === 403) {
    return `Access was denied (HTTP ${status}).`
  }
  return `Couldn't read the server response (HTTP ${status}). Check that the gateway and workspace container are running, then retry.`
}

/**
 * One place every page/component resolves a caught error to a displayable
 * string, instead of each call site repeating its own
 * `err instanceof Error ? err.message : '...'` ternary. Per-code
 * overrides go in `messagesByCode` (e.g. a friendlier string than the
 * server's raw `message` for a specific, expected `ApiError.code`); any
 * other `ApiError` falls back to its own `message`; anything that isn't
 * an `Error` at all falls back to `fallback`.
 */
export function errorMessage(
  err: unknown,
  fallback = 'Something went wrong',
  messagesByCode: Record<string, string> = {},
): string {
  if (err instanceof ApiError && messagesByCode[err.code]) {
    return messagesByCode[err.code]
  }
  if (err instanceof Error) {
    return err.message
  }
  return fallback
}
