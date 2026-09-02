import { Fragment, memo, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownCodeBlock } from '@/features/chat/components/markdown-code-block'
import { MediaToken } from '@/features/chat/components/media-token'
import { chatUi, type MarkdownTone } from '@/features/chat/chat-ui'
import '@/features/chat/styles/chat-markdown.css'
import { cn } from '@/lib/utils'

function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const isHttp = typeof href === 'string' && /^https?:\/\//i.test(href)
  if (!isHttp) {
    return <span>{children}</span>
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  )
}

/**
 * Same token shape upstream's own vanilla client scans reply text for
 * (`_MEDIA_TOKEN_RE` in `backend/upstream/api/routes.py:20244` and
 * `backend/upstream/static/ui.js`'s streaming `MEDIA:` handling) — an
 * agent writes `MEDIA:<absolute-local-path>` directly into its reply
 * prose to reference a local file (an uploaded attachment, a screenshot
 * it wrote to the workspace, ...). This is NOT markdown syntax
 * (`ReactMarkdown` has no idea what it means), which is why it rendered
 * as broken literal text before this fix — e.g.
 * `MEDIA:/config/.hermes/webui/attachments/<sid>/router-settings.png`
 * showing up verbatim in the transcript. A bare `file://<path>` reference
 * is the same mechanism (see `_inlineMediaHtmlForRef`'s own `file://`
 * unwrap in `backend/upstream/static/ui.js:2725`), so it's matched here
 * too, normalized to the same bare-path shape `MediaToken` expects.
 *
 * Deliberately excludes `MEDIA:https://...`/`file://` inside markdown
 * image syntax `![alt](...)` — that already goes through `ReactMarkdown`'s
 * own image node unchanged (a normal `<img src="https://...">`, confirmed
 * working, out of scope per this fix's own boundary) and is not what this
 * regex is for; this only catches the BARE-text token form.
 */
const MEDIA_TOKEN_RE = /(?:MEDIA:|file:\/\/)([^\s)\]]+)/g

type TextSegment = { kind: 'text'; value: string }
type MediaSegment = { kind: 'media'; path: string }
type Segment = TextSegment | MediaSegment

/** Splits `text` into alternating prose/`MEDIA:`-token segments, in
 * order — prose segments still go through the full `ReactMarkdown`
 * pipeline (so normal formatting inside the same message keeps working
 * exactly as before), token segments render via `MediaToken` instead.
 * Returns a single all-text segment (no split) when there's no token at
 * all — the overwhelmingly common case — so a plain message pays no
 * extra render cost beyond one `.test()`. */
function splitMediaTokens(text: string): Segment[] {
  if (!text.includes('MEDIA:') && !text.includes('file://')) {
    return [{ kind: 'text', value: text }]
  }
  const segments: Segment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(MEDIA_TOKEN_RE)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, index) })
    }
    // `file://` refs may be percent-encoded and/or carry a leading `/` the
    // same way upstream's own unwrap handles (`new URL(ref).pathname`,
    // decoded) — mirror that here so `file:///config/...` and
    // `MEDIA:/config/...` resolve to the identical bare path.
    const rawPath = match[1]
    const path = match[0].startsWith('file://')
      ? decodeSafely(rawPath.startsWith('/') ? rawPath : `/${rawPath}`)
      : rawPath
    segments.push({ kind: 'media', path })
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) })
  }
  return segments
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Renders message text as GFM markdown (XSS-safe via react-markdown AST),
 * with `MEDIA:`/`file://` local-file tokens (see `splitMediaTokens`
 * above) rendered as real image thumbnails or download-link chips instead
 * of literal text — `workspaceId`/`agent`/`sessionId` are only needed for
 * that (optional so every existing call site with no tokens to render is
 * unaffected). */
export const MarkdownContent = memo(function MarkdownContent({
  text,
  tone = 'incoming',
  workspaceId,
  agent,
  sessionId,
}: {
  text: string
  tone?: MarkdownTone
  workspaceId?: string
  agent?: string
  sessionId?: string | null
}) {
  const segments = splitMediaTokens(text)

  return (
    <div className={cn('chat-markdown', chatUi.markdownRoot)} data-tone={tone}>
      {segments.map((segment, index) =>
        segment.kind === 'media' ? (
          <MediaToken
            key={`media-${index}`}
            path={segment.path}
            workspaceId={workspaceId}
            agent={agent}
            sessionId={sessionId}
          />
        ) : (
          // Skip an all-whitespace prose segment between two media tokens
          // (or at the very start/end) — ReactMarkdown would otherwise
          // render a stray empty paragraph, adding vertical gaps where
          // there is no actual prose.
          segment.value.trim() && (
            <Fragment key={`text-${index}`}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // Block fences render their own <pre>; unwrap default wrapper.
                  pre({ children }) {
                    return <>{children}</>
                  },
                  code: MarkdownCodeBlock,
                  a: MarkdownLink,
                }}
              >
                {segment.value}
              </ReactMarkdown>
            </Fragment>
          )
        ),
      )}
    </div>
  )
})
