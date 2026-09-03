import type { ReactNode } from 'react'
import { BrandMark } from '@/components/brand-mark'
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
      <BrandMark />
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
        <aside className="hidden h-full min-h-0 flex-col bg-muted lg:flex" aria-hidden="true">
          {/* Spacer mirroring BrandHeader (px-6 py-4 + size-8 mark) so the preview centers on the form area. */}
          <div className="shrink-0 px-6 py-4">
            <div className="size-8" />
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <img
              src="/onboarding-preview.png"
              alt=""
              className="h-auto w-full max-h-[92vh] rounded-xl object-contain object-center shadow-lg"
            />
          </div>
        </aside>
      </div>
    </Window>
  )
}
