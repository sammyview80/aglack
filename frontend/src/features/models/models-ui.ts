/** Shared Tailwind classes for the model-catalog dialog + compact picker,
 * following `chat/chat-ui.ts`'s pattern of centralizing this feature's
 * classnames in one file instead of inlining long class strings per
 * component. Uses the same `--th-*` theme tokens as chat so this feature
 * visually matches the composer chrome it sits next to. */
export const modelsUi = {
  overlay: 'fixed inset-0 z-50 bg-black/40',
  popup:
    'fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--th-line)] bg-[var(--th-card)] shadow-[0_12px_32px_#00000033]',
  header: 'flex items-center justify-between gap-3 border-b border-[var(--th-line)] px-5 py-4',
  title: 'text-base font-semibold text-[var(--th-text)]',
  closeButton:
    'grid size-8 shrink-0 place-items-center rounded-md bg-transparent text-[var(--th-icon)] hover:bg-[var(--th-hover)] hover:text-[var(--th-text)]',
  body: 'flex-1 overflow-y-auto px-5 py-4',
  groupBlock: 'mb-5 last:mb-0',
  groupLabel: 'mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--th-muted)]',
  modelRow:
    'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-[var(--th-text)] hover:bg-[var(--th-hover)]',
  checkbox: 'size-4 shrink-0 accent-[var(--th-compose)]',
  modelLabel: 'min-w-0 flex-1 truncate',
  footer: 'flex items-center justify-end gap-2 border-t border-[var(--th-line)] px-5 py-3.5',
  emptyText: 'py-8 text-center text-sm text-[var(--th-muted)]',
  errorText: 'text-[#d1435b]',

  pickerWrap: 'relative z-20 shrink-0',
  pickerTrigger:
    'flex items-center gap-1.5 rounded-lg border border-[var(--th-line)] bg-transparent px-2.5 py-1.5 text-xs font-semibold text-[var(--th-text)] transition-colors hover:bg-[var(--th-hover)] disabled:cursor-default disabled:opacity-50',
  pickerTriggerLabel: 'max-w-[160px] truncate',
  pickerMenu:
    'absolute bottom-full left-0 z-50 mb-1.5 max-h-[min(320px,50vh)] w-64 overflow-y-auto rounded-lg border border-[var(--th-line)] bg-[var(--th-card)] py-1.5 shadow-[0_8px_24px_#00000026]',
  pickerGroupLabel:
    'px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--th-muted)]',
  pickerItem:
    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--th-text)] hover:bg-[var(--th-hover)] disabled:cursor-default disabled:opacity-50',
  pickerItemActive: 'font-semibold text-[var(--th-compose)]',
  pickerDivider: 'my-1 h-px bg-[var(--th-line)]',
  pickerAddAction:
    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-[var(--th-compose)] hover:bg-[var(--th-hover)]',
  pickerEmpty: 'px-3 py-2.5 text-xs leading-snug text-[var(--th-muted)]',
} as const
