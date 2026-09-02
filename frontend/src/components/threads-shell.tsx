import { useEffect, useState, type ReactNode } from 'react'
import {
  CalendarDays,
  ChevronDown,
  CircleHelp,
  Ellipsis,
  FileText,
  Hash,
  History,
  Laptop,
  MessageCircle,
  Pencil,
  Plus,
  Compass,
  Search,
  Send,
  Settings2,
  ArrowLeft,
  SmilePlus,
  X,
  Zap,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ThemeSwitch } from '@/features/theme/theme-switch'
import { Hint, TooltipProvider } from '@/components/ui/tooltip'
import { BrandLogo } from '@/components/brand-mark'
import { cn } from '@/lib/utils'
import { useWorkspaceList } from '@/features/workspace/hooks/use-workspace-list'
import { AgentHistoryPanel } from '@/features/agent-history/components/agent-history-panel'
import { useAgents } from '@/features/agent-history/hooks/use-agent-history'
import { RandomAvatar } from '@/components/random-avatar'
import { PulseDot } from '@/components/motion'
import { avatarToneStyles, threadsUi, type AvatarTone } from '@/components/threads-ui'
import { chatUi } from '@/features/chat/chat-ui'
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

const PLACEHOLDER_CHANNELS = [
  { icon: '❓', label: 'ask-anything' },
  { icon: '🐛', label: 'bug-reports' },
  { icon: '📣', label: 'company-announcements' },
  { icon: '👾', label: 'design-brand' },
  { icon: '▥', label: 'design-www' },
] as const

const EXTRA_CHANNELS = [
  { icon: 'hash' as const, label: 'product-feedback' },
  { icon: 'hash' as const, label: 'team-updates' },
]

const THREAD_SECTIONS = new Set(['Inbox', 'Thread', 'design-www', 'Setup'])

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
  const heading = section === 'Inbox' ? 'Thread' : section
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [composeEmoji, setComposeEmoji] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [headerMore, setHeaderMore] = useState(false)
  const [audienceOpen, setAudienceOpen] = useState(false)
  const [audiencePanelOpen, setAudiencePanelOpen] = useState(false)
  const [audience, setAudience] = useState('DESIGN-WWW')

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
    setAudienceOpen(false)
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
      <div className={threadsUi.appWindow}>
        <WorkspaceRail
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          onOpenSettings={() => openSection('Settings')}
        />
        <aside className={threadsUi.sidebar}>
          <div className={threadsUi.workspaceRow}>
            <button type="button" className={threadsUi.workspaceHome} onClick={() => navigate('/')}>
              <div className={threadsUi.workspaceMark}>
                <span>▪▪</span>
                <span>▪▪</span>
              </div>
              <strong>Threads</strong>
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

          <button type="button" className={threadsUi.composeButton} onClick={openCompose}>
            <Pencil size={20} /> Compose
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

          <section className={threadsUi.sidebarSection}>
            <div className={threadsUi.sectionLabel}>
              <ChevronDown size={14} /> CHANNELS
            </div>
            {PLACEHOLDER_CHANNELS.map((channel) => {
              const selected =
                section === channel.label || (section === 'Inbox' && channel.label === 'design-www')
              return (
              <button
                key={channel.label}
                type="button"
                className={cn(threadsUi.channelItem, selected && threadsUi.channelSelected)}
                onClick={() => {
                  setAudience(channel.label.toUpperCase())
                  openSection(channel.label)
                }}
              >
                <span className={threadsUi.channelEmoji}>{channel.icon}</span>
                {channel.label}
              </button>
              )
            })}
            <button type="button" className={threadsUi.moreButton} onClick={() => setMoreOpen((v) => !v)}>
              <ChevronDown size={19} className={moreOpen ? threadsUi.rotate180 : undefined} /> view more
            </button>
            {moreOpen
              ? EXTRA_CHANNELS.map((channel) => (
                  <div className={threadsUi.extraChannels} key={channel.label}>
                    <button
                      type="button"
                      className={cn(
                        threadsUi.channelItem,
                        threadsUi.extraChannelItem,
                        section === channel.label && threadsUi.channelSelected,
                      )}
                      onClick={() => {
                        setAudience(channel.label.toUpperCase())
                        openSection(channel.label)
                      }}
                    >
                      <Hash size={16} /> {channel.label}
                    </button>
                  </div>
                ))
              : null}
          </section>

          <section
            className={cn(threadsUi.sidebarSection, threadsUi.chatSection)}
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
            <button type="button" className={threadsUi.footerButton} onClick={() => openSection('Settings')}>
              <Settings2 size={18} /> Settings
            </button>
            <button type="button" className={threadsUi.footerButton} onClick={() => openSection('Help')}>
              <CircleHelp size={18} /> Help
            </button>
          </div>
        </aside>

        <section className={threadsUi.contentArea}>
          <header className={threadsUi.contentHeader}>
            <button type="button" className={threadsUi.threadsBack} onClick={() => navigate('/')} aria-label="Back to workspaces">
              <ArrowLeft size={16} strokeWidth={2.4} /> Back
            </button>
            <h1>{heading}</h1>
            <div className={threadsUi.headerActions}>
              <button type="button" className={threadsUi.iconButton} aria-label="Comments" onClick={openCompose}>
                <MessageCircle size={21} />
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
              <button
                type="button"
                className={cn(threadsUi.iconButton, threadsUi.audienceToggle)}
                aria-label="Toggle agent history"
                onClick={() => setAudiencePanelOpen((v) => !v)}
              >
                <History size={20} />
              </button>
              <ThemeSwitch />
              <button type="button" className={threadsUi.profileButton} aria-hidden="true">
                <PixelAvatar seed="you" tone="gold" small />
                <PixelAvatar seed="profile-2" tone="lavender" small />
              </button>
              {headerMore ? (
                <div className={threadsUi.headerMenu}>
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

        {audiencePanelOpen ? (
          <div className={threadsUi.audienceBackdrop} onClick={() => setAudiencePanelOpen(false)} />
        ) : null}

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
            <strong>AUDIENCE</strong>
            <button type="button" onClick={() => setAudienceOpen((v) => !v)}>
              <Laptop size={14} fill="currentColor" /> {audience} <ChevronDown size={14} fill="currentColor" />
            </button>
            {audienceOpen ? (
              <div className={threadsUi.audienceMenu}>
                {PLACEHOLDER_CHANNELS.map((channel) => (
                  <button
                    key={channel.label}
                    type="button"
                    className={threadsUi.menuButton}
                    onClick={() => {
                      setAudience(channel.label.toUpperCase())
                      openSection(channel.label)
                    }}
                  >
                    {channel.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <AgentHistoryPanel
            workspaceId={workspaceId}
            open={audienceVisible}
            selectedAgent={historyAgent}
            onSelectedAgentChange={setHistoryAgentFromPanel}
            onSelectSession={onSelectSession}
          />
        </aside>
      </div>

      {composeOpen ? (
        <div className={threadsUi.modalBackdrop} onClick={() => setComposeOpen(false)}>
          <div className={threadsUi.composeModal} onClick={(e) => e.stopPropagation()}>
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
    </main>
    </TooltipProvider>
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
