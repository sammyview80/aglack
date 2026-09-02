/** Shared Tailwind + tw-animate-css class presets (reusable app-wide). */
export const motionPresets = {
  fadeInUp: 'animate-in fade-in slide-in-from-bottom-1 duration-300 fill-mode-both motion-reduce:animate-none',
  fadeIn: 'animate-in fade-in duration-200 fill-mode-both motion-reduce:animate-none',
  fadeOut: 'animate-out fade-out duration-200 fill-mode-both motion-reduce:animate-none',
  spin: 'animate-spin motion-reduce:animate-none',
  pulse: 'animate-pulse motion-reduce:animate-none',
  bounce: 'animate-bounce motion-reduce:animate-none',
} as const
