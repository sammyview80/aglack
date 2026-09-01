import { Link } from 'react-router-dom'
import { APP_NAME, BRAND_LOGO } from '@/lib/brand'
import { cn } from '@/lib/utils'

/** Colorful mark on a white tile so navy face + white cloud stay visible in both themes. */
export function BrandLogo({
  className,
  size = 'size-8',
  circle = false,
}: {
  className?: string
  size?: string
  circle?: boolean
}) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden bg-white',
        'ring-1 ring-black/15 dark:ring-white/25',
        circle ? 'rounded-full' : 'rounded-lg',
        size,
        className,
      )}
      aria-hidden="true"
    >
      <img src={BRAND_LOGO} alt="" className="size-[88%] object-contain" />
    </span>
  )
}

export function BrandMark({ compact = false, circle = false }: { compact?: boolean; circle?: boolean }) {
  return (
    <Link
      to="/"
      className={cn(
        'flex items-center gap-2 text-foreground no-underline',
        compact && 'justify-center lg:justify-start',
      )}
      aria-label={`${APP_NAME} home`}
    >
      <BrandLogo circle={circle} />
      {compact ? (
        <span className="hidden text-xl font-bold tracking-tight lg:inline">{APP_NAME}</span>
      ) : (
        <span className="text-sm font-semibold tracking-tight">{APP_NAME}</span>
      )}
    </Link>
  )
}
