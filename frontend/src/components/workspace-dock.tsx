import { Home, Plug, History, Monitor, Moon, Sun, Plus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Hint } from '@/components/ui/tooltip'
import { useColorTheme } from '@/features/theme/color-theme'
import { cn } from '@/lib/utils'

type WorkspaceDockProps = {
  workspaceId?: string
  workspaceName: string
  /** Omit entirely on pages that don't have an AUDIENCE panel at all
   * (mirrors ThreadsShell's own `hideAudiencePanel` prop) — same rule as
   * the navbar's own agent-history toggle button. */
  hideAudiencePanel?: boolean
  audiencePanelOpen?: boolean
  onToggleAudiencePanel?: () => void
  desktopPanelOpen?: boolean
  onToggleDesktopPanel?: () => void
  mobileOnly?: boolean
}

/** Floating bottom dock: quick nav to what actually exists today (chat,
 * integrations, agent history, live desktop, theme) plus a
 * create-workspace shortcut. Purely additive — sits on top of
 * ThreadsShell's existing rail/navbar, doesn't replace either. Every
 * button here is a shortcut to a feature the navbar/rail already expose
 * elsewhere — no new capability, no Settings/Billing icon (those pages
 * don't exist yet; see AGENTS.md's routing notes).
 *
 * Theming: uses the app's --th-* tokens (see globals.css) so the pill
 * flips light/dark with the rest of the app instead of being hardcoded
 * dark like a native OS dock.
 *
 * Positioning: bottom-6 with z-10 (below the integrations dialog's z-20
 * backdrop/z-30 popup, so an open modal always visually and functionally
 * sits above the dock — no modality escape). The chat composer reserves
 * matching bottom padding via chatUi.composer so the dock never overlaps
 * the send button or the scroll-to-bottom FAB. */
export function WorkspaceDock({
  workspaceId,
  workspaceName,
  hideAudiencePanel = false,
  audiencePanelOpen = false,
  onToggleAudiencePanel,
  desktopPanelOpen = false,
  onToggleDesktopPanel,
  mobileOnly = false,
}: WorkspaceDockProps) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { theme, toggleTheme } = useColorTheme()
  const dark = theme === 'dark'

  const active: 'home' | 'integrations' | null = workspaceId
    ? pathname === `/workspaces/${workspaceId}/chat`
      ? 'home'
      : pathname === `/workspaces/${workspaceId}/integrations`
        ? 'integrations'
        : null
    : null

  const disabled = !workspaceId
  const iconBtn =
    'grid size-11 place-items-center rounded-full text-[var(--th-dock-icon)] transition-colors duration-150 hover:bg-[var(--th-dock-hover)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent'
  const iconBtnActive = 'bg-[var(--th-compose)] text-white hover:bg-[var(--th-compose)]'

  return (
    <div className={cn(
      'pointer-events-none fixed inset-x-0 bottom-10 z-10 flex items-center justify-center gap-2.5 max-[760px]:bottom-[max(8px,env(safe-area-inset-bottom))]',
      mobileOnly && 'max-[760px]:flex min-[761px]:hidden',
    )}>
      {/* Dark theme needs its own border + lighter shadow — a black
          shadow is invisible against the app's true-black canvas, and a
          1px ring alone doesn't read as a boundary either. */}
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-transparent bg-[var(--th-dock)] p-1.5 shadow-[0_12px_32px_#00000059,0_0_0_1px_var(--th-dock-ring)] dark:border-[#333333] dark:shadow-[0_12px_32px_#00000080,0_0_0_1px_var(--th-dock-ring)]">
        <Hint label="Home" side="top">
          <button
            type="button"
            aria-label="Home"
            aria-current={active === 'home' ? 'page' : undefined}
            disabled={disabled}
            onClick={() =>
              workspaceId && navigate(`/workspaces/${workspaceId}/chat`, { state: { name: workspaceName } })
            }
            className={cn(iconBtn, active === 'home' && iconBtnActive)}
          >
            <Home size={19} strokeWidth={2.2} />
          </button>
        </Hint>
        <Hint label="Integrations" side="top">
          <button
            type="button"
            aria-label="Integrations"
            aria-current={active === 'integrations' ? 'page' : undefined}
            disabled={disabled}
            onClick={() =>
              workspaceId && navigate(`/workspaces/${workspaceId}/integrations`, { state: { name: workspaceName } })
            }
            className={cn(iconBtn, active === 'integrations' && iconBtnActive)}
          >
            <Plug size={19} strokeWidth={2.2} />
          </button>
        </Hint>
        {!hideAudiencePanel ? (
          <Hint label="Agent history" side="top">
            <button
              type="button"
              aria-label="Toggle agent history"
              aria-pressed={audiencePanelOpen}
              onClick={onToggleAudiencePanel}
              className={cn(iconBtn, audiencePanelOpen && iconBtnActive)}
            >
              <History size={19} strokeWidth={2.2} />
            </button>
          </Hint>
        ) : null}
        {workspaceId ? (
          <Hint label={desktopPanelOpen ? 'Hide desktop' : 'Show desktop'} side="top">
            <button
              type="button"
              aria-label={desktopPanelOpen ? 'Hide desktop' : 'Show desktop'}
              aria-pressed={desktopPanelOpen}
              onClick={onToggleDesktopPanel}
              className={cn(iconBtn, desktopPanelOpen && iconBtnActive)}
            >
              <Monitor size={19} strokeWidth={2.2} />
            </button>
          </Hint>
        ) : null}
        <Hint label={dark ? 'Switch to light theme' : 'Switch to dark theme'} side="top">
          <button
            type="button"
            role="switch"
            aria-checked={dark}
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggleTheme}
            className={iconBtn}
          >
            {dark ? <Sun size={19} strokeWidth={2.2} /> : <Moon size={19} strokeWidth={2.2} />}
          </button>
        </Hint>
      </div>
      <Hint label="Create workspace" side="top">
        <button
          type="button"
          aria-label="Create workspace"
          onClick={() => navigate('/create')}
          className="pointer-events-auto grid size-11 place-items-center rounded-full border-2 border-[var(--th-dock)] bg-[var(--th-dock-fg)] text-[var(--th-dock)] shadow-[0_12px_32px_#00000059] transition-transform duration-150 hover:scale-105"
        >
          <Plus size={20} strokeWidth={2.4} />
        </button>
      </Hint>
    </div>
  )
}
