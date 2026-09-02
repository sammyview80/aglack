import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { motionPresets } from '@/components/motion/presets'

/** Re-mount children with enter animation when `swapKey` changes. */
export function AnimatedSwap({
  swapKey,
  children,
  className,
  animation = motionPresets.fadeInUp,
}: {
  swapKey: string | number
  children: ReactNode
  className?: string
  animation?: string
}) {
  return (
    <span key={swapKey} className={cn('inline-block', animation, className)}>
      {children}
    </span>
  )
}
