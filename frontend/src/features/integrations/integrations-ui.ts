/** Plugin pane internals. Outer chrome reuses `chatUi` so this matches workspace chat. */
export const integrationsUi = {
  toolbar: 'flex flex-col gap-3.5 pb-1',
  search:
    'flex h-11 min-w-0 w-full items-center gap-2.5 rounded-xl border border-[var(--th-line)] bg-[var(--th-card)] px-3.5 text-[var(--th-muted)] transition-[border-color,box-shadow] duration-150 [&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-sm [&_input]:text-[var(--th-text)] [&_input]:outline-none [&_input::placeholder]:text-[var(--th-muted)] focus-within:border-[var(--th-compose)] focus-within:shadow-[0_0_0_3px_#6743ed1f]',
  chips: 'flex flex-wrap gap-1 rounded-[11px] border border-[var(--th-line)] bg-[var(--th-search)]/50 p-1',
  chip: 'h-8 rounded-lg px-3 text-[13px] font-semibold text-[var(--th-muted)] transition-colors duration-150 hover:bg-[var(--th-hover)] hover:text-[var(--th-text)]',
  chipActive: 'bg-[var(--th-card)] text-[var(--th-text)] shadow-[0_1px_2px_#0000001a] hover:bg-[var(--th-card)] hover:text-[var(--th-text)]',
  chipCount: 'ml-1.5 text-[var(--th-muted)] opacity-70',
  section: 'flex flex-col gap-3',
  sectionHead: 'flex items-center gap-2.5 px-0.5',
  sectionEyebrow: 'text-[11px] font-bold uppercase tracking-[0.7px] text-[var(--th-muted)]',
  sectionCount:
    'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--th-hover)] px-1 text-[10.5px] font-bold text-[var(--th-muted)]',
  sectionLine: 'h-px flex-1 bg-[var(--th-line)]',
  list: 'flex flex-col',
  empty:
    'flex flex-col items-center gap-1 rounded-xl border border-dashed border-[var(--th-line)] py-14 text-center text-sm text-[var(--th-muted)]',
  card: 'gap-0 rounded-none border-0 border-b border-[var(--th-line)] bg-transparent py-0 shadow-none ring-0 last:border-b-0 hover:bg-[var(--th-hover)]',
  cardConnected: 'border-l-[3px] border-l-[var(--th-compose)]',
  cardInner: 'flex items-center gap-3 px-1 py-3 max-[760px]:px-0',
  cardTop: 'flex min-w-0 flex-1 items-start gap-3',
  cardCopy: 'min-w-0 flex-1',
  title: 'text-sm font-semibold leading-tight tracking-tight text-[var(--th-text)]',
  blurb: 'mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-[var(--th-muted)]',
  meta: 'mt-0.5 truncate text-xs text-[var(--th-muted)]',
  badge:
    'inline-flex h-5 shrink-0 items-center rounded-[5px] bg-[var(--th-badge-bg)] px-1.5 text-[11px] font-bold text-[var(--th-badge-fg)]',
  badgeWarn: 'inline-flex h-5 shrink-0 items-center rounded-[5px] bg-[#d1435b1a] px-1.5 text-[11px] font-bold text-[#d1435b]',
  actions: 'flex shrink-0 items-center gap-2',
  connect:
    'h-8 rounded-lg bg-[var(--th-compose)] px-3.5 text-[13px] font-semibold text-white shadow-[0_5px_10px_#6944ee47] transition-[background-color,box-shadow] duration-150 hover:bg-[var(--th-compose-hover)] disabled:bg-[var(--th-search)] disabled:text-[var(--th-muted)] disabled:shadow-none',
  disconnect:
    'h-8 rounded-lg border border-[var(--th-line)] bg-transparent px-3 text-[13px] font-semibold text-[var(--th-text)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-[var(--th-hover)] disabled:opacity-50',
  cancel:
    'h-8 rounded-lg border border-[var(--th-line)] bg-transparent px-3 text-[13px] font-semibold text-[var(--th-text)] hover:bg-[var(--th-hover)]',
  catalogGrid: 'grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[600px]:grid-cols-1',
  catalogCard:
    'group relative flex flex-col gap-3 rounded-2xl border border-[var(--th-line)] bg-[var(--th-card)] p-4 text-left shadow-[0_1px_2px_#00000014] transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-[3px] hover:border-[var(--th-line)] hover:shadow-[0_14px_28px_-12px_#00000040] cursor-pointer',
  catalogCardInstalled:
    'border-[var(--th-compose)]/35 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--th-compose)_7%,var(--th-card)),var(--th-card)_60%)]',
  catalogCardTop: 'flex items-start gap-3 flex-1',
  catalogCardBody: 'min-w-0 flex-1',
  catalogCardName: 'text-[13.5px] font-semibold leading-snug tracking-[-0.1px] text-[var(--th-text)]',
  catalogCardCategories: 'mt-[3px] text-[12px] leading-snug text-[var(--th-muted)]',
  catalogCardUrl: 'mt-1 truncate text-[11px] text-[var(--th-muted)] opacity-50',
  catalogCardFooter: 'flex items-center justify-between mt-auto pt-3 border-t border-[var(--th-line)]/70',
  catalogCardAction: 'text-[11.5px] font-semibold text-[var(--th-compose)]',
  catalogCardAuthType:
    'inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-[var(--th-muted)] opacity-70',
  statusDot: 'size-1.5 shrink-0 rounded-full',
  statusDotConnected: 'bg-[#1e9e4e]',
  statusDotWarn: 'bg-[#d1435b]',
  statusDotPending: 'bg-[#c98a1f] animate-pulse',
  markTile:
    'grid size-11 shrink-0 place-items-center rounded-[12px] shadow-[0_2px_6px_#00000024] ring-1 ring-black/5',
  agents:
    'mt-2 flex flex-col gap-3 rounded-2xl border border-[var(--th-line)] bg-[var(--th-card)] px-5 py-4.5 shadow-[0_1px_2px_#00000014]',
  agentsHead: 'flex items-start gap-3',
  agentsIcon:
    'grid size-9 shrink-0 place-items-center rounded-[10px] bg-[var(--th-compose)]/12 text-[var(--th-compose)]',
  agentsTitle: 'text-[14.5px] font-semibold text-[var(--th-text)]',
  agentsHint: 'mt-0.5 text-[13px] leading-relaxed text-[var(--th-muted)]',
  agentRow:
    'flex items-center justify-between gap-3 rounded-lg border-t border-[var(--th-line)]/70 px-1 py-3 first:border-t-0 hover:bg-[var(--th-hover)]',
  agentRowLabel: 'flex items-center gap-2.5',
  agentAvatar:
    'grid size-7 shrink-0 place-items-center rounded-full bg-[var(--th-selected)] text-[11px] font-bold uppercase text-[var(--th-text)]',
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
