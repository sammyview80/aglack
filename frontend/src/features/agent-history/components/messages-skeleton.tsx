import { Skeleton } from '@/components/ui/skeleton'

export function MessagesSkeleton() {
  return (
    <ul className="audience-message-list">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="audience-message-item">
          <Skeleton className="mb-1.5 h-3 w-16" />
          <Skeleton className="h-3.5 w-full" />
        </li>
      ))}
    </ul>
  )
}
