import { useState } from 'react'
import { File as FileIcon } from 'lucide-react'
import { mediaFileUrl } from '@/features/chat/api'
import { chatUi } from '@/features/chat/chat-ui'
import { ImageLightbox } from '@/features/chat/components/image-lightbox'

/**
 * Same image-extension set upstream's own vanilla renderer uses to decide
 * "show this local file as a picture" vs. "show it as a download link"
 * (`_IMAGE_EXTS` in `backend/upstream/static/ui.js:2594`). Kept identical
 * so a `MEDIA:` token renders the same way in this GUI as it would in
 * upstream's own UI — no new classification invented here.
 */
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/**
 * One `MEDIA:<absolute-path>` (or bare `file://<path>`) reference the
 * AGENT emitted inline in its own reply text — see `markdown-content.tsx`'s
 * `renderMediaTokens` for where this token is extracted from the raw
 * message text before handing prose segments to `ReactMarkdown` (which has
 * no native understanding of this non-standard, Hermes-vanilla-client-only
 * syntax; without this component the token showed up as broken literal
 * text, e.g. `MEDIA:/config/.hermes/webui/attachments/<sid>/file.png`).
 *
 * Resolves through upstream's real `GET /api/media` route (see
 * `mediaFileUrl`'s doc comment in `features/chat/api.ts`), NOT the
 * `/api/file/raw` route `chat-attachments.tsx` uses for OUR OWN uploads —
 * different mechanism, different route, same "never invent a URL scheme"
 * rule.
 *
 * Image paths get a real inline thumbnail + the same fullscreen
 * `ImageLightbox` used for uploaded image attachments (click to enlarge,
 * not a new tab). Every other path (pdf/csv/html/archive/anything) gets a
 * plain download-link chip — this project's existing chip-only choice for
 * non-image files, not a new PDF/CSV/HTML viewer (matches upstream's own
 * `📎 <name>` `msg-media-link` fallback for the same case, minus the
 * inline preview-then-fallback machinery upstream's vanilla client has for
 * PDF/CSV/HTML, which is out of scope here).
 */
export function MediaToken({
  path,
  workspaceId,
  agent,
  sessionId,
}: {
  path: string
  workspaceId?: string
  agent?: string
  sessionId?: string | null
}) {
  const [open, setOpen] = useState(false)
  const name = fileNameOf(path)

  // Without a real session/workspace/agent context there is no way to
  // build a servable URL — render the bare token as plain text rather
  // than a link/image that can only 404. Every real call site (a rendered
  // chat turn) always has this context; this is a defensive fallback
  // only, matching `ChatAttachmentList`'s own no-context rule.
  if (!workspaceId || !agent || !sessionId) {
    return <>{`MEDIA:${path}`}</>
  }

  const src = mediaFileUrl(workspaceId, agent, sessionId, path)

  if (IMAGE_EXTS.test(path)) {
    return (
      <>
        <button
          type="button"
          className={chatUi.mediaTokenImageButton}
          aria-label={`View ${name}`}
          onClick={() => setOpen(true)}
        >
          <img src={src} alt={name} className={chatUi.mediaTokenImage} loading="lazy" />
        </button>
        <ImageLightbox src={src} alt={name} open={open} onOpenChange={setOpen} />
      </>
    )
  }

  return (
    <a href={src} download={name} className={chatUi.mediaTokenLink}>
      <FileIcon size={14} className="shrink-0" aria-hidden="true" />
      {name}
    </a>
  )
}
