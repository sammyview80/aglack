/**
 * Client for rust_gateway's Google login (see `rust_gateway/src/auth/`).
 * Envelope responses go through `apiFetch`, same as every other gateway
 * route. The session itself lives in an `HttpOnly` cookie the browser
 * manages automatically once `credentials: 'include'` is set (see
 * `lib/api.ts`) — this module never reads or stores the session token
 * itself.
 */
import { apiFetch } from '@/lib/api'
import { gatewayUrl } from '@/lib/env'

export function googleLoginUrl(): string {
  return `${gatewayUrl()}/auth/google`
}

export async function logout(): Promise<void> {
  await apiFetch(gatewayUrl(), '/auth/logout', { method: 'POST' })
}

export async function checkSession(): Promise<boolean> {
  try {
    await apiFetch(gatewayUrl(), '/auth/me')
    return true
  } catch {
    return false
  }
}
