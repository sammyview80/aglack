import { Link } from 'react-router-dom'

export function BrandMark() {
  return (
    <Link to="/" className="flex items-center gap-2.5 text-foreground no-underline">
      <span
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-lg bg-[var(--brand-plum)] text-base font-bold text-[var(--brand-cream)]"
      >
        H
      </span>
      <span className="text-lg font-bold tracking-tight">Hermes</span>
    </Link>
  )
}
