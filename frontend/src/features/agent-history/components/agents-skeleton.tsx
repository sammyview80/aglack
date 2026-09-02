import { Skeleton } from '@/components/ui/skeleton'
import { threadsUi } from '@/components/threads-ui'

export function AgentsSkeleton() {
  return (
    <div className={threadsUi.audienceGrid}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="size-9 rounded-full" />
      ))}
    </div>
  )
}
