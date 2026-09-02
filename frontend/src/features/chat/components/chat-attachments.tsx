import { useState } from 'react'
import { FileText } from 'lucide-react'
import { attachmentFileUrl } from '@/features/chat/api'
import { chatUi } from '@/features/chat/chat-ui'
import { ImageLightbox } from '@/features/chat/components/image-lightbox'
import type { ChatAttachment } from '@/features/chat/types'

/** Human-readable byte size, matching the granularity a file chip needs
 * (no fractional bytes, no more than one decimal past KB) — not a
 * general-purpose formatter, so it deliberately stops at MB rather than
 * pulling in a library for a label that's only ever a few characters. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Plain filename+icon chip — the ONLY thing rendered for a non-image
 * attachment (per task scope: no PDF viewer, no rich preview), and also
 * the fallback for an image attachment when this turn has no
 * `workspaceId`/`agent`/`sessionId` context to build a real serving URL
 * from (see `AttachmentThumbnail`'s own doc comment for when that
 * happens) — a filename is always something real to show, never a
 * broken `<img src>`. */
function AttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  return (
    <span className={chatUi.attachmentChip} title={attachment.name}>
      <FileText size={14} className="shrink-0 text-[var(--th-muted)]" aria-hidden="true" />
      <span className={chatUi.attachmentChipName}>{attachment.name}</span>
      {typeof attachment.size === 'number' ? (
        <span className={chatUi.attachmentChipSize}>{formatBytes(attachment.size)}</span>
      ) : null}
    </span>
  )
}

/**
 * Renders one attachment. Image attachments get a REAL inline `<img>`
 * thumbnail sourced from upstream's own `GET /api/file/raw` (see
 * `attachmentFileUrl`'s doc comment in `features/chat/api.ts` for the
 * exact route this resolves to and why it's real, not invented).
 *
 * `sessionId` is required to build that URL (`/api/file/raw?session_id=`
 * is how upstream scopes the fallback lookup to the right session's
 * attachment inbox, `_file_raw_target` in `backend/upstream/api/routes.py`)
 * — when it's missing (defensive; every real call site below always has
 * one) this falls back to the filename chip rather than emitting an
 * `<img src>` that can only 404. Same fallback for a non-image mime, by
 * design (task scope: images get a thumbnail, everything else gets a
 * chip, never the other way around).
 *
 * Clicking the thumbnail opens a fullscreen in-app lightbox
 * (`ImageLightbox`) instead of navigating to a new browser tab — matches
 * upstream Hermes' own click-to-enlarge behavior for `.msg-media-img`
 * (`backend/upstream/static/ui.js`'s `_openImgLightbox`), not a plain
 * link-out.
 */
function AttachmentThumbnail({
  attachment,
  workspaceId,
  agent,
  sessionId,
}: {
  attachment: ChatAttachment
  workspaceId: string
  agent: string
  sessionId: string
}) {
  const [open, setOpen] = useState(false)
  const src = attachmentFileUrl(workspaceId, agent, sessionId, attachment.name)
  return (
    <>
      <button
        type="button"
        className={chatUi.attachmentImageButton}
        aria-label={`View ${attachment.name}`}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={attachment.name} className={chatUi.attachmentImage} loading="lazy" />
      </button>
      <ImageLightbox src={src} alt={attachment.name} open={open} onOpenChange={setOpen} />
    </>
  )
}

/**
 * One turn's attachment row — shown for both a freshly-sent turn
 * (optimistic, from `uploadAttachment()`'s real results, see
 * `useChat.send`) and a history-reloaded turn (from the wrapper's
 * `agent_history` projection, see `historyToTurns`/`AgentMessage`'s own
 * doc comments) — same `ChatAttachment[]` shape either way, so this
 * component never needs to know which source a turn came from.
 *
 * `workspaceId`/`agent`/`sessionId` are needed only to build a real image
 * thumbnail URL (see `AttachmentThumbnail`) — when any is absent, every
 * attachment in this turn renders as a filename chip instead (still
 * correct, just without the inline preview).
 */
export function ChatAttachmentList({
  attachments,
  workspaceId,
  agent,
  sessionId,
}: {
  attachments: ChatAttachment[]
  workspaceId?: string
  agent?: string
  sessionId?: string | null
}) {
  if (attachments.length === 0) return null
  const canBuildFileUrl = Boolean(workspaceId && agent && sessionId)

  return (
    <div className={chatUi.attachmentList} aria-label="Attachments">
      {attachments.map((attachment, index) =>
        attachment.isImage && canBuildFileUrl ? (
          <AttachmentThumbnail
            key={`${attachment.name}-${index}`}
            attachment={attachment}
            workspaceId={workspaceId as string}
            agent={agent as string}
            sessionId={sessionId as string}
          />
        ) : (
          <AttachmentChip key={`${attachment.name}-${index}`} attachment={attachment} />
        ),
      )}
    </div>
  )
}
