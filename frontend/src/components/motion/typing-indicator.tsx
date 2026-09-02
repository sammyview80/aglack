import { cn } from '@/lib/utils'

const DOT_DELAYS = ['[animation-delay:-0.28s]', '[animation-delay:-0.14s]', ''] as const

/** Generic three-dot typing / waiting indicator. */
export function TypingIndicator({ className, dotClassName }: { className?: string; dotClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 py-0.5', className)} aria-hidden>
      {DOT_DELAYS.map((delay, i) => (
        <span
          key={i}
          className={cn(
            'size-1.5 rounded-full bg-current opacity-50 animate-bounce motion-reduce:animate-none',
            delay,
            dotClassName,
          )}
        />
      ))}
    </span>
  )
}
