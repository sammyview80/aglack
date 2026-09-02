import { cn } from '@/lib/utils'
import { motionPresets } from '@/components/motion/presets'

type PulseDotProps = {
  className?: string
  size?: 'sm' | 'md'
  label?: string
}

/** Active / streaming indicator dot with ping animation. */
export function PulseDot({ className, size = 'md', label }: PulseDotProps) {
  const px = size === 'sm' ? 'size-2' : 'size-2.5'
  const border = size === 'sm' ? 'border-[1.5px]' : 'border-2'

  return (
    <span
      className={cn('absolute rounded-full border-[var(--th-card)] bg-[var(--th-compose)]', px, border, className)}
      aria-label={label}
    >
      <span
        className={cn(
          'absolute inset-0 rounded-full bg-[var(--th-compose)] opacity-60',
          motionPresets.pulse,
        )}
        aria-hidden
      />
    </span>
  )
}
