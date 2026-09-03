import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import {
  Bell,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  Ellipsis,
  ExternalLink,
  FileText,
  History,
  Maximize2,
  Monitor,
  Pencil,
  Plus,
  Compass,
  Search,
  Send,
  Settings2,
  SmilePlus,
  X,
  Zap,
} from 'lucide-react'
import { Dialog } from '@base-ui/react/dialog'
import { useNavigate } from 'react-router-dom'
import { ThemeSwitch } from '@/features/theme/theme-switch'
import { Hint, TooltipProvider } from '@/components/ui/tooltip'
import { BrandLogo } from '@/components/brand-mark'
import { cn } from '@/lib/utils'
import { useWorkspaceList } from '@/features/workspace/hooks/use-workspace-list'
import { AgentHistoryPanel } from '@/features/agent-history/components/agent-history-panel'
import { useAgents } from '@/features/agent-history/hooks/use-agent-history'
import { RandomAvatar } from '@/components/random-avatar'
import { PulseDot, motionPresets } from '@/components/motion'
import { avatarToneStyles, threadsUi, type AvatarTone } from '@/components/threads-ui'
import { chatUi } from '@/features/chat/chat-ui'
import { desktopUrl } from '@/features/workspace/api'
import { WorkspaceDock } from '@/components/workspace-dock'
import type { AgentSession } from '@/features/agent-history/types'

export type { AvatarTone }

export type ThreadsWorkspaceIcon = {
  id: string
  label: string
}

type ThreadsShellProps = {
  workspaceId?: string
  workspaceName: string
  title: string
  alignCenter?: boolean
  /** When true the AUDIENCE panel (agent history) and its toggle button are
   * not rendered at all. Use on settings/integrations pages. */
  hideAudiencePanel?: boolean
  /** When true, WorkspaceDock (the floating bottom nav pill) is not
   * rendered at all. Use on the chat screen — its composer already has an
   * always-visible input at the bottom; a second floating element there
   * competes with it instead of adding value. */
  hideDock?: boolean
  onCompose?: () => void
  onPublish?: (text: string) => void
  search?: string
  onSearchChange?: (value: string) => void
  /** Forwarded straight to AgentHistoryPanel — lets whatever renders as
   * `children` (e.g. the real chat pane) load a clicked AUDIENCE session
   * as a live, sendable conversation. Optional: omitting it keeps the
   * panel's own read-only session viewer as the only effect of a click. */
  onSelectSession?: (agentName: string, session: AgentSession) => void
  /** Optional external control of which agent's history is shown (the
   * CHAT sidebar list + AUDIENCE panel) — same externally-controlled
   * pattern AgentHistoryPanel itself already uses. Wire this to whatever
   * owns the real chat pane's agent selection (e.g. its URL `?agent=`
   * param) so clicking an agent in the sidebar ALSO switches the actual
   * chat, not only the AUDIENCE panel's own selection. Omit both props to
   * keep this shell's original self-contained (URL-unaware) behavior. */
  selectedAgent?: string | null
  onSelectAgent?: (name: string) => void
  children: ReactNode
}

const TONES = ['gold', 'lavender', 'aqua', 'pink', 'blue', 'gray'] as const

const THREAD_SECTIONS = new Set(['Inbox', 'Thread', 'Setup', 'Plugins'])

type GuildEntry = { id: string; name: string; mark: string }

function paneCopy(section: string): string {
  if (section === 'Drafts') return 'No drafts yet. Compose a thread to get started.'
  if (section === 'Settings') return 'Workspace settings stay on this page until a settings API exists.'
  if (section === 'Help') return 'Search the thread or compose a message. Inbox keeps your open threads.'
  if (section === 'Activity') return 'You are all caught up. New replies will show up here.'
  return `This is a placeholder view for ${section}.`
}

export function pixelHue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 360
}

export function avatarTone(seed: string): AvatarTone {
  return TONES[pixelHue(seed) % TONES.length]
}

/** CSS character avatar from the Bolt Threads design. */
export function PixelAvatar({
  seed,
  small,
  className,
  tone,
}: {
  seed: string
  size?: number
  small?: boolean
  className?: string
  tone?: AvatarTone
}) {
  const colors = avatarToneStyles[tone ?? avatarTone(seed)]

  return (
    <span
      className={cn(threadsUi.avatar, colors.shell, small && threadsUi.avatarSmall, className)}
      aria-hidden="true"
    >
      <span className={cn(threadsUi.avatarHair, small && threadsUi.avatarHairSmall, colors.hair)} />
      <span className={cn(threadsUi.avatarFace, small && threadsUi.avatarFaceSmall, colors.face)}>✦</span>
      <span className={cn(threadsUi.avatarBody, small && threadsUi.avatarBodySmall, colors.body)} />
    </span>
  )
}

export function ThreadsShell({
  workspaceId,
  workspaceName,
  title,
  alignCenter = false,
  hideAudiencePanel = false,
  hideDock = false,
  onCompose,
  onPublish,
  search,
  onSearchChange,
  onSelectSession,
  selectedAgent: selectedAgentProp,
  onSelectAgent,
  children,
}: ThreadsShellProps) {
  const navigate = useNavigate()
  const [section, setSection] = useState(title === 'Thread' ? 'Inbox' : title)
  const heading = section === 'Inbox' ? workspaceName.trim() || 'Workspace' : section
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [composeEmoji, setComposeEmoji] = useState(false)
  const [headerMore, setHeaderMore] = useState(false)
  const [audiencePanelOpen, setAudiencePanelOpen] = useState(false)
  // Static now — its only setter was the removed CHANNELS section's
  // per-channel click handlers (setAudience(channel.label...)); with that
  // fake/placeholder channel list gone, there's no real signal left to
  // drive this compose-modal "in {audience}" label. Left as the prior
  // default rather than guessing new semantics — worth a real design
  // decision (e.g. drop the "in ..." line, or wire it to the current
  // agent/thread) as a follow-up, not silently invented here.
  const audience = 'DESIGN-WWW'
  // Replaces the ENTIRE content area (where chat/thread normally renders)
  // with a full, embedded live desktop (webtop/KasmVNC) for this
  // workspace — no AUDIENCE/history panel, no sidebar change. Independent
  // of `section`/`audiencePanelOpen`. Reset on workspace switch, same as
  // `historyAgentState` above — a desktop view open for workspace A is
  // meaningless once the shell is showing workspace B.
  const [desktopPanelOpen, setDesktopPanelOpen] = useState(false)
  useEffect(() => {
    setDesktopPanelOpen(false)
  }, [workspaceId])

  useEffect(() => {
    if (!audiencePanelOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAudiencePanelOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [audiencePanelOpen])

  // Below 1120px the audience panel is a drawer (display:none until opened);
  // above it, the panel is always visible in the three-column layout, so
  // treat that width as "open" without requiring a click.
  const [isAudienceDesktop, setIsAudienceDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1121px)').matches,
  )
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1121px)')
    const onChange = () => setIsAudienceDesktop(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  const audienceVisible = isAudienceDesktop || audiencePanelOpen
  const [query, setQuery] = useState(search ?? '')

  // Real agents for the CHAT sidebar section. Deliberate scope extension of
  // the agent-history "fetch only while the panel is open" gate: the sidebar
  // IS an agent-history consumer on this same screen, so the agents query is
  // enabled whenever the shell is mounted. Sessions/messages stay gated on
  // the AUDIENCE panel being open (inside AgentHistoryPanel).
  const agentsQuery = useAgents(workspaceId, true)
  const sidebarAgents = agentsQuery.data?.agents ?? []
  // Which agent's history is shown in the AUDIENCE panel; the sidebar and
  // the panel share this selection. Externally controlled when the
  // caller passes `selectedAgent` (e.g. WorkspaceChat, keyed off its own
  // URL `?agent=` param) — same pattern AgentHistoryPanel itself already
  // uses for its own external-selection prop.
  const [historyAgentState, setHistoryAgentState] = useState<string | null>(null)
  const historyAgent = selectedAgentProp !== undefined ? selectedAgentProp : historyAgentState
  // A selection is only meaningful within one workspace — switching
  // workspaces must not query the previous workspace's agent name. Only
  // resets the INTERNAL fallback state; an externally-controlled
  // selection is the caller's own responsibility to reset (it already
  // does this for its own reasons, e.g. WorkspaceChat's URL params reset
  // naturally on navigation).
  useEffect(() => {
    setHistoryAgentState(null)
  }, [workspaceId])

  useEffect(() => {
    if (search !== undefined) setQuery(search)
  }, [search])

  const showThread = alignCenter || THREAD_SECTIONS.has(section)

  function updateSearch(value: string) {
    setQuery(value)
    onSearchChange?.(value)
  }

  function openSection(next: string) {
    setSection(next)
    setHeaderMore(false)
  }

  function openCompose() {
    setComposeOpen(true)
    setComposeEmoji(false)
    onCompose?.()
  }

  function publish() {
    const text = composeText.trim()
    if (!text) return
    onPublish?.(text)
    setComposeText('')
    setComposeOpen(false)
    openSection('Inbox')
  }

  function selectAgentHistory(name: string) {
    setHistoryAgentFromPanel(name)
    // Below the three-column breakpoint the AUDIENCE panel is a drawer —
    // open it so the click actually shows the agent's history.
    if (!isAudienceDesktop) setAudiencePanelOpen(true)
    // Picking an agent from history is an explicit "show history" action —
    // drop out of desktop mode so the panel actually displays what was
    // just clicked instead of staying on the desktop thumbnail.
    setDesktopPanelOpen(false)
  }

  /** Toggles the AUDIENCE panel's desktop-preview mode (see `DesktopPreview`
   * below) — same panel slot `selectAgentHistory` uses for history, just a
   * different mode flag on the same right-hand panel instead of a second
   * panel. Below the three-column breakpoint this also has to force the
   * panel open, same reasoning as `selectAgentHistory`. */
  function openDesktopPanel() {
    setDesktopPanelOpen((v) => {
      const next = !v
      // Only force the mobile drawer open when actually turning desktop ON —
      // closing it must not re-open the drawer out from under the user.
      if (next && !isAudienceDesktop) setAudiencePanelOpen(true)
      return next
    })
  }

  // Shared by the sidebar's own click handler above and
  // AgentHistoryPanel's `onSelectedAgentChange` (fired by ITS internal
  // navigation, e.g. its close/back button clearing back to `null`) — both
  // are "the agent selection changed" from this shell's point of view, and
  // both must update the internal fallback state AND report outward the
  // same way, so the real chat pane (via `onSelectAgent`) stays in sync
  // with EITHER path a user takes to change agents, not only the sidebar.
  //
  // When `selectedAgent` is externally controlled (WorkspaceChat's URL
  // `?agent=`), clicking the panel's own close/back button to `null` is
  // intentionally NOT what clears the chat's agent — `historyAgent` is
  // derived from the prop, so the panel snaps right back open on the
  // very next render showing that same URL-bound agent. This is
  // deliberate: collapsing a side panel is not the same action as
  // navigating the actual chat away from an agent, and the whole point
  // of this wiring is that AUDIENCE always mirrors whichever agent the
  // real chat is actually on.
  function setHistoryAgentFromPanel(name: string | null) {
    setHistoryAgentState(name)
    if (name) onSelectAgent?.(name)
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
    } catch {
      /* clipboard can fail in non-secure contexts */
    }
    setHeaderMore(false)
  }

  return (
    <TooltipProvider delay={200}>
    <main className={threadsUi.root} data-workspace={workspaceId || workspaceName}>
      {/* The right-hand panel column normally only exists on chat pages
          (AUDIENCE/history). Desktop is universal — every page can open it —
          so a hideAudiencePanel page (Integrations/Settings) must still gain
          that 4th column whenever desktopPanelOpen is true, even though it
          has no AUDIENCE panel of its own. */}
      <div className={cn(threadsUi.appWindow, hideAudiencePanel && !desktopPanelOpen && 'grid-cols-[72px_317px_minmax(560px,1fr)] max-[1120px]:grid-cols-[72px_250px_minmax(500px,1fr)]')}>
        <header className={threadsUi.navbar}>
          <div className={threadsUi.navbarBrand}>
            <button type="button" className={threadsUi.navbarHome} onClick={() => navigate('/')}>
              <div className={threadsUi.workspaceMark}>
                <span>▪▪</span>
                <span>▪▪</span>
              </div>
              <strong>{workspaceName.trim() || 'Workspace'}</strong>
              <ChevronDown size={15} strokeWidth={2.5} />
            </button>
            <button
              type="button"
              className={cn(threadsUi.iconButton, threadsUi.topAction)}
              aria-label="Activity"
              onClick={() => openSection('Activity')}
            >
              <History size={21} />
            </button>
            <button type="button" className={threadsUi.iconButton} aria-label="Quick actions" onClick={openCompose}>
              <Zap size={21} />
            </button>
          </div>

          <div className={threadsUi.navbarActions}>
            <button
              type="button"
              className={threadsUi.iconButton}
              aria-label="Notifications"
              onClick={() => openSection('Activity')}
            >
              <Bell size={19} />
            </button>
            <button
              type="button"
              className={threadsUi.iconButton}
              aria-label="More"
              onClick={() => setHeaderMore((v) => !v)}
            >
              <Ellipsis size={22} />
            </button>
            <label className={threadsUi.searchBox}>
              <Search size={17} />
              <input
                value={query}
                onChange={(e) => updateSearch(e.target.value)}
                placeholder="Search"
                aria-label="Search"
              />
            </label>
            <button type="button" className={threadsUi.iconButton} aria-label="Help" onClick={() => openSection('Help')}>
              <CircleHelp size={20} />
            </button>
            {!hideAudiencePanel ? (
              <button
                type="button"
                className={cn(threadsUi.iconButton, threadsUi.audienceToggle)}
                aria-label="Toggle agent history"
                onClick={() => setAudiencePanelOpen((v) => !v)}
              >
                <History size={20} />
              </button>
            ) : null}
            {workspaceId ? (
              <button
                type="button"
                className={threadsUi.iconButton}
                aria-pressed={desktopPanelOpen}
                aria-label={desktopPanelOpen ? 'Hide desktop' : 'Show desktop'}
                title={desktopPanelOpen ? 'Hide desktop' : 'Show desktop'}
                onClick={openDesktopPanel}
              >
                <Monitor size={20} />
              </button>
            ) : null}
            <ThemeSwitch />
            {hideAudiencePanel ? (
              <PixelAvatar seed="you" tone="gold" small />
            ) : (
              <button
                type="button"
                className={threadsUi.profileButton}
                aria-label="Members"
                onClick={openCompose}
              >
                <PixelAvatar seed="you" tone="gold" small />
                <PixelAvatar seed="profile-2" tone="lavender" small />
              </button>
            )}
            {headerMore ? (
              <div className={cn(threadsUi.headerMenu, motionPresets.dropdownEnter)}>
                <button type="button" className={threadsUi.menuButton} onClick={copyLink}>
                  Copy link
                </button>
                <button type="button" className={threadsUi.menuButton} onClick={() => openSection('Inbox')}>
                  Open thread
                </button>
                <button type="button" className={threadsUi.menuButton} onClick={() => openCompose()}>
                  New comment
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <WorkspaceRail
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          onOpenSettings={() =>
            workspaceId &&
            navigate(`/workspaces/${workspaceId}/integrations`, { state: { name: workspaceName } })
          }
        />
        <aside className={threadsUi.sidebar}>
          <button type="button" className={threadsUi.composeButton} onClick={openCompose}>
            <Pencil size={14} strokeWidth={2.2} /> Compose
          </button>

          <nav className={threadsUi.primaryNav} aria-label="Primary navigation">
            <button
              type="button"
              className={cn(threadsUi.navItem, section === 'Inbox' && threadsUi.navItemActive)}
              onClick={() => openSection('Inbox')}
            >
              <CalendarDays size={20} /> Inbox <span className={threadsUi.countBadge}>7</span>
            </button>
            <button
              type="button"
              className={cn(threadsUi.navItem, section === 'Drafts' && threadsUi.navItemActive)}
              onClick={() => openSection('Drafts')}
            >
              <FileText size={20} /> Drafts
            </button>
          </nav>

          <section
            className={threadsUi.sidebarSection}
            data-testid="sidebar-chat-section"
          >
            <div className={threadsUi.sectionLabel}>
              <ChevronDown size={14} /> CHAT
            </div>
            {agentsQuery.isError ? (
              <span className={threadsUi.personItem} aria-disabled="true">
                Could not load agents
              </span>
            ) : null}
            {!agentsQuery.isError && !agentsQuery.isPending && sidebarAgents.length === 0 ? (
              <span className={threadsUi.personItem} aria-disabled="true">
                No agents yet
              </span>
            ) : null}
            {sidebarAgents.map((agent) => (
              <button
                key={agent.name}
                type="button"
                className={cn(threadsUi.personItem, historyAgent === agent.name && threadsUi.personSelected)}
                onClick={() => selectAgentHistory(agent.name)}
              >
                <span className={threadsUi.personAvatarWrap}>
                  <RandomAvatar seed={agent.name} size={31} />
                  {agent.isWorking ? (
                    <PulseDot size="sm" className={chatUi.activeDotSm} label={`${agent.name} is working`} />
                  ) : null}
                </span>
                <span className={threadsUi.personName}>{agent.name}</span>
              </button>
            ))}
          </section>

          <div className={threadsUi.sidebarFooter}>
            <button type="button" className={threadsUi.footerButton} onClick={() => openSection('Help')}>
              <CircleHelp size={18} /> Help
            </button>
          </div>
        </aside>

        <section className={threadsUi.contentArea}>
          {showThread ? (
            alignCenter ? (
              <div className={threadsUi.threadScroll}>
                <article className={threadsUi.threadCard}>
                  <div className={threadsUi.threadMain}>{children}</div>
                </article>
              </div>
            ) : (
              children
            )
          ) : (
            <div className={threadsUi.threadScroll}>
              <article className={threadsUi.threadCard}>
                <div className={threadsUi.threadMain}>
                  <h2>{heading}</h2>
                  <div className={threadsUi.divider} />
                  <p className={threadsUi.postCopy}>{paneCopy(section)}</p>
                </div>
              </article>
            </div>
          )}
        </section>

        {/* This panel is normally chat-only (AUDIENCE/history), but Desktop
            is universal — every page can open it — so a hideAudiencePanel
            page (Integrations/Settings) still needs this slot whenever
            desktopPanelOpen is true, even with no AUDIENCE content of its
            own to show alongside it. */}
        {(!hideAudiencePanel || desktopPanelOpen) && audiencePanelOpen ? (
          <div
            className={cn(threadsUi.audienceBackdrop, motionPresets.overlayEnter)}
            onClick={() => setAudiencePanelOpen(false)}
          />
        ) : null}

        {!hideAudiencePanel || desktopPanelOpen ? (
        <aside className={cn(threadsUi.audiencePanel, audiencePanelOpen && threadsUi.audiencePanelOpen)}>
          <button
            type="button"
            className={threadsUi.audienceClose}
            aria-label="Close agent history"
            onClick={() => setAudiencePanelOpen(false)}
          >
            <X size={18} />
          </button>
          <div className={threadsUi.audienceTitle}>
            <strong>
              {desktopPanelOpen ? 'DESKTOP' : historyAgent ? 'SESSIONS' : 'AUDIENCE'}
            </strong>
          </div>
          {desktopPanelOpen ? (
            <DesktopPreview workspaceId={workspaceId} workspaceName={workspaceName} />
          ) : (
            <AgentHistoryPanel
              workspaceId={workspaceId}
              open={audienceVisible}
              selectedAgent={historyAgent}
              onSelectedAgentChange={setHistoryAgentFromPanel}
              onSelectSession={onSelectSession}
            />
          )}
        </aside>
        ) : null}
      </div>

      {composeOpen ? (
        <div
          className={cn(threadsUi.modalBackdrop, motionPresets.overlayEnter)}
          onClick={() => setComposeOpen(false)}
        >
          <div
            className={cn(threadsUi.composeModal, motionPresets.modalEnter)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={threadsUi.modalHeader}>
              <strong>New thread</strong>
              <button type="button" onClick={() => setComposeOpen(false)} aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className={threadsUi.modalUser}>
              <PixelAvatar seed="you" tone="lavender" />
              <strong>You</strong>
              <span>
                in <b>{audience.toLowerCase()}</b>
              </span>
            </div>
            <textarea
              placeholder="What’s on your mind?"
              autoFocus
              value={composeText}
              onChange={(e) => setComposeText(e.target.value)}
            />
            {composeEmoji ? (
              <div className={threadsUi.emojiRow}>
                {['😀', '🎉', '❤️', '👍', '🔥'].map((emoji) => (
                  <button key={emoji} type="button" onClick={() => setComposeText((v) => v + emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
            <div className={threadsUi.modalFooter}>
              <button type="button" onClick={() => setComposeEmoji((v) => !v)} aria-label="Emoji">
                <SmilePlus size={19} />
              </button>
              <button type="button" className={threadsUi.modalSend} onClick={publish} disabled={!composeText.trim()}>
                <Send size={16} /> Publish
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {!hideDock ? (
        <WorkspaceDock
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          hideAudiencePanel={hideAudiencePanel}
          audiencePanelOpen={audiencePanelOpen}
          onToggleAudiencePanel={() => setAudiencePanelOpen((v) => !v)}
          desktopPanelOpen={desktopPanelOpen}
          onToggleDesktopPanel={openDesktopPanel}
        />
      ) : null}
    </main>
    </TooltipProvider>
  )
}

/** Live workspace desktop (webtop/KasmVNC) via `desktopUrl` — same
 * gateway-proxied URL the workspace list's "Open desktop" link already
 * opens in a new tab (`features/workspace/api.ts`). No new backend
 * surface. The AUDIENCE-panel thumb is a non-interactive preview; click
 * it for Fullscreen (in-app stretch, pointer events on) or Open in new
 * tab. */
// Native desktop is 1024×768 (Xvnc -geometry). Iframe uses those as HTML
// width/height so KasmVNC renders the full desktop, then CSS scale()
// shrinks it to the box. Thumb is w-full + aspect-[1024/768]. Scale is
// measured (ResizeObserver): Chrome rejects cqi inside transform:scale().
// Control bar is hidden server-side by patch_kasmvnc_hide_control_bar.py.
const DESKTOP_NATIVE_WIDTH = 1024
const DESKTOP_NATIVE_HEIGHT = 768

function useDesktopScale(fit: 'width' | 'contain') {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0)

  useLayoutEffect(() => {
    if (!el) {
      setScale(0)
      return
    }
    const update = () => {
      if (fit === 'width') {
        setScale(el.clientWidth / DESKTOP_NATIVE_WIDTH)
        return
      }
      const next = Math.min(el.clientWidth / DESKTOP_NATIVE_WIDTH, el.clientHeight / DESKTOP_NATIVE_HEIGHT)
      setScale(Number.isFinite(next) && next > 0 ? next : 0)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, fit])

  return { ref: setEl, scale }
}

function DesktopFrame({
  workspaceId,
  workspaceName,
  scale,
  interactive,
  className,
}: {
  workspaceId: string
  workspaceName: string
  scale: number
  interactive: boolean
  className: string
}) {
  return (
    <iframe
      key={workspaceId}
      className={className}
      style={scale ? { transform: `scale(${scale})` } : { visibility: 'hidden' }}
      width={DESKTOP_NATIVE_WIDTH}
      height={DESKTOP_NATIVE_HEIGHT}
      src={desktopUrl(workspaceId, true)}
      title={`${workspaceName} desktop`}
      tabIndex={interactive ? 0 : -1}
      aria-hidden={interactive ? undefined : true}
      allow={interactive ? 'clipboard-read; clipboard-write' : undefined}
    />
  )
}

function DesktopExpandDialog({
  workspaceId,
  workspaceName,
  open,
  onOpenChange,
}: {
  workspaceId: string
  workspaceName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { ref: stageRef, scale } = useDesktopScale('contain')
  const href = desktopUrl(workspaceId, true)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={threadsUi.desktopExpandBackdrop} />
        <Dialog.Popup className={threadsUi.desktopExpandPopup} aria-label={`${workspaceName} desktop`}>
          <div className={threadsUi.desktopExpandHeader}>
            <p className={threadsUi.desktopExpandTitle}>{workspaceName}&rsquo;s screen</p>
            <a
              className={threadsUi.desktopExpandHeaderBtn}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in new tab"
              title="Open in new tab"
            >
              <ExternalLink size={18} strokeWidth={2.2} />
            </a>
            <Dialog.Close className={threadsUi.desktopExpandHeaderBtn} aria-label="Close desktop">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div ref={stageRef} className={threadsUi.desktopExpandStage}>
            {scale > 0 ? (
              <div
                className={threadsUi.desktopExpandScreen}
                style={{
                  width: DESKTOP_NATIVE_WIDTH * scale,
                  height: DESKTOP_NATIVE_HEIGHT * scale,
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                }}
              >
                <DesktopFrame
                  workspaceId={workspaceId}
                  workspaceName={workspaceName}
                  scale={scale}
                  interactive
                  className={threadsUi.desktopExpandFrame}
                />
              </div>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DesktopPreview({ workspaceId, workspaceName }: { workspaceId?: string; workspaceName: string }) {
  const { ref: thumbRef, scale } = useDesktopScale('width')
  const [actionsOpen, setActionsOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const href = workspaceId ? desktopUrl(workspaceId, true) : ''

  useEffect(() => {
    if (!actionsOpen || expanded) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setActionsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actionsOpen, expanded])

  return (
    <div className={cn(threadsUi.desktopPreviewPanel, motionPresets.contentSwap)}>
      <div ref={thumbRef} className={threadsUi.desktopPreviewThumb}>
        {workspaceId ? (
          <>
            {!expanded ? (
              <DesktopFrame
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                scale={scale}
                interactive={false}
                className={threadsUi.desktopPreviewFrame}
              />
            ) : null}
            {actionsOpen ? (
              <div className={threadsUi.desktopPreviewActions}>
                <button
                  type="button"
                  className={threadsUi.desktopPreviewAction}
                  onClick={() => {
                    setActionsOpen(false)
                    setExpanded(true)
                  }}
                >
                  <Maximize2 size={14} strokeWidth={2.4} /> Fullscreen
                </button>
                <a
                  className={threadsUi.desktopPreviewAction}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setActionsOpen(false)}
                >
                  <ExternalLink size={14} strokeWidth={2.4} /> New tab
                </a>
              </div>
            ) : (
              <button
                type="button"
                className={threadsUi.desktopPreviewHit}
                aria-label="Desktop actions"
                onClick={() => setActionsOpen(true)}
              />
            )}
            <DesktopExpandDialog
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              open={expanded}
              onOpenChange={setExpanded}
            />
          </>
        ) : (
          <div className={threadsUi.desktopPreviewEmpty}>
            <Monitor size={28} strokeWidth={1.5} aria-hidden="true" />
          </div>
        )}
      </div>
      <p className={threadsUi.desktopPreviewCaption}>{workspaceName}&rsquo;s screen</p>
    </div>
  )
}

function WorkspaceRail({
  workspaceId,
  workspaceName,
  onOpenSettings,
}: {
  workspaceId?: string
  workspaceName: string
  onOpenSettings: () => void
}) {
  const navigate = useNavigate()
  const { items, loadError } = useWorkspaceList()
  const guilds: GuildEntry[] = items.map((row) => ({
    id: row.workspaceId,
    name: row.name,
    mark: row.name.trim().charAt(0).toUpperCase() || 'W',
  }))

  const currentEntry: GuildEntry | null = workspaceId
    ? {
        id: workspaceId,
        name: workspaceName,
        mark: workspaceName.trim().charAt(0).toUpperCase() || 'W',
      }
    : null

  const displayGuilds =
    currentEntry && !guilds.some((g) => g.id === currentEntry.id)
      ? [currentEntry, ...guilds]
      : guilds.length > 0
        ? guilds
        : currentEntry
          ? [currentEntry]
          : []

  return (
    <nav className={threadsUi.guildRail} aria-label="Workspaces">
      <Hint label="Dashboard" side="right">
        <button type="button" className={threadsUi.guildHome} onClick={() => navigate('/')} aria-label="Dashboard">
          <BrandLogo size="size-full" className="rounded-2xl ring-0" />
        </button>
      </Hint>
      <div className={threadsUi.guildSplit} />
      {loadError ? (
        <Hint label={loadError} side="right">
          <span className={threadsUi.guildBtn} aria-label={`Workspace list error: ${loadError}`} role="status">
            !
          </span>
        </Hint>
      ) : null}
      <div className={threadsUi.guildList}>
        {displayGuilds.map((guild) => (
          <Hint key={guild.id} label={guild.name} side="right">
            <button
              type="button"
              className={threadsUi.guildBtn}
              onClick={() =>
                navigate(`/workspaces/${guild.id}/chat`, { state: { name: guild.name } })
              }
              aria-label={guild.name}
              aria-current={guild.id === workspaceId ? 'page' : undefined}
            >
              <span className={threadsUi.guildPill} />
              {guild.mark}
            </button>
          </Hint>
        ))}
      </div>
      <Hint label="Add workspace" side="right">
        <button
          type="button"
          className={cn(threadsUi.guildBtn, threadsUi.guildAction)}
          onClick={() => navigate('/create')}
          aria-label="Add workspace"
        >
          <Plus size={22} strokeWidth={2.4} />
        </button>
      </Hint>
      <Hint label="Dashboard" side="right">
        <button
          type="button"
          className={cn(threadsUi.guildBtn, threadsUi.guildAction)}
          onClick={() => navigate('/')}
          aria-label="Dashboard"
        >
          <Compass size={20} strokeWidth={2.2} />
        </button>
      </Hint>
      <div className={threadsUi.guildEnd}>
        <Hint label="Settings" side="right">
          <button
            type="button"
            className={cn(threadsUi.guildBtn, threadsUi.guildAction)}
            onClick={onOpenSettings}
            aria-label="Settings"
          >
            <Settings2 size={20} strokeWidth={2.2} />
          </button>
        </Hint>
      </div>
    </nav>
  )
}
