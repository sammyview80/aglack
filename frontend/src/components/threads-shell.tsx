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
import '@/styles/threads-app.css'

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
  children: ReactNode
}

const TONES = ['gold', 'lavender', 'aqua', 'pink', 'blue', 'gray'] as const

export type AvatarTone = (typeof TONES)[number]

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

const PLACEHOLDER_PEOPLE: { name: string; tone: AvatarTone; badge?: string }[] = [
  { name: 'abdul, mehdi', tone: 'gold', badge: '2' },
  { name: 'abdul', tone: 'gold' },
  { name: 'adam', tone: 'aqua' },
  { name: 'addie', tone: 'pink' },
  { name: 'courtney', tone: 'gold' },
]

const PLACEHOLDER_AUDIENCE: AvatarTone[] = [
  'lavender',
  'gold',
  'aqua',
  'pink',
  'gold',
  'blue',
  'gray',
  'aqua',
  'gold',
  'lavender',
  'blue',
  'gray',
  'gold',
  'aqua',
  'blue',
  'gray',
  'gold',
  'pink',
  'gray',
  'gold',
  'lavender',
  'pink',
]

const THREAD_SECTIONS = new Set(['Inbox', 'Thread', 'design-www', 'Setup'])

const STATIC_GUILDS = [
  { id: 'core', name: 'Core', mark: 'C', ping: false },
  { id: 'vs', name: 'VS', mark: 'VS', ping: false },
  { id: 'alpha', name: 'alpha', mark: 'a', ping: false },
  { id: 'product', name: 'product', mark: 'p', ping: true },
  { id: 'ops', name: 'ops', mark: 'o', ping: false },
  { id: 'aglack', name: 'Aglack', mark: 'A', ping: true },
] as const

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
  return (
    <span
      className={cn('avatar', `avatar-${tone ?? avatarTone(seed)}`, small && 'avatar-small', className)}
      aria-hidden="true"
    >
      <span className="avatar-hair" />
      <span className="avatar-face">✦</span>
      <span className="avatar-body" />
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
  const [audience, setAudience] = useState('DESIGN-WWW')
  const [query, setQuery] = useState(search ?? '')
  const [badges, setBadges] = useState<Record<string, string | undefined>>(() =>
    Object.fromEntries(PLACEHOLDER_PEOPLE.map((row) => [row.name, row.badge])),
  )

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

  function selectPerson(name: string) {
    setBadges((prev) => ({ ...prev, [name]: undefined }))
    openSection(name)
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
    <main className="threads-app" data-workspace={workspaceId || workspaceName}>
      <div className="app-window">
        <WorkspaceRail workspaceId={workspaceId} onOpenSettings={() => openSection('Settings')} />
        <aside className="sidebar">
          <div className="workspace-row">
            <button type="button" className="workspace-home" onClick={() => navigate('/')}>
              <div className="workspace-mark">
                <span>▪▪</span>
                <span>▪▪</span>
              </div>
              <strong>Threads</strong>
              <ChevronDown size={15} strokeWidth={2.5} />
            </button>
            <button
              type="button"
              className="icon-button top-action"
              aria-label="Activity"
              onClick={() => openSection('Activity')}
            >
              <History size={21} />
            </button>
            <button type="button" className="icon-button" aria-label="Quick actions" onClick={openCompose}>
              <Zap size={21} />
            </button>
          </div>

          <button type="button" className="compose-button" onClick={openCompose}>
            <Pencil size={20} /> Compose
          </button>

          <nav className="primary-nav" aria-label="Primary navigation">
            <button
              type="button"
              className={section === 'Inbox' ? 'nav-item active' : 'nav-item'}
              onClick={() => openSection('Inbox')}
            >
              <CalendarDays size={20} /> Inbox <span className="count-badge">7</span>
            </button>
            <button
              type="button"
              className={section === 'Drafts' ? 'nav-item active' : 'nav-item'}
              onClick={() => openSection('Drafts')}
            >
              <FileText size={20} /> Drafts
            </button>
          </nav>

          <section className="sidebar-section">
            <div className="section-label">
              <ChevronDown size={14} /> CHANNELS
            </div>
            {PLACEHOLDER_CHANNELS.map((channel) => {
              const selected =
                section === channel.label || (section === 'Inbox' && channel.label === 'design-www')
              return (
              <button
                key={channel.label}
                type="button"
                className={selected ? 'channel-item channel-selected' : 'channel-item'}
                onClick={() => {
                  setAudience(channel.label.toUpperCase())
                  openSection(channel.label)
                }}
              >
                <span className="channel-emoji">{channel.icon}</span>
                {channel.label}
              </button>
              )
            })}
            <button type="button" className="more-button" onClick={() => setMoreOpen((v) => !v)}>
              <ChevronDown size={19} className={moreOpen ? 'rotate-180' : ''} /> view more
            </button>
            {moreOpen
              ? EXTRA_CHANNELS.map((channel) => (
                  <div className="extra-channels" key={channel.label}>
                    <button
                      type="button"
                      className={section === channel.label ? 'channel-item channel-selected' : 'channel-item'}
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

          <section className="sidebar-section chat-section">
            <div className="section-label">
              <ChevronDown size={14} /> CHAT
            </div>
            {PLACEHOLDER_PEOPLE.map((person) => (
              <button
                key={person.name}
                type="button"
                className={section === person.name ? 'person-item channel-selected' : 'person-item'}
                onClick={() => selectPerson(person.name)}
              >
                <span className="person-avatar-wrap">
                  <PixelAvatar seed={person.name} tone={person.tone} small />
                  {person.name === 'abdul' ? <i className="online-dot" /> : null}
                </span>
                <span>{person.name}</span>
                {badges[person.name] ? <span className="person-badge">{badges[person.name]}</span> : null}
              </button>
            ))}
          </section>

          <div className="sidebar-footer">
            <button type="button" className="footer-button" onClick={() => openSection('Settings')}>
              <Settings2 size={18} /> Settings
            </button>
            <button type="button" className="footer-button" onClick={() => openSection('Help')}>
              <CircleHelp size={18} /> Help
            </button>
          </div>
        </aside>

        <section className="content-area">
          <header className="content-header">
            <button type="button" className="threads-back" onClick={() => navigate('/')} aria-label="Back to workspaces">
              <ArrowLeft size={16} strokeWidth={2.4} /> Back
            </button>
            <h1>{heading}</h1>
            <div className="header-actions">
              <button type="button" className="icon-button" aria-label="Comments" onClick={openCompose}>
                <MessageCircle size={21} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="More"
                onClick={() => setHeaderMore((v) => !v)}
              >
                <Ellipsis size={22} />
              </button>
              <label className="search-box">
                <Search size={17} />
                <input
                  value={query}
                  onChange={(e) => updateSearch(e.target.value)}
                  placeholder="Search"
                  aria-label="Search"
                />
              </label>
              <button type="button" className="icon-button" aria-label="Help" onClick={() => openSection('Help')}>
                <CircleHelp size={20} />
              </button>
              <ThemeSwitch />
              <button type="button" className="profile-button" aria-hidden="true">
                <PixelAvatar seed="you" tone="gold" small />
                <PixelAvatar seed="profile-2" tone="lavender" small />
              </button>
              {headerMore ? (
                <div className="header-menu">
                  <button type="button" onClick={copyLink}>
                    Copy link
                  </button>
                  <button type="button" onClick={() => openSection('Inbox')}>
                    Open thread
                  </button>
                  <button type="button" onClick={() => openCompose()}>
                    New comment
                  </button>
                </div>
              ) : null}
            </div>
          </header>

          {showThread ? (
            alignCenter ? (
              <div className="thread-scroll">
                <article className="thread-card">
                  <div className="thread-main">{children}</div>
                </article>
              </div>
            ) : (
              children
            )
          ) : (
            <div className="thread-scroll">
              <article className="thread-card">
                <div className="thread-main">
                  <h2>{heading}</h2>
                  <div className="divider" />
                  <p className="post-copy">{paneCopy(section)}</p>
                </div>
              </article>
            </div>
          )}
        </section>

        <aside className="audience-panel">
          <div className="audience-title">
            <strong>AUDIENCE</strong>
            <button type="button" onClick={() => setAudienceOpen((v) => !v)}>
              <Laptop size={14} fill="currentColor" /> {audience} <ChevronDown size={14} fill="currentColor" />
            </button>
            {audienceOpen ? (
              <div className="audience-menu">
                {PLACEHOLDER_CHANNELS.map((channel) => (
                  <button
                    key={channel.label}
                    type="button"
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
          <div className="audience-grid">
            {PLACEHOLDER_AUDIENCE.map((tone, index) => (
              <PixelAvatar key={`${tone}-${index}`} seed={`audience-${index}`} tone={tone} small />
            ))}
          </div>
        </aside>
      </div>

      {composeOpen ? (
        <div className="modal-backdrop" onClick={() => setComposeOpen(false)}>
          <div className="compose-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>New thread</strong>
              <button type="button" onClick={() => setComposeOpen(false)} aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className="modal-user">
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
              <div className="emoji-row">
                {['😀', '🎉', '❤️', '👍', '🔥'].map((emoji) => (
                  <button key={emoji} type="button" onClick={() => setComposeText((v) => v + emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="modal-footer">
              <button type="button" onClick={() => setComposeEmoji((v) => !v)} aria-label="Emoji">
                <SmilePlus size={19} />
              </button>
              <button type="button" className="modal-send" onClick={publish} disabled={!composeText.trim()}>
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
  onOpenSettings,
}: {
  workspaceId?: string
  onOpenSettings: () => void
}) {
  const navigate = useNavigate()
  const selectedId = STATIC_GUILDS.find((g) => g.id === workspaceId)?.id

  return (
    <nav className="guild-rail" aria-label="Workspaces">
      <Hint label="Dashboard" side="right">
        <button type="button" className="guild-home" onClick={() => navigate('/')} aria-label="Dashboard">
          <BrandLogo size="size-full" className="rounded-2xl ring-0" />
        </button>
      </Hint>
      <div className="guild-split" />
      <div className="guild-list">
        {STATIC_GUILDS.map((guild) => (
          <Hint key={guild.id} label={guild.name} side="right">
            <button
              type="button"
              className={cn('guild-btn', guild.id === selectedId && 'selected')}
              onClick={() =>
                navigate(`/workspaces/${guild.id}/chat`, { state: { name: guild.name } })
              }
              aria-label={guild.name}
              aria-current={guild.id === selectedId ? 'page' : undefined}
            >
              <span className={cn('guild-pill', guild.ping && 'ping')} />
              {guild.mark}
            </button>
          </Hint>
        ))}
      </div>
      <Hint label="Add workspace" side="right">
        <button type="button" className="guild-btn guild-action" onClick={() => navigate('/create')} aria-label="Add workspace">
          <Plus size={22} strokeWidth={2.4} />
        </button>
      </Hint>
      <Hint label="Dashboard" side="right">
        <button type="button" className="guild-btn guild-action" onClick={() => navigate('/')} aria-label="Dashboard">
          <Compass size={20} strokeWidth={2.2} />
        </button>
      </Hint>
      <div className="guild-end">
        <Hint label="Settings" side="right">
          <button type="button" className="guild-btn guild-action" onClick={onOpenSettings} aria-label="Settings">
            <Settings2 size={20} strokeWidth={2.2} />
          </button>
        </Hint>
      </div>
    </nav>
  )
}
