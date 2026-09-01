import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark'
import { ThemeSwitch } from '@/features/theme/theme-switch'
import { cn } from '@/lib/utils'

type ConsoleShellProps = {
  title: string
  children: ReactNode
  aside?: ReactNode
  actions?: ReactNode
  /** Drive-style wide canvas vs a centered setup card. */
  layout?: 'wide' | 'narrow'
}

/**
 * Product chrome for workspaces + onboarding (Google Drive / console).
 * Threads 3-column chrome lives in ChatShell, used only by per-workspace chat.
 */
export function ConsoleShell({
  title,
  children,
  aside,
  actions,
  layout = 'wide',
}: ConsoleShellProps) {
  const narrow = layout === 'narrow'

  return (
    <div data-surface="console" className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-background px-4">
        <BrandMark />
        <span className="text-muted-foreground" aria-hidden="true">
          /
        </span>
        <h1 className="truncate text-sm font-medium">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <ThemeSwitch />
        </div>
      </header>
      <div
        className={cn(
          'mx-auto flex gap-6 px-4 py-6',
          narrow ? 'max-w-lg flex-col' : 'max-w-[1200px]',
        )}
      >
        <main className="min-w-0 flex-1">{children}</main>
        {aside && !narrow ? (
          <aside className="hidden w-72 shrink-0 xl:block">{aside}</aside>
        ) : null}
      </div>
      {narrow ? (
        <p className="px-4 pb-8 text-center text-xs text-muted-foreground">
          <Link to="/" className="text-foreground underline-offset-4 hover:underline">
            Back to workspaces
          </Link>
        </p>
      ) : null}
    </div>
  )
}
