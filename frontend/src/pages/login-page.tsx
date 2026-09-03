import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { BrandLogo } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusAlert } from '@/components/status-alert'
import { login } from '@/features/auth/api'
import { errorMessage } from '@/lib/api'

/**
 * The gateway's own admin login (see `rust_gateway/src/auth/`) — one
 * deployment-wide password, not a per-user account (that's Phase 0b,
 * separate later work per docs/integrations-plan.md). `apiFetch`
 * (lib/api.ts) redirects here automatically on any `not_authenticated`
 * response, so this page has no route guard of its own to duplicate —
 * landing here IS the guard.
 */
export function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(password)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from || '/', { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'Could not log in.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-3">
          <BrandLogo size="size-10" circle />
          <h1 className="text-lg font-medium">Sign in</h1>
        </div>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {error && <StatusAlert message={error} />}
          <Button type="submit" disabled={submitting || !password} className="w-full">
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}
