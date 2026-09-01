import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ChevronDown, Laptop, Plus, SmilePlus } from 'lucide-react'
import { PixelAvatar, ThreadsShell, type AvatarTone } from '@/components/threads-shell'

type WorkspaceChatProps = {
  workspaceId: string
  workspaceName: string
}

type ChatMessage = {
  id: string
  author: string
  text: string
  at: number
  tone: AvatarTone
  timeLabel?: string
}

const POST_BODY =
  'Now that we’ve kicked off our brand new NUX flow, I was thinking about the best ways to get the team involved in understanding what works well, what could be improved, and where there are any bugs (if any) that people run into.'

const PLACEHOLDER_MESSAGES: ChatMessage[] = [
  {
    id: 'placeholder-root',
    author: 'Courtney',
    text: `Watch people go through our NUX\n${POST_BODY}`,
    at: Date.now() - 60 * 60 * 1000,
    tone: 'gold',
    timeLabel: '1h',
  },
  {
    id: 'placeholder-rosalee',
    author: 'Rosalee',
    text: 'Wow! This such a great way to showcase feedback for the NUX. Saves us a bunch of time on all having to be available for the meetings but also does a great job at capturing their initial reactions and flow. Thanks for putting this together!',
    at: Date.now() - 60 * 60 * 1000,
    tone: 'lavender',
    timeLabel: '1h',
  },
]

function renderText(text: string) {
  const parts = text.split(/(@[A-Za-z0-9._-]+)/g)
  return parts.map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} style={{ fontWeight: 650, color: '#6743ed' }}>
        {part}
      </span>
    ) : (
      part
    ),
  )
}

function timeAgo(at: number): string {
  const mins = Math.max(1, Math.round((Date.now() - at) / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Per-workspace Threads chat. Placeholder copy matches the Bolt template until a chat API exists.
 */
export function WorkspaceChat({ workspaceId, workspaceName }: WorkspaceChatProps) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [liked, setLiked] = useState<Record<string, boolean>>({})
  const [plus, setPlus] = useState<Record<string, number>>({})
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>(PLACEHOLDER_MESSAGES)
  const composerRef = useRef<HTMLInputElement>(null)

  function send(text = draft) {
    const next = text.trim()
    if (!next) return
    setMessages((prev) => [
      ...prev,
      { id: String(Date.now()), author: 'You', text: next, at: Date.now(), tone: 'lavender', timeLabel: 'now' },
    ])
    setDraft('')
    setQuery('')
    setEmojiOpen(false)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    send()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const [root, ...replies] = messages
  const headline = root?.text.split('\n')[0] || ''
  const body = root?.text.split('\n').slice(1).join('\n') || ''
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return replies
    return replies.filter((row) => `${row.author} ${row.text}`.toLowerCase().includes(needle))
  }, [query, replies])

  return (
    <ThreadsShell
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      title="Thread"
      search={query}
      onSearchChange={setQuery}
      onCompose={() => composerRef.current?.focus()}
      onPublish={(text) => send(text)}
    >
      <div className="thread-scroll">
        <article className="thread-card">
          <div className="thread-main">
            {root ? (
              <>
                <div className="post-author">
                  <PixelAvatar seed={root.author} tone={root.tone} />
                  <div>
                    <div className="author-line">
                      <strong>{root.author}</strong>
                    </div>
                    <div className="meta-line">
                      {root.timeLabel || timeAgo(root.at)} <span>·</span> <Laptop size={13} fill="currentColor" />{' '}
                      design-www <ChevronDown size={13} fill="currentColor" />
                    </div>
                  </div>
                </div>
                <h2>{headline}</h2>
                <div className="divider" />
                {body ? <p className="post-copy">{renderText(body)}</p> : null}
              </>
            ) : null}

            <div className="comments-list">
              {visible.length === 0 && query.trim() ? (
                <p className="empty-search">No matching comments found.</p>
              ) : (
                visible.map((msg) => (
                  <div className="comment" key={msg.id}>
                    <PixelAvatar seed={msg.author} tone={msg.tone} />
                    <div className="comment-content">
                      <div className="comment-name">
                        <strong>{msg.author}</strong>
                        <span>·</span>
                        <span>{msg.timeLabel || timeAgo(msg.at)}</span>
                      </div>
                      <p>{renderText(msg.text)}</p>
                      <div className="comment-actions">
                        <button
                          type="button"
                          className={liked[msg.id] ? 'liked' : ''}
                          onClick={() => setLiked((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                        >
                          <span>♥</span> {liked[msg.id] ? 7 : 6}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPlus((prev) => ({ ...prev, [msg.id]: (prev[msg.id] ?? 3) + 1 }))}
                        >
                          <Plus size={16} strokeWidth={3} /> {plus[msg.id] ?? 3}
                        </button>
                        <button type="button" onClick={() => setEmojiOpen((v) => !v)}>
                          <SmilePlus size={17} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <form className="comment-box" onSubmit={onSubmit}>
            <PixelAvatar seed="you" tone="lavender" />
            <input
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Leave a comment"
              aria-label="Leave a comment"
            />
            <button className="post-button" type="submit" disabled={!draft.trim()}>
              Post
            </button>
          </form>
          {emojiOpen ? (
            <div className="emoji-row">
              {['😀', '🎉', '❤️', '👍', '🔥'].map((emoji) => (
                <button key={emoji} type="button" onClick={() => setDraft((v) => v + emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}
        </article>
      </div>
    </ThreadsShell>
  )
}
