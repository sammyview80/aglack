/** Tailwind class strings for the Threads shell (--th-* tokens on `.threads-app`). */
export const threadsUi = {
  root:
    'threads-app flex h-dvh min-h-dvh items-stretch justify-stretch overflow-hidden bg-[var(--th-backdrop)] p-0 text-[var(--th-text)] max-[760px]:p-0',

  appWindow:
    'grid h-full min-h-0 w-full grid-cols-[72px_317px_minmax(560px,1fr)_327px] overflow-hidden rounded-[21px] border border-[var(--th-window-border)] bg-[var(--th-window)] shadow-[0_28px_70px_#0a011859,0_3px_12px_#1106223d] max-[1120px]:grid-cols-[72px_250px_minmax(500px,1fr)] max-[760px]:h-dvh max-[760px]:min-h-0 max-[760px]:grid-cols-[72px_1fr] max-[760px]:gap-0 max-[760px]:rounded-none',

  guildRail:
    'flex w-[72px] min-w-[72px] flex-col items-center overflow-auto bg-[#1e1f22] px-0 pb-3 pt-3 max-[760px]:flex',
  guildHome:
    'relative grid size-12 place-items-center overflow-hidden rounded-2xl bg-white p-0 text-white transition-[border-radius,background,color] duration-150 ease-out [&_img]:size-[88%] [&_img]:object-contain',
  guildBtn:
    'group relative grid size-12 place-items-center rounded-2xl bg-[#313338] text-[15px] font-bold tracking-[-0.3px] text-[#dbdee1] transition-[border-radius,background,color] duration-150 ease-out hover:rounded-2xl hover:bg-[#5865f2] hover:text-white aria-[current=page]:rounded-2xl aria-[current=page]:bg-[#5865f2] aria-[current=page]:text-white',
  guildAction: 'mt-2 hover:bg-[#23a559] hover:text-white',
  guildSplit: 'my-2 h-0.5 w-8 rounded-sm bg-[#35363c]',
  guildList: 'flex flex-col gap-2',
  guildEnd: 'mt-auto pt-2',
  guildPill:
    'absolute left-[-12px] h-0 w-1 rounded-r-[4px] bg-[#f2f3f5] transition-[height] duration-150 ease-out group-hover:h-5 group-aria-[current=page]:h-10',

  sidebar:
    'flex flex-col overflow-auto rounded-xl border border-[var(--th-sidebar-line)] bg-gradient-to-b from-[var(--th-sidebar)] to-[var(--th-sidebar-2)] px-3.5 pb-5 pt-4 max-[760px]:hidden',
  workspaceRow: 'flex h-12 items-center gap-[9px] px-[11px] text-[var(--th-text)] [&_strong]:text-base [&_strong]:tracking-[-0.4px]',
  workspaceHome: 'flex cursor-pointer items-center gap-[9px] bg-transparent p-0 text-inherit',
  workspaceMark:
    'grid h-[39px] w-[39px] place-content-center gap-0 rounded-[7px] bg-[#1e2633] pr-[5px] text-base leading-[9px] tracking-[-4px] text-[#f7f7f8] [&_span]:block [&_span]:h-2',
  iconButton:
    'grid place-items-center rounded-md bg-transparent p-[5px] text-[var(--th-icon)] transition-[background,transform] duration-200 hover:-translate-y-px hover:bg-[var(--th-icon-hover)]',
  topAction: 'ml-auto',
  composeButton:
    'mb-5 mt-5 flex h-11 min-h-11 w-full shrink-0 cursor-pointer items-center justify-center gap-[9px] rounded-lg bg-[var(--th-compose)] text-sm font-[650] text-white transition-colors duration-200 hover:bg-[var(--th-compose-hover)]',
  primaryNav: 'grid gap-1 px-px',
  navItem:
    'flex w-full items-center gap-3 rounded-md px-[15px] py-2 text-left text-sm font-[560] text-[var(--th-text)] transition-[background,color] duration-150 hover:bg-[var(--th-hover)] [&_svg]:text-[var(--th-icon)]',
  navItemActive: 'bg-[var(--th-selected)]',
  countBadge:
    'ml-auto rounded-[5px] bg-[var(--th-badge-bg)] px-1.5 py-[3px] text-xs font-bold text-[var(--th-badge-fg)]',
  sidebarSection: 'mt-6 flex flex-col gap-0.5',
  sectionLabel:
    'flex items-center gap-1.5 px-[15px] pb-2.5 text-[11px] font-[750] tracking-[1.4px] text-[var(--th-muted)]',
  channelItem:
    'flex w-full items-center gap-2.5 rounded-md px-[15px] py-1.5 text-left text-sm font-[560] text-[var(--th-text)] transition-[background,color] duration-150 hover:bg-[var(--th-hover)]',
  channelSelected: 'bg-[var(--th-selected)]',
  channelEmoji: 'w-[22px] text-center text-[15px]',
  moreButton:
    'flex w-full items-center gap-2 rounded-md py-2 pl-[34px] pr-[15px] text-left text-[13px] font-medium text-[var(--th-muted)] transition-[background,color] duration-150 hover:bg-[var(--th-hover)] [&_svg]:transition-transform [&_svg]:duration-200',
  rotate180: 'rotate-180',
  extraChannels: 'mt-0.5',
  extraChannelItem: 'pl-[41px] text-[13px]',
  personItem:
    'relative flex w-full items-center gap-2.5 rounded-md py-1 pl-4 pr-[15px] text-left text-sm font-[560] text-[var(--th-text)] transition-[background,color] duration-150 hover:bg-[var(--th-hover)]',
  personSelected: 'bg-[var(--th-selected)]',
  personAvatarWrap: 'relative inline-block h-[31px] w-[31px] shrink-0',
  personName: 'capitalize',
  sidebarFooter: 'mt-auto flex flex-wrap gap-1 pt-6',
  footerButton:
    'flex w-auto items-center gap-3 rounded px-[13px] py-[7px] text-left text-xs text-[var(--th-muted)] transition-[background,color] duration-150 hover:bg-[var(--th-hover)]',
  companyHeading: 'text-[17px] font-bold tracking-tight',

  desktopPreviewPanel: 'flex flex-1 min-h-0 flex-col pt-4',
  // w-full so the thumb never overflows the audience column (327px /
  // 300px drawer, both px-8). aspect-[1024/768] matches native Xvnc
  // geometry — width > height. Iframe is the real 1024×768 buffer,
  // CSS-scaled in threads-shell.tsx. Control bar is hidden in the
  // workspace image, so the full desktop is shown.
  desktopPreviewThumb:
    'group relative w-full aspect-[1024/768] shrink-0 overflow-hidden rounded-xl border border-[var(--th-line)] bg-[var(--th-card)]',
  desktopPreviewFrame: 'pointer-events-none absolute left-0 top-0 origin-top-left border-0',
  desktopPreviewEmpty: 'grid size-full place-items-center text-[var(--th-muted)]',
  desktopPreviewHit:
    'absolute inset-0 z-[1] cursor-pointer bg-transparent group-hover:bg-black/20',
  desktopPreviewActions:
    'absolute inset-0 z-[1] flex items-center justify-center gap-2 bg-black/55',
  desktopPreviewAction:
    'flex h-11 min-w-11 items-center gap-1.5 rounded-full bg-black/85 px-4 text-[13px] font-[650] text-white shadow-[0_8px_20px_#00000040] hover:bg-black',
  desktopPreviewCaption: 'mt-2.5 text-center text-[13px] font-[560] text-[var(--th-text)]',
  desktopExpandBackdrop: 'fixed inset-0 z-50 bg-black/[.82]',
  desktopExpandPopup:
    'fixed inset-0 z-50 flex flex-col bg-[#0b0b0d] outline-none',
  desktopExpandHeader:
    'flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2.5 text-white',
  desktopExpandTitle: 'min-w-0 flex-1 truncate text-[13px] font-[560]',
  desktopExpandHeaderBtn:
    'grid size-11 place-items-center rounded-full text-white hover:bg-white/10',
  desktopExpandStage: 'relative min-h-0 flex-1',
  desktopExpandScreen: 'absolute overflow-hidden bg-black',
  desktopExpandFrame: 'absolute left-0 top-0 origin-top-left border-0',
  contentArea: 'flex justify-between h-full min-h-0 min-w-0 flex-col bg-[var(--th-content)]',
  contentHeader:
    'flex h-[69px] shrink-0 items-center border-b border-[var(--th-header-line)] px-8 max-[760px]:px-4 [&_h1]:m-0 [&_h1]:text-[17px] [&_h1]:tracking-[-0.4px] [&_h1]:text-[var(--th-text)]',
  threadsBack:
    'mr-3 flex items-center gap-1.5 rounded-lg bg-transparent px-2.5 py-1.5 text-[13px] font-[560] text-[var(--th-text)] hover:bg-[var(--th-icon-hover)]',
  headerActions:
    'relative ml-auto flex items-center gap-[18px] max-[760px]:gap-[7px] max-[760px]:[&>:nth-child(1)]:hidden max-[760px]:[&>:nth-child(2)]:hidden max-[760px]:[&>:nth-last-child(2)]:hidden',
  searchBox:
    'flex h-[38px] w-[158px] items-center gap-[9px] rounded-lg bg-[var(--th-search)] px-[11px] text-[var(--th-muted)] max-[760px]:w-[130px] [&_input]:min-w-0 [&_input]:w-full [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-sm [&_input]:text-[var(--th-text)] [&_input]:outline-none [&_input::placeholder]:text-[var(--th-muted)] [&_input::placeholder]:opacity-100',
  profileButton:
    'flex items-center bg-transparent p-0 max-[760px]:hidden [&_span+span]:-ml-1.5',
  headerMenu:
    'absolute right-7 top-[58px] z-[8] min-w-[180px] rounded-[10px] border border-[var(--th-line)] bg-[var(--th-card)] p-1.5 shadow-[0_10px_28px_#1f1f281f]',
  menuButton:
    'block w-full rounded-md bg-transparent px-2.5 py-2 text-left text-[13px] text-[var(--th-text)] hover:bg-[var(--th-menu-hover)]',
  audienceToggle: 'hidden max-[1120px]:grid',
  themeSwitch:
    'rounded-md bg-transparent text-[var(--th-icon)] shadow-none hover:bg-[var(--th-icon-hover)] hover:text-[var(--th-text)]',

  threadScroll:
    'flex-1 overflow-auto px-[27px] pb-[38px] pt-[34px] max-[760px]:px-2.5 max-[760px]:pb-[25px] max-[760px]:pt-4',
  threadCard:
    'mx-auto max-w-[700px] overflow-hidden rounded-xl border border-[var(--th-line)] bg-[var(--th-card)] shadow-[0_2px_5px_#1f1f2814]',
  threadMain:
    'px-[29px] pb-6 pt-7 max-[760px]:px-[18px] max-[760px]:pb-[22px] max-[760px]:pt-[23px] [&_h2]:mb-[30px] [&_h2]:text-xl [&_h2]:leading-tight [&_h2]:tracking-[-0.7px] [&_h2]:text-[var(--th-text)] max-[760px]:[&_h2]:text-lg',
  divider: 'mb-6 h-px bg-[var(--th-line)]',
  postCopy:
    'm-0 text-base leading-[1.52] tracking-[-0.15px] text-muted-foreground [.threads-app_&]:text-[var(--th-muted)] max-[760px]:text-sm',
  emptySearch: 'my-5 text-[var(--th-muted)]',

  audienceBackdrop: 'hidden max-[1120px]:fixed max-[1120px]:inset-0 max-[1120px]:z-[14] max-[1120px]:block max-[1120px]:bg-[var(--th-modal-scrim)]',
  audiencePanel:
    'rounded-xl border border-[var(--th-sidebar-line)] bg-[var(--th-sidebar)] px-8 pb-12 pt-[49px] max-[1120px]:fixed max-[1120px]:bottom-0 max-[1120px]:right-0 max-[1120px]:top-0 max-[1120px]:z-[15] max-[1120px]:flex max-[1120px]:w-[300px] max-[1120px]:max-w-[85vw] max-[1120px]:translate-x-full max-[1120px]:flex-col max-[1120px]:rounded-none max-[1120px]:border-0 max-[1120px]:shadow-[-8px_0_24px_#0000004d] max-[1120px]:transition-transform max-[1120px]:duration-200 max-[1120px]:ease-out',
  audiencePanelOpen: 'max-[1120px]:translate-x-0',
  audienceClose:
    'hidden max-[1120px]:grid max-[1120px]:place-items-center max-[1120px]:self-end max-[1120px]:rounded-md max-[1120px]:bg-transparent max-[1120px]:p-[5px] max-[1120px]:text-[var(--th-muted)] max-[1120px]:transition-colors max-[1120px]:hover:bg-[var(--th-icon-hover)]',
  audienceTitle:
    'relative border-b border-[var(--th-sidebar-line)] pb-[15px] text-xs tracking-[1.4px] text-[var(--th-muted)] [&_button]:mt-[17px] [&_button]:flex [&_button]:items-center [&_button]:gap-1.5 [&_button]:bg-transparent [&_button]:p-0 [&_button]:text-xs [&_button]:font-[750] [&_button]:tracking-[1.4px] [&_button]:text-[var(--th-muted)]',
  audienceMenu:
    'absolute left-0 top-[72px] z-[8] min-w-[180px] rounded-[10px] border border-[var(--th-line)] bg-[var(--th-card)] p-1.5 shadow-[0_10px_28px_#1f1f281f]',

  audienceGrid: 'grid grid-cols-7 gap-[9px] pt-[18px]',
  audienceEmpty: 'pt-1 text-[13px] text-[var(--th-muted)]',
  audienceAvatarBtn:
    'rounded-[5px] bg-transparent p-0 hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-[var(--th-hover)]',
  audienceHistory: 'flex min-h-0 flex-col gap-4 pt-4',
  audienceHistoryHeader: 'flex items-center justify-between gap-2',
  audienceHistoryBack:
    'flex items-center gap-1.5 bg-transparent p-0 text-[13px] font-[650] text-[var(--th-text)]',
  audienceHistoryActions: 'flex items-center gap-1',
  audienceHistoryIcon:
    'grid place-items-center rounded-md bg-transparent p-[5px] text-[var(--th-icon)] hover:bg-[var(--th-icon-hover)]',
  audienceSessionList: 'flex flex-col gap-1.5 overflow-auto',
  audienceSessionItem:
    'flex w-full flex-col gap-1 rounded-md bg-transparent px-3 py-2.5 text-left transition-[background,color,transform] duration-150 hover:bg-[var(--th-hover)]',
  audienceSessionTitle: 'text-[13.5px] font-semibold text-[var(--th-text)]',
  audienceSessionMeta: 'text-xs text-[var(--th-muted)]',

  modalBackdrop:
    'fixed inset-0 z-20 grid place-items-center bg-[var(--th-modal-scrim)] backdrop-blur-[3px]',
  composeModal:
    'w-[min(520px,calc(100vw-32px))] rounded-[14px] bg-[var(--th-card)] p-5 shadow-[0_20px_60px_#0e051b59] [&_textarea]:h-[130px] [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:text-base [&_textarea]:text-[var(--th-text)] [&_textarea]:outline-none [&_textarea::placeholder]:text-[var(--th-muted)]',
  modalHeader:
    'flex items-center justify-between text-base text-[var(--th-text)] [&_button]:grid [&_button]:place-items-center [&_button]:bg-transparent [&_button]:p-[5px] [&_button]:text-[var(--th-muted)] [&_strong]:text-[var(--th-text)]',
  modalUser:
    'my-6 mb-4 flex items-center gap-2.5 text-sm [&_span]:text-[var(--th-muted)] [&_strong]:text-[var(--th-text)]',
  emojiRow: 'mx-7 mb-3.5 flex gap-1.5 [&_button]:size-8 [&_button]:rounded-lg [&_button]:bg-[var(--th-emoji)] [&_button]:text-[15px] [&_button]:hover:bg-[var(--th-hover)]',
  modalFooter:
    'flex items-center justify-between border-t border-[var(--th-line)] pt-[13px] [&_button]:grid [&_button]:place-items-center [&_button]:bg-transparent [&_button]:p-[5px] [&_button]:text-[var(--th-muted)]',
  modalSend:
    'flex items-center gap-[7px] rounded-[7px] bg-[var(--th-compose)] px-[15px] py-[9px] font-[650] text-white hover:bg-[var(--th-compose-hover)] disabled:cursor-default',

  avatar:
    'relative inline-block size-[54px] shrink-0 overflow-hidden rounded-[7px] shadow-[inset_0_0_0_1px_#00000014] max-[760px]:size-[46px]',
  avatarSmall: 'size-[31px] rounded-[5px] max-[760px]:size-[31px]',
  avatarFace:
    'absolute left-3.5 top-3.5 z-[2] grid h-7 w-[27px] place-items-center rounded-[45%_45%_38%_38%] text-[17px] font-black leading-none text-[#20242d] max-[760px]:left-3 max-[760px]:top-3',
  avatarFaceSmall: 'left-2 top-2 h-[17px] w-4 text-[10px] max-[760px]:left-2 max-[760px]:top-2',
  avatarHair:
    'absolute left-2.5 top-2 z-[3] h-[18px] w-[34px] -rotate-[4deg] rounded-[55%_48%_25%_35%] max-[760px]:left-2 max-[760px]:top-[7px]',
  avatarHairSmall: 'left-[5px] top-1 h-[11px] w-5 max-[760px]:left-[5px] max-[760px]:top-1',
  avatarBody:
    'absolute bottom-[-8px] left-[7px] z-[1] h-[27px] w-[42px] rounded-[50%_50%_0_0] max-[760px]:bottom-[-8px] max-[760px]:left-1.5 max-[760px]:w-9',
  avatarBodySmall: 'bottom-[-4px] left-1 h-[15px] w-6 max-[760px]:bottom-[-4px] max-[760px]:left-1',
} as const

export type AvatarTone = 'gold' | 'lavender' | 'aqua' | 'pink' | 'blue' | 'gray'

export const avatarToneStyles: Record<
  AvatarTone,
  { shell: string; face: string; hair: string; body: string }
> = {
  gold: {
    shell: 'bg-[#f5d27d]',
    face: 'bg-[#d99255]',
    hair: 'bg-[#4d2a1d]',
    body: 'bg-[#32343a]',
  },
  lavender: {
    shell: 'bg-[#c6a4ff]',
    face: 'bg-[#e0a47e]',
    hair: 'bg-[#272231]',
    body: 'bg-[#252d3a]',
  },
  aqua: {
    shell: 'bg-[#66c9d6]',
    face: 'bg-[#d99a76]',
    hair: 'bg-[#3a2925]',
    body: 'bg-[#ba387e]',
  },
  pink: {
    shell: 'bg-[#ea9ed0]',
    face: 'bg-[#efb78d]',
    hair: 'bg-[#3b2740]',
    body: 'bg-[#4e91d7]',
  },
  blue: {
    shell: 'bg-[#8ab1e6]',
    face: 'bg-[#c8855d]',
    hair: 'bg-[#382d2d]',
    body: 'bg-[#445f9a]',
  },
  gray: {
    shell: 'bg-[#aab5c2]',
    face: 'bg-[#be825e]',
    hair: 'bg-[#3c3430]',
    body: 'bg-[#657182]',
  },
}
