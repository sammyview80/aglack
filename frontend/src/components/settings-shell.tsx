import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Puzzle, Settings2 } from 'lucide-react'
import { ThemeSwitch } from '@/features/theme/theme-switch'
import { cn } from '@/lib/utils'

export type SettingsNavItem = {
  id: string
  label: string
  icon: ReactNode
}

const NAV_ITEMS: SettingsNavItem[] = [
  { id: 'plugins', label: 'Plugins', icon: <Puzzle size={16} /> },
  { id: 'general', label: 'General', icon: <Settings2 size={16} /> },
]

type SettingsShellProps = {
  workspaceId: string
  workspaceName: string
  activeNav?: string
  title: string
  meta?: string
  children: ReactNode
}

export function SettingsShell({
  workspaceId,
  workspaceName,
  activeNav = 'plugins',
  title,
  meta,
  children,
}: SettingsShellProps) {
  const navigate = useNavigate()

  return (
    <div className="settings-shell threads-app flex h-dvh min-h-dvh items-stretch overflow-hidden bg-[var(--th-backdrop)] p-0">
      <div className="settings-window flex h-full w-full min-h-0 overflow-hidden rounded-[21px] border border-[var(--th-window-border)] bg-[var(--th-content)] shadow-[0_28px_70px_#0a011859,0_3px_12px_#1106223d] max-[760px]:rounded-none max-[760px]:border-0">

        {/* Left sidebar */}
        <aside className="settings-sidebar flex w-[220px] min-w-[220px] flex-col border-r border-[var(--th-sidebar-line)] bg-[var(--th-sidebar)] px-3 pb-6 pt-5 max-[760px]:hidden">
          {/* Back button */}
          <button
            type="button"
            className="settings-back mb-6 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--th-muted)] transition-colors hover:bg-[var(--th-hover)] hover:text-[var(--th-text)]"
            onClick={() => navigate(`/workspaces/${workspaceId}/chat`, { state: { name: workspaceName } })}
          >
            <ChevronLeft size={15} strokeWidth={2.5} />
            {workspaceName}
          </button>

          {/* Section label */}
          <p className="mb-2 px-2 text-[10.5px] font-[750] uppercase tracking-[1.2px] text-[var(--th-muted)]">
            Settings
          </p>

          {/* Nav items */}
          <nav className="flex flex-col gap-0.5">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-[560] text-[var(--th-text)] transition-colors hover:bg-[var(--th-hover)]',
                  activeNav === item.id && 'bg-[var(--th-selected)] font-semibold',
                )}
              >
                <span className="text-[var(--th-muted)]">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <div className="mt-auto">
            <ThemeSwitch />
          </div>
        </aside>

        {/* Content */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* Top bar */}
          <header className="flex h-[57px] shrink-0 items-center gap-3 border-b border-[var(--th-header-line)] px-8 max-[760px]:px-4">
            <button
              type="button"
              className="mr-1 hidden items-center gap-1.5 text-[13px] font-medium text-[var(--th-muted)] hover:text-[var(--th-text)] max-[760px]:flex"
              onClick={() => navigate(`/workspaces/${workspaceId}/chat`, { state: { name: workspaceName } })}
            >
              <ChevronLeft size={15} strokeWidth={2.5} />
            </button>
            <div className="flex flex-col">
              <h1 className="text-[15px] font-bold tracking-[-0.3px] text-[var(--th-text)]">{title}</h1>
              {meta ? <p className="text-[11.5px] text-[var(--th-muted)]">{meta}</p> : null}
            </div>
          </header>

          {/* Scrollable content */}
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6 max-[760px]:px-4 max-[760px]:py-4">
            <div className="mx-auto w-full max-w-[1100px]">
              {children}
            </div>
          </div>
        </main>

      </div>
    </div>
  )
}
