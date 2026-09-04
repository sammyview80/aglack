/** Shared Tailwind classes for the model-catalog dialog + compact picker,
 * following `chat/chat-ui.ts`'s pattern of centralizing this feature's
 * classnames in one file instead of inlining long class strings per
 * component. Uses the same `--th-*` theme tokens as chat so this feature
 * visually matches the composer chrome it sits next to. */
export const modelsUi = {
  overlay: 'fixed inset-0 z-50 bg-black/40 backdrop-blur-md dark:bg-black/60',
  popup:
    'threads-app fixed left-1/2 top-1/2 z-50 flex max-h-[82vh] w-[min(92vw,540px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border border-[var(--th-line)] bg-[var(--th-card)] text-[var(--th-text)] shadow-[0_20px_60px_rgba(0,0,0,0.3)] max-[760px]:inset-x-0 max-[760px]:bottom-0 max-[760px]:top-auto max-[760px]:max-h-[88dvh] max-[760px]:w-full max-[760px]:translate-x-0 max-[760px]:translate-y-0 max-[760px]:rounded-b-none',
  sheetHandle: 'mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-[var(--th-line)] min-[761px]:hidden',
  header: 'flex items-center justify-between gap-3 border-b border-[var(--th-line)]/70 px-5 py-4',
  eyebrow: 'hidden',
  title: 'text-base font-semibold tracking-tight text-[var(--th-text)]',
  subtitle: 'mt-0.5 text-xs text-[var(--th-muted)]',
  closeButton:
    'grid size-8 shrink-0 place-items-center rounded-lg bg-transparent text-[var(--th-muted)] transition-colors hover:bg-[var(--th-hover)] hover:text-[var(--th-text)]',
  body: 'flex-1 overflow-y-auto px-5 py-4 max-[760px]:px-4 space-y-4',
  groupBlock: 'rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-content)]/50 p-1.5',
  groupLabel: 'flex items-center justify-between px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--th-muted)] [&_span:last-child]:rounded-md [&_span:last-child]:bg-[var(--th-search)] [&_span:last-child]:px-1.5 [&_span:last-child]:py-0.2 [&_span:last-child]:text-[10px]',
  modelRow:
    'flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent px-2.5 py-2.5 text-[13.5px] text-[var(--th-text)] transition-colors hover:bg-[var(--th-hover)] has-[:checked]:bg-[var(--th-badge-bg)]/40',
  checkbox: 'peer sr-only',
  modelTick: 'grid size-4 shrink-0 place-items-center rounded-md border border-[var(--th-line)] text-transparent transition-all peer-checked:border-[var(--th-compose)] peer-checked:bg-[var(--th-compose)] peer-checked:text-white',
  modelLabel: 'min-w-0 flex-1 truncate font-medium',
  customSection: 'mt-2 border-t border-[var(--th-line)]/70 pt-4',
  customTitle: 'text-xs font-semibold uppercase tracking-wider text-[var(--th-muted)]',
  customForm: 'mt-2.5 flex flex-col gap-2.5',
  customRow: 'flex gap-2 max-[600px]:flex-col',
  customInput:
    'h-9 flex-1 rounded-lg border border-[var(--th-line)] bg-[var(--th-card)] px-3 text-xs text-[var(--th-text)] placeholder:text-[var(--th-muted)] outline-none focus:border-[var(--th-compose)] focus:shadow-[0_0_0_2px_#6743ed26]',
  customSelect:
    'h-9 rounded-lg border border-[var(--th-line)] bg-[var(--th-card)] px-2.5 text-xs text-[var(--th-text)] outline-none focus:border-[var(--th-compose)] focus:shadow-[0_0_0_2px_#6743ed26]',
  customAddButton:
    'h-9 shrink-0 rounded-lg bg-[var(--th-hover)] px-3 text-xs font-semibold text-[var(--th-text)] transition-colors hover:bg-[var(--th-compose)] hover:text-white disabled:opacity-50',
  footer: 'flex items-center gap-3 border-t border-[var(--th-line)]/70 px-5 py-3 max-[760px]:px-4',
  selectionCount: 'min-w-0 flex-1 text-xs text-[var(--th-muted)]',
  doneButton: 'h-8.5 rounded-lg bg-[var(--th-compose)] px-4 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[var(--th-compose-hover)]',
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
