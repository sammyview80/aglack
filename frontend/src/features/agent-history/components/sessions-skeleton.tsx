import { Skeleton } from '@/components/ui/skeleton'
import { threadsUi } from '@/components/threads-ui'

export function SessionsSkeleton() {
  return (
    <ul className={threadsUi.audienceSessionList}>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className={threadsUi.audienceSessionItem}>
          <Skeleton className="mb-1.5 h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </li>
      ))}
    </ul>
  )
}
