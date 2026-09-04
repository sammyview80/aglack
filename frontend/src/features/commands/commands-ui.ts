/** Shared Tailwind classes for the slash-command autocomplete dropdown,
 * following `chat/chat-ui.ts` / `models/models-ui.ts`'s pattern of one
 * classname file per feature. Reuses the same `--th-*` tokens and the
 * `pickerMenu` popover recipe from models-ui so this dropdown visually
 * matches the model picker sitting in the same pill.
 *
 * No exec-output banner here anymore — a command's result now renders as
 * a real chat message (`useChat.pushLocalCommandResult`), matching
 * upstream Hermes WebUI's own command interception exactly instead of a
 * floating toast. See `chat-composer.tsx`'s own doc comment on
 * `onCommandResult` for why. */
export const commandsUi = {
  // Anchored into .composer's own reserved headroom (see chatUi.composer's
  // pt-16 comment) — bottom-full like composerAttachments/pickerMenu, so it
  // never has to escape threadCard's overflow-hidden clip.
  menu:
    'absolute bottom-full left-0 right-0 z-50 mb-1.5 max-h-[min(320px,50vh)] overflow-y-auto rounded-lg border border-[var(--th-line)] bg-[var(--th-card)] py-1.5 shadow-[0_8px_24px_#00000026]',
  item:
    'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm text-[var(--th-text)] hover:bg-[var(--th-hover)]',
  itemActive: 'bg-[var(--th-hover)]',
  itemHeader: 'flex w-full min-w-0 items-baseline gap-2',
  itemName: 'font-semibold',
  itemArgs: 'truncate font-mono text-xs text-[var(--th-muted)]',
  itemBadge:
    'ml-auto shrink-0 rounded-md bg-[var(--th-badge-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--th-badge-fg)]',
  itemDescription: 'w-full truncate text-xs text-[var(--th-muted)]',
} as const
