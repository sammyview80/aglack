import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'

export function BrandMark({ compact = false, circle = false }: { compact?: boolean; circle?: boolean }) {
  return (
    <Link
      to="/"
      className={cn(
        'flex items-center gap-2 text-foreground no-underline',
        compact && 'justify-center lg:justify-start',
      )}
      aria-label="Hermes home"
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid size-9 place-items-center bg-foreground text-base font-bold text-background',
          circle ? 'rounded-full' : 'rounded-lg',
        )}
      >
        H
      </span>
      {compact ? (
        <span className="hidden text-xl font-bold tracking-tight lg:inline">Hermes</span>
      ) : (
        <span className="text-lg font-bold tracking-tight">Hermes</span>
      )}
    </Link>
  )
}
