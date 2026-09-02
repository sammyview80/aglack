import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { motionPresets } from '@/components/motion/presets'

/** Re-mount block content with enter animation when `swapKey` changes. */
export function AnimatedPanel({
  swapKey,
  children,
  className,
  animation = motionPresets.panelEnter,
}: {
  swapKey: string | number
  children: ReactNode
  className?: string
  animation?: string
}) {
  return (
    <div key={swapKey} className={cn(animation, className)}>
      {children}
    </div>
  )
}
