import { Skeleton } from '@/components/ui/skeleton'

export function AgentsSkeleton() {
  return (
    <div className="audience-grid">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="size-9 rounded-full" />
      ))}
    </div>
  )
}
