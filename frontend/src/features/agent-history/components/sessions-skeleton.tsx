import { Skeleton } from '@/components/ui/skeleton'

export function SessionsSkeleton() {
  return (
    <ul className="audience-session-list">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="audience-session-item">
          <Skeleton className="mb-1.5 h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </li>
      ))}
    </ul>
  )
}
