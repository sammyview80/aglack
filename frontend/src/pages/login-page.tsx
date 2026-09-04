import { BrandLogo } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { googleLoginUrl } from '@/features/auth/api'

/**
 * Google login for the gateway. `apiFetch`
 * (lib/api.ts) redirects here automatically on any `not_authenticated`
 * response, so this page has no route guard of its own to duplicate —
 * landing here IS the guard.
 */
export function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 max-[760px]:items-start max-[760px]:px-5 max-[760px]:pb-[max(20px,env(safe-area-inset-bottom))] max-[760px]:pt-[max(32px,env(safe-area-inset-top))]">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm max-[760px]:border-0 max-[760px]:bg-transparent max-[760px]:p-0 max-[760px]:shadow-none">
        <div className="mb-6 flex flex-col items-center gap-3">
          <BrandLogo size="size-10" circle />
          <h1 className="text-lg font-medium">Sign in</h1>
        </div>
        <Button
          type="button"
          className="w-full"
          onClick={() => window.location.assign(googleLoginUrl())}
        >
          Continue with Google
        </Button>
      </div>
    </div>
  )
}
