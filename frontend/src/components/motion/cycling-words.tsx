import { cn } from '@/lib/utils'
import { AnimatedSwap } from '@/components/motion/animated-swap'
import { motionPresets } from '@/components/motion/presets'
import { useCyclingWords } from '@/components/motion/use-cycling-words'

type CyclingWordsProps = {
  words: readonly string[]
  intervalMs?: number
  className?: string
  wordClassName?: string
  withEllipsis?: boolean
  ariaLive?: 'polite' | 'assertive' | 'off'
}

/** Claude-style cycling status text with enter animation. */
export function CyclingWords({
  words,
  intervalMs,
  className,
  wordClassName,
  withEllipsis = true,
  ariaLive = 'polite',
}: CyclingWordsProps) {
  const { word, tick } = useCyclingWords(words, intervalMs)

  return (
    <span
      className={cn('inline-flex items-baseline gap-0 text-[var(--th-muted)] italic font-medium', className)}
      aria-live={ariaLive}
    >
      <AnimatedSwap swapKey={tick} className={wordClassName}>
        {word}
      </AnimatedSwap>
      {withEllipsis ? (
        <span className={cn('inline-block', motionPresets.pulse)} aria-hidden>
          …
        </span>
      ) : null}
    </span>
  )
}
