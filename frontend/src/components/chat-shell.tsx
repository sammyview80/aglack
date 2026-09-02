import type { ReactNode } from 'react'
import { Home, MessageCircle, Moon, Sun } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark'
import { useColorTheme } from '@/features/theme/color-theme'
import { cn } from '@/lib/utils'

type ChatShellProps = {
  title: string
  workspaceId: string
  children: ReactNode
  aside?: ReactNode
}

const NAV_ITEM =
  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] text-foreground transition-colors hover:bg-muted'

/**
 * Threads chrome: left rail, center column, right rail.
 * Only for per-workspace chat — console screens use ConsoleShell.
 */
export function ChatShell({ title, workspaceId, children, aside }: ChatShellProps) {
  const location = useLocation()
  const { theme, toggleTheme } = useColorTheme()
  const chatHref = `/workspaces/${workspaceId}/chat`
  const onChat = location.pathname === chatHref

  return (
    <div data-surface="threads" className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh max-w-[1120px]">
        <nav
          className="sticky top-0 hidden h-dvh w-[76px] shrink-0 flex-col gap-1 px-2 py-4 sm:flex lg:w-[244px] lg:px-3"
          aria-label="Chat"
        >
          <div className="mb-3 px-2">
            <BrandMark compact circle />
          </div>
          <NavLink to="/" className={NAV_ITEM}>
            <Home className="size-6" />
            <span className="hidden lg:inline">Workspaces</span>
          </NavLink>
          <NavLink
            to={chatHref}
            className={cn(NAV_ITEM, onChat && 'font-bold')}
            aria-current={onChat ? 'page' : undefined}
          >
            <MessageCircle className={cn('size-6', onChat && 'fill-foreground')} />
            <span className="hidden lg:inline">Chat</span>
          </NavLink>
          <div className="mt-auto">
            <button
              type="button"
              className={cn(NAV_ITEM, 'w-full cursor-pointer border-0 bg-transparent text-left')}
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <Sun className="size-6" /> : <Moon className="size-6" />}
              <span className="hidden lg:inline">More</span>
            </button>
          </div>
        </nav>

        <main className="flex min-h-dvh min-w-0 flex-1 flex-col border-x border-border pb-16 sm:pb-0">
          <header className="sticky top-0 z-10 border-b border-border bg-background/85 px-4 py-3.5 backdrop-blur-md">
            <h1 className="text-[17px] font-bold tracking-tight">{title}</h1>
          </header>
          {children}
        </main>

        <aside className="sticky top-0 hidden h-dvh w-[320px] shrink-0 overflow-auto px-4 py-4 xl:block">
          {aside ?? (
            <div className="rounded-2xl bg-muted p-4">
              <p className="text-[15px] font-bold">Aglack</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Aglack is a platform for creating and managing your own AI agents.
              </p>
            </div>
          )}
        </aside>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-background sm:hidden"
        aria-label="Chat"
      >
        <NavLink to="/" className="flex flex-1 items-center justify-center py-3" aria-label="Workspaces">
          <Home className="size-6" />
        </NavLink>
        <NavLink
          to={chatHref}
          className={cn('flex flex-1 items-center justify-center py-3', onChat && 'font-bold')}
          aria-label="Chat"
        >
          <MessageCircle className={cn('size-6', onChat && 'fill-foreground')} />
        </NavLink>
        <button
          type="button"
          className="flex flex-1 cursor-pointer items-center justify-center border-0 bg-transparent py-3"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun className="size-6" /> : <Moon className="size-6" />}
        </button>
      </nav>
    </div>
  )
}
