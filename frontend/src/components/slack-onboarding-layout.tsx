import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ThemeSwitch } from '@/features/theme/theme-switch'
import { cn } from '@/lib/utils'

type SlackOnboardingLayoutProps = {
  step?: number
  total?: number
  title?: string
  workspaceName?: string
  workspaceId?: string
  preview?: ReactNode
  split?: boolean
  children: ReactNode
  busy?: boolean
}

function BrandHeader() {
  return (
    <header className="flex items-center justify-between px-6 py-4">
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-semibold text-foreground no-underline"
      >
        <span
          className="grid size-8 place-items-center rounded-lg bg-foreground text-xs font-bold text-background"
          aria-hidden="true"
        >
          H
        </span>
        Hermes
      </Link>
      <ThemeSwitch />
    </header>
  )
}

function FormPane({
  step,
  total,
  busy,
  children,
}: {
  step?: number
  total: number
  busy: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-center justify-center overflow-auto px-6 py-10',
        busy && 'pointer-events-none opacity-60',
      )}
    >
      {step != null ? (
        <p className="mb-3 text-center text-xs tracking-wide text-muted-foreground">
          Step {step} of {total}
        </p>
      ) : null}
      <div className="app-page-card w-full max-w-xl">{children}</div>
    </div>
  )
}

function Window({ children }: { children: ReactNode }) {
  return (
    <div className="app-page-shell">
      <div className="app-page-window">{children}</div>
    </div>
  )
}

/** Standalone themed page. Half-split: form left, preview right. `split={false}` opts out. */
export function SlackOnboardingLayout({
  step,
  total = 4,
  split = true,
  children,
  busy = false,
}: SlackOnboardingLayoutProps) {
  if (!split) {
    return (
      <Window>
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
          <BrandHeader />
          <FormPane step={step} total={total} busy={busy}>
            {children}
          </FormPane>
        </div>
      </Window>
    )
  }

  return (
    <Window>
      <div className="grid h-full min-h-0 grid-cols-1 bg-background text-foreground lg:grid-cols-2">
        <div className="flex h-full min-h-0 flex-col">
          <BrandHeader />
          <FormPane step={step} total={total} busy={busy}>
            {children}
          </FormPane>
        </div>
        <aside
          className="hidden items-center justify-center bg-muted p-6 lg:flex"
          aria-hidden="true"
        >
          <img
            src="/onboarding-preview.png"
            alt=""
            className="h-auto w-full max-h-[92vh] rounded-xl object-contain object-center shadow-lg"
          />
        </aside>
      </div>
    </Window>
  )
}
