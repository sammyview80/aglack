/** Shared Tailwind classes for chat UI (threads-app tokens). */
export const chatUi = {
  threadScroll:
    'thread-scroll flex min-h-0 flex-1 flex-col overflow-hidden px-10 pb-6 pt-5 max-[760px]:px-0 max-[760px]:pb-0 max-[760px]:pt-0',
  threadCard:
    'thread-card mx-auto flex min-h-0 w-full max-w-[min(100%,920px)] flex-1 flex-col overflow-hidden shadow-[0_2px_5px_#1f1f2814] max-[760px]:shadow-none',
  threadMain:
    'thread-main flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-2 pt-4 max-[760px]:px-4 max-[760px]:pt-3',
  divider: 'divider my-2 mb-2.5 h-px shrink-0 bg-[var(--th-line)]',
  headerRow: 'flex items-center gap-3 min-h-11',
  headerIdentity: 'flex min-w-0 flex-col gap-px',
  headerName: 'text-sm font-semibold capitalize leading-tight text-[var(--th-text)]',
  headerMeta: 'text-xs font-medium leading-tight text-[var(--th-muted)]',
  headerActions: 'ml-auto flex items-center gap-1.5',
  headerButton:
    'flex items-center justify-center gap-1.5 rounded-lg border border-[var(--th-line)] bg-transparent px-2.5 py-1.5 text-xs font-semibold text-[var(--th-text)] transition-colors hover:bg-[var(--th-hover)] disabled:cursor-default disabled:opacity-50',
  transcript: 'chat-transcript min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto',
  transcriptInner:
    'flex min-h-full min-w-0 w-full max-w-full flex-col px-2 pt-4 pb-6 max-[760px]:px-1 [&:has(.chat-message-list-empty)]:min-h-[min(420px,100%)] [&:has(.chat-message-list-empty)]:justify-center',
  olderMessagesSpinner: 'flex w-full items-center justify-center py-2 text-[var(--th-muted)]',
  messageList: 'flex min-w-0 w-full max-w-full flex-col gap-6',
  messageListEmpty: 'chat-message-list-empty flex min-h-[min(420px,100%)] flex-1 flex-col justify-center',
  messageBlock: 'flex min-w-0 w-fit max-w-[92%] flex-col gap-1.5',
  messageBlockUser: 'items-end',
  messageRow: 'flex min-w-0 max-w-full items-end gap-3 [&_.avatar]:shrink-0 [&_svg[role=img]]:shrink-0',
  messageContent: 'flex min-w-0 max-w-full flex-col gap-1.5',
  messageTime: 'text-[11px] leading-tight text-[var(--th-muted)] whitespace-nowrap',
  messageTimeAssistant: 'pl-10',
  messageTimeUser: 'pr-10 text-right',
  bubbleBase:
    'chat-bubble inline-flex min-w-0 w-fit max-w-full flex-col items-stretch gap-1.5 overflow-x-auto overscroll-x-contain break-words rounded-[18px] px-5 py-4 text-sm leading-relaxed text-left',
  bubbleOutgoing: 'bg-[var(--th-compose)] text-white shadow-[0_1px_2px_#6743ed33]',
  bubbleIncoming:
    'border border-[var(--th-assistant-bubble-border)] bg-[var(--th-assistant-bubble)] text-[var(--th-text)] shadow-[var(--th-assistant-bubble-shadow)]',
  bubbleError: 'rounded-[18px] border-[#d1435b] bg-[#d1435b] text-white',
  bubbleStreaming: 'text-[var(--th-muted)]',
  markdownRoot: 'min-w-0 w-full max-w-full text-inherit',
  markdownIncoming: '[&_p]:text-[var(--th-text)]',
  markdownOutgoing: '[&_p]:text-white [&_li]:text-white',
  markdownError: '[&_p]:text-white',
  thinkingCard:
    'my-1.5 overflow-hidden rounded-lg border border-[var(--th-line)] bg-[var(--th-search)]',
  thinkingHeader:
    'flex w-full items-center gap-1.5 bg-transparent px-2.5 py-1.5 text-left text-[13px] font-semibold text-[var(--th-muted)] hover:bg-[var(--th-hover)]',
  thinkingBody:
    'm-0 whitespace-pre-wrap break-words px-2.5 pb-2.5 font-[inherit] text-[13px] leading-normal text-[var(--th-muted)]',
  // Single rounded-pill composer (attach, input, model picker, mic, send
  // all in one row) with a gradient fade above it so the transcript's
  // last message(s) visually dissolve into the composer area instead of
  // hard-cutting at a border — see composerFade below. relative + z-20 so
  // the fade (an absolutely-positioned sibling) layers correctly; no
  // dock-clearance padding needed here since WorkspaceDock is hidden on
  // the chat screen (ThreadsShell's hideDock).
  //
  // pt-16 (64px) reserves room INSIDE this box for composerFade — .composer
  // is a sibling of .threadMain inside threadCard, and threadCard is
  // overflow-hidden (for its rounded corners/shadow), so anything meant to
  // render above .composer's own box gets clipped before reaching the
  // transcript. Keeping the fade's height within .composer's own padding
  // (instead of a negative top offset escaping upward) avoids that clip
  // entirely. Same reasoning sizes composerAttachments' headroom below.
  composer: 'chat-composer relative z-20 shrink-0 max-[760px]:px-3 max-[760px]:pb-[max(12px,env(safe-area-inset-bottom))]',
  // Gradient mask filling .composer's own reserved top padding (see pt-16
  // above) — fades the transcript's actual background into the pill as it
  // approaches the input. Verified via threads-ui.ts: neither threadCard
  // nor threadMain sets its own bg-*, so contentArea's bg-[var(--th-content)]
  // is what's genuinely painted behind the transcript AND behind .composer
  // (siblings inside the same unstyled threadCard) — --th-content is the
  // correct match, not --th-card (only composerPill itself uses --th-card,
  // for the pill's own surface).
  composerFade:
    'pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-t from-[var(--th-content)] to-transparent',
  // bg-[var(--th-card)]/70 (light) or /85 (dark) + backdrop-blur:
  // translucent frosted-glass pill (same backdrop-blur-[8px] strength as
  // dialogBackdrop/modalBackdrop in integrations-ui.ts/threads-ui.ts,
  // scaled up since this blurs page content behind it rather than a
  // modal scrim) instead of a fully opaque surface, so the transcript
  // scrolling behind the pill is faintly visible through it. Dark theme
  // gets a higher opacity floor (85% vs 70%) than light — a near-black
  // --th-card at only 70% let busy/light transcript content (images,
  // light bubbles) wash out the muted placeholder/icon text (--th-muted,
  // --th-icon) as it scrolled underneath; light theme's white --th-card
  // doesn't have that failure mode since dark text stays legible against
  // almost anything showing through.
  // Dark theme: hardcoded gray, not --th-card — the page background is
  // now true black (globals.css), and a near-black card at any opacity
  // reads as almost invisible against it. The composer pill needs to
  // stay a visibly distinct gray surface regardless of how dark the
  // canvas gets.
  composerPill:
    'relative flex w-full items-center gap-1 rounded-full border border-[var(--th-line)] bg-[var(--th-card)]/70 dark:border-[#2c2c2c] dark:bg-[#1a1a1a] py-1.5 pl-1.5 pr-2 shadow-[0_8px_24px_#0000000f] backdrop-blur-[8px] transition-[border-color,box-shadow] focus-within:border-[var(--th-compose)] focus-within:shadow-[0_0_0_2px_#6743ed26] dark:focus-within:shadow-[0_0_0_2px_#7b5cff33]',
  // bottom-full anchors into .composer's own pt-16 headroom (same
  // reserved space the fade uses) — chips render within .composer's box,
  // never relying on escaping threadCard's overflow-hidden clip.
  composerAttachments:
    'absolute bottom-full left-1 mb-1.5 flex flex-wrap gap-1.5',
  composerAttachmentChip:
    'inline-flex items-center gap-1 rounded-md bg-[var(--th-search)] px-2 py-1 text-xs text-[var(--th-text)] [&_button]:grid [&_button]:place-items-center [&_button]:bg-transparent [&_button]:p-0 [&_button]:text-[var(--th-muted)]',
  composerFileInput:
    'chat-composer-file-input absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 [-webkit-clip-path:inset(50%)] [clip-path:inset(50%)]',
  composerAttach:
    'grid size-9 shrink-0 place-items-center rounded-full bg-transparent text-[var(--th-icon)] hover:bg-[var(--th-hover)] hover:text-[var(--th-text)] disabled:cursor-default disabled:opacity-45',
  composerInput:
    'min-w-0 flex-1 border-0 bg-transparent px-1.5 py-2 text-sm text-[var(--th-text)] outline-none placeholder:text-[var(--th-muted)] disabled:opacity-60',
  composerTool:
    'grid size-9 shrink-0 place-items-center rounded-full bg-transparent text-[var(--th-icon)] hover:bg-[var(--th-hover)] hover:text-[var(--th-text)] disabled:cursor-default disabled:opacity-45',
  composerToolActive: 'bg-[var(--th-badge-bg)] text-[var(--th-compose)]',
  composerSend:
    'grid size-9 shrink-0 place-items-center rounded-full bg-[var(--th-compose)] text-white transition-[transform,box-shadow] hover:scale-105 disabled:scale-100 disabled:cursor-default disabled:bg-[var(--th-search)] disabled:text-[var(--th-muted)]',
  composerStop:
    'grid size-9 shrink-0 place-items-center rounded-full bg-[#d1435b] text-white transition-colors',
  composerHint:
    'mt-2 px-1 text-center text-[11px] text-[var(--th-muted)] max-[760px]:hidden',
  promptDock: 'min-h-0 shrink-0',
  promptCard:
    'my-3.5 flex max-h-[min(42vh,22rem)] min-h-0 shrink-0 flex-col overflow-hidden rounded-[10px] border border-[var(--th-line)] border-l-[3px] border-l-[var(--th-compose)] bg-[var(--th-card)] px-4 py-3.5 shadow-[0_2px_8px_#1f1f2814]',
  promptHeader: 'min-h-0 max-h-28 shrink-0 overflow-auto',
  promptBody: 'min-h-0 flex-1 overflow-auto',
  promptFooter: 'mt-2.5 flex shrink-0 flex-col gap-2.5 border-t border-[var(--th-line)] pt-2.5',
  promptTitle: 'mb-2 text-[15px] font-semibold text-[var(--th-text)]',
  promptDescription: 'mb-2 text-sm text-[var(--th-muted)] last:mb-0',
  promptCommand: 'm-0 overflow-x-auto rounded-md bg-[var(--th-sidebar)] px-2.5 py-2 text-[13px]',
  promptChoices: 'flex flex-wrap gap-2',
  promptAnswer: 'flex gap-2',
  promptInput:
    'min-w-0 flex-1 rounded-[10px] border border-[var(--th-line)] bg-[var(--th-card)] px-3 py-2.5 text-sm text-[var(--th-text)] transition-[border-color,box-shadow] focus:border-[var(--th-compose)] focus:outline-none focus:shadow-[0_0_0_2px_#6743ed26] dark:focus:shadow-[0_0_0_2px_#7b5cff33]',
  promptSend:
    'rounded-lg bg-[var(--th-compose)] px-3.5 py-2 font-semibold text-white shadow-[0_5px_10px_#6944ee47] transition-all hover:-translate-y-px hover:shadow-[0_8px_15px_#6944ee59] disabled:translate-none disabled:cursor-default disabled:bg-[var(--th-search)] disabled:text-[var(--th-muted)] disabled:shadow-none',
  promptChoice:
    'rounded-lg border border-[#6743ed40] bg-[var(--th-badge-bg)] px-3 py-1.5 text-[13px] font-semibold text-[var(--th-badge-fg)] transition-colors hover:bg-[var(--th-compose)] hover:text-white disabled:cursor-default disabled:opacity-60',
  promptApprove:
    'rounded-lg bg-[var(--th-compose)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--th-compose-hover)]',
  promptDeny: 'rounded-lg bg-[#d1435b] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#c22e47]',
  emptyState: 'mx-auto my-0 flex flex-col items-center px-6 py-7 text-center',
  emptyTitle: 'm-0 text-xl font-semibold capitalize leading-tight tracking-tight text-[var(--th-text)]',
  emptySubtitle: 'mb-5 mt-2 max-w-[380px] text-sm leading-relaxed text-[var(--th-muted)]',
  emptyStarters: 'flex max-w-[520px] flex-wrap justify-center gap-2',
  emptyStarter:
    'rounded-full border border-[#6743ed40] bg-[var(--th-badge-bg)] px-3.5 py-2 text-[13px] font-semibold text-[var(--th-badge-fg)] transition-all hover:-translate-y-px hover:border-transparent hover:bg-[var(--th-compose)] hover:text-white',
  scrollFab:
    'sticky bottom-2 z-[2] mt-2 flex items-center gap-1.5 self-end rounded-[20px] border border-[var(--th-line)] bg-[var(--th-card)] px-3.5 py-2 text-[13px] font-semibold text-[var(--th-text)] shadow-[0_4px_12px_#0000001f] transition-colors hover:bg-[var(--th-hover)]',
  toolRow:
    'flex w-full min-w-0 items-center gap-2 rounded-md bg-[var(--th-search)] px-2 py-1 text-[13px] text-[var(--th-muted)]',
  toolRowButton:
    'cursor-pointer border-0 font-inherit transition-colors hover:bg-[var(--th-hover)]',
  toolSummary:
    'my-1.5 overflow-hidden rounded-lg border border-[var(--th-line)] bg-[var(--th-search)]',
  toolSummaryHeader:
    'flex w-full items-center gap-1.5 bg-transparent px-2.5 py-1.5 text-left text-[13px] font-semibold text-[var(--th-muted)] hover:bg-[var(--th-hover)]',
  errorText: 'text-[#d1435b]',
  retryButton: 'font-semibold text-[var(--th-text)] underline',
  activeDotMd: 'right-[-1px] bottom-[-1px]',
  activeDotSm: 'right-0 bottom-0',
  // Attachment display (transcript, not composer) — a turn's real
  // uploaded files, rendered as an inline image thumbnail (real serving
  // route, see `attachmentFileUrl` in `features/chat/api.ts`) or a
  // filename+icon chip for everything else. Kept visually distinct from
  // `composerAttachmentChip` (pre-send, removable) since this one is
  // read-only history, not a pending draft.
  attachmentList: 'flex flex-wrap gap-1.5',
  attachmentImage:
    'block max-h-64 max-w-full rounded-lg border border-[var(--th-line)] object-contain',
  attachmentImageButton: 'block cursor-pointer border-0 bg-transparent p-0',
  attachmentChip:
    'inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--th-line)] bg-[var(--th-search)] px-2.5 py-1.5 text-xs text-[var(--th-text)]',
  attachmentChipName: 'min-w-0 flex-1 truncate',
  attachmentChipSize: 'shrink-0 text-[var(--th-muted)]',
  // Fullscreen image lightbox (`image-lightbox.tsx`) — mirrors upstream's
  // own `.img-lightbox`/`.img-lightbox img`/`.img-lightbox-close`
  // (`backend/upstream/static/*.css`): dark near-opaque backdrop, image
  // centered and capped to 90% of the viewport with `object-fit:contain`,
  // a circular close button pinned to the top-right corner.
  lightboxBackdrop: 'fixed inset-0 z-50 bg-black/[.82]',
  lightboxPopup:
    'fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center outline-none',
  lightboxImage:
    'max-h-[90vh] max-w-[90vw] cursor-default rounded-lg object-contain shadow-[0_8px_48px_rgba(0,0,0,0.6)]',
  lightboxClose:
    'absolute right-5 top-4 grid size-9 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20',
  // MEDIA:<path>/file:// tokens the AGENT emits inline in its own reply
  // text (see `markdown-content.tsx`'s `renderMediaTokens`) — separate
  // from `attachment*` above (those are files WE uploaded). An inline
  // thumbnail button for images, or a small download-link chip for
  // everything else, matching upstream's own `.msg-media-img`/
  // `.msg-media-link` treatment (`backend/upstream/static/ui.js`'s
  // `_inlineMediaHtmlForRef`).
  mediaTokenImageButton: 'mt-1 block cursor-zoom-in border-0 bg-transparent p-0',
  mediaTokenImage:
    'block max-h-64 max-w-full rounded-lg border border-[var(--th-line)] object-contain',
  mediaTokenLink:
    'mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--th-line)] bg-[var(--th-search)] px-2.5 py-1.5 text-xs text-[var(--th-text)] no-underline hover:bg-[var(--th-hover)]',
} as const

export type MarkdownTone = 'incoming' | 'outgoing' | 'error'

export function markdownToneClass(tone: MarkdownTone): string {
  if (tone === 'outgoing') return chatUi.markdownOutgoing
  if (tone === 'error') return chatUi.markdownError
  return chatUi.markdownIncoming
}
