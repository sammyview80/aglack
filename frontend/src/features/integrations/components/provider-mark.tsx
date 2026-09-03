import {
  BookOpen,
  Calendar,
  FolderOpen,
  GitFork,
  Hash,
  Mail,
  Puzzle,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { integrationsUi } from '@/features/integrations/integrations-ui'

const MARKS: Record<string, { tile: string; Icon: LucideIcon }> = {
  // lucide-react's brand-logo icons (incl. a literal "Github" mark) were
  // dropped from this installed version — no exact GitHub logo is
  // available, `GitFork` is the closest generic stand-in. Swap for a
  // real brand glyph (e.g. an inline SVG) if that matters visually later.
  github: { tile: 'bg-[#181717] text-white', Icon: GitFork },
  gmail: { tile: 'bg-[#ea4335] text-white', Icon: Mail },
  google: { tile: 'bg-[#4285f4] text-white', Icon: Mail },
  'google-calendar': { tile: 'bg-[#1a73e8] text-white', Icon: Calendar },
  'google-drive': { tile: 'bg-[#188038] text-white', Icon: FolderOpen },
  slack: { tile: 'bg-[#4a154b] text-white', Icon: Hash },
  notion: { tile: 'bg-[#191919] text-white', Icon: BookOpen },
}

export function ProviderMark({
  providerId,
  icon,
  name,
}: {
  providerId: string
  icon: string | null
  name: string
}) {
  const mark = MARKS[providerId] ?? (icon ? MARKS[icon] : undefined) ?? {
    tile: 'bg-[var(--th-compose)]/15 text-[var(--th-compose)]',
    Icon: Puzzle,
  }
  const Icon = mark.Icon

  return (
    <span className={cn(integrationsUi.mark, mark.tile)} aria-hidden="true" title={name}>
      <Icon size={22} strokeWidth={1.8} />
    </span>
  )
}
