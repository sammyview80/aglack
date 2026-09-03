/** Plugin pane internals. Outer chrome reuses `chatUi` so this matches workspace chat. */
export const integrationsUi = {
  toolbar: 'flex flex-col gap-2.5 pb-3',
  search:
    'flex h-10 min-w-0 w-full items-center gap-2 rounded-[10px] border border-[var(--th-line)] bg-[var(--th-card)] px-3 text-[var(--th-muted)] [&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-sm [&_input]:text-[var(--th-text)] [&_input]:outline-none [&_input::placeholder]:text-[var(--th-muted)] focus-within:border-[var(--th-compose)] focus-within:shadow-[0_0_0_2px_#6743ed26]',
  chips: 'flex flex-wrap gap-1.5',
  chip: 'h-8 rounded-lg px-3 text-[13px] font-semibold text-[var(--th-muted)] hover:bg-[var(--th-hover)] hover:text-[var(--th-text)]',
  chipActive: 'bg-[var(--th-selected)] text-[var(--th-text)] hover:bg-[var(--th-selected)] hover:text-[var(--th-text)]',
  list: 'flex flex-col',
  empty: 'py-8 text-sm text-[var(--th-muted)]',
  card: 'gap-0 rounded-none border-0 border-b border-[var(--th-line)] bg-transparent py-0 shadow-none ring-0 last:border-b-0 hover:bg-[var(--th-hover)]',
  cardConnected: 'border-l-[3px] border-l-[var(--th-compose)]',
  cardInner: 'flex items-center gap-3 px-1 py-3 max-[760px]:px-0',
  cardTop: 'flex min-w-0 flex-1 items-start gap-3',
  cardCopy: 'min-w-0 flex-1',
  mark: 'grid size-9 shrink-0 place-items-center rounded-[8px] ring-1 ring-[var(--th-line)]',
  title: 'text-sm font-semibold leading-tight tracking-tight text-[var(--th-text)]',
  blurb: 'mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-[var(--th-muted)]',
  meta: 'mt-0.5 truncate text-xs text-[var(--th-muted)]',
  badge:
    'inline-flex h-5 shrink-0 items-center rounded-[5px] bg-[var(--th-badge-bg)] px-1.5 text-[11px] font-bold text-[var(--th-badge-fg)]',
  badgeWarn: 'inline-flex h-5 shrink-0 items-center rounded-[5px] bg-[#d1435b1a] px-1.5 text-[11px] font-bold text-[#d1435b]',
  actions: 'flex shrink-0 items-center gap-2',
  connect:
    'h-8 rounded-lg bg-[var(--th-compose)] px-3.5 text-[13px] font-semibold text-white shadow-[0_5px_10px_#6944ee47] hover:bg-[var(--th-compose-hover)] disabled:bg-[var(--th-search)] disabled:text-[var(--th-muted)] disabled:shadow-none',
  disconnect:
    'h-8 rounded-lg border border-[var(--th-line)] bg-transparent px-3 text-[13px] font-semibold text-[var(--th-text)] hover:bg-[var(--th-hover)] disabled:opacity-50',
  cancel:
    'h-8 rounded-lg border border-[var(--th-line)] bg-transparent px-3 text-[13px] font-semibold text-[var(--th-text)] hover:bg-[var(--th-hover)]',
  agents: 'mt-4 rounded-[10px] border border-[var(--th-line)] border-l-[3px] border-l-[var(--th-compose)] bg-[var(--th-card)] px-4 py-3.5',
  agentsHead: 'flex items-start justify-between gap-3',
  agentsTitle: 'text-[15px] font-semibold text-[var(--th-text)]',
  agentsHint: 'mt-1 text-sm leading-relaxed text-[var(--th-muted)]',
  agentRow: 'flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-[var(--th-hover)]',
  switch: 'data-checked:bg-[var(--th-compose)]',
  dialogBackdrop: 'fixed inset-0 z-20 bg-[var(--th-modal-scrim)] backdrop-blur-[3px]',
  dialog:
    'threads-app fixed top-1/2 left-1/2 z-30 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-[var(--th-line)] bg-[var(--th-card)] p-5 text-[var(--th-text)] shadow-[0_20px_60px_#0e051b59]',
  dialogTitle: 'text-base font-semibold text-[var(--th-text)]',
  dialogCopy: 'mt-1 text-sm text-[var(--th-muted)]',
  field: 'flex flex-col gap-1.5 text-sm text-[var(--th-text)]',
  input:
    'h-10 w-full rounded-[10px] border border-[var(--th-line)] bg-[var(--th-card)] px-3 text-sm text-[var(--th-text)] outline-none focus:border-[var(--th-compose)] focus:shadow-[0_0_0_2px_#6743ed26]',
} as const
