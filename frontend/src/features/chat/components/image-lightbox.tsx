import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { chatUi } from '@/features/chat/chat-ui'

/**
 * Fullscreen click-to-enlarge viewer for a chat image — mirrors upstream
 * Hermes' own `.img-lightbox` UX (`backend/upstream/static/ui.js`'s
 * `_openImgLightbox`/`_openImgLightboxWithNav`, styled by
 * `.img-lightbox` in `backend/upstream/static/*.css`): a dark fullscreen
 * backdrop, the image centered and scaled to fit the viewport
 * (`max-width/height: 90vw/90vh`, `object-fit: contain`), a close button,
 * and dismiss via Escape or clicking the backdrop — not upstream's exact
 * DOM (that's vanilla JS building raw elements), but the same real
 * behavior, built on this codebase's existing `@base-ui/react` `Dialog`
 * convention (see `features/models/components/model-catalog-dialog.tsx`).
 *
 * Deliberately does NOT replicate upstream's prev/next multi-image
 * navigation — every real call site here (an uploaded attachment
 * thumbnail, a `MEDIA:`-token image in agent prose) opens exactly one
 * image at a time, with no sibling gallery to page through, so that
 * complexity has nothing to attach to. If a future caller needs it, add
 * `images`/`index` props then — not speculatively here.
 */
export function ImageLightbox({
  src,
  alt,
  open,
  onOpenChange,
}: {
  src: string
  alt: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={chatUi.lightboxBackdrop} />
        <Dialog.Popup
          className={chatUi.lightboxPopup}
          aria-label={alt || 'Image'}
          // The image itself is the entire popup surface; clicking it must
          // not bubble to the backdrop's own click-to-close (that would
          // make the image itself unclickable/impossible to inspect
          // without instantly closing) — matches upstream's
          // `img.onclick = e => e.stopPropagation()`.
          onClick={(e) => e.stopPropagation()}
        >
          <img src={src} alt={alt} className={chatUi.lightboxImage} />
          <Dialog.Close className={chatUi.lightboxClose} aria-label="Close">
            <X size={20} />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
