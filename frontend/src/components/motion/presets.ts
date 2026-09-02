/** Shared Tailwind + tw-animate-css class presets (reusable app-wide). */
export const motionPresets = {
  fadeInUp: 'animate-in fade-in slide-in-from-bottom-1 duration-300 fill-mode-both motion-reduce:animate-none',
  fadeIn: 'animate-in fade-in duration-200 fill-mode-both motion-reduce:animate-none',
  fadeOut: 'animate-out fade-out duration-200 fill-mode-both motion-reduce:animate-none',
  panelEnter:
    'animate-in fade-in slide-in-from-bottom-2 zoom-in-95 duration-300 ease-out fill-mode-both motion-reduce:animate-none',
  contentSwap: 'animate-in fade-in duration-250 ease-out fill-mode-both motion-reduce:animate-none',
  overlayEnter: 'animate-in fade-in duration-200 fill-mode-both motion-reduce:animate-none',
  modalEnter:
    'animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-300 ease-out fill-mode-both motion-reduce:animate-none',
  dropdownEnter:
    'animate-in fade-in zoom-in-95 duration-200 ease-out fill-mode-both motion-reduce:animate-none',
  messageEnter:
    'animate-in fade-in slide-in-from-bottom-1 duration-300 ease-out fill-mode-both motion-reduce:animate-none',
  spin: 'animate-spin motion-reduce:animate-none',
  pulse: 'animate-pulse motion-reduce:animate-none',
  bounce: 'animate-bounce motion-reduce:animate-none',
  interactive:
    'transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-200 ease-out motion-reduce:transition-none',
} as const
