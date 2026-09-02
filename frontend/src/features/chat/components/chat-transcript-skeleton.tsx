import { Skeleton } from '@/components/ui/skeleton'
import { motionPresets } from '@/components/motion'
import { chatUi } from '@/features/chat/chat-ui'
import { cn } from '@/lib/utils'

/** Placeholder transcript while an agent's stored session loads. */
export function ChatTranscriptSkeleton() {
  return (
    <div
      className={cn(chatUi.messageList, 'gap-5 px-1 py-3', motionPresets.fadeIn)}
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <div className="flex w-full justify-end gap-2">
        <Skeleton className="h-11 w-[min(42%,280px)] rounded-[18px] bg-[var(--th-search)]" />
        <Skeleton className="size-8 shrink-0 rounded-full bg-[var(--th-search)]" />
      </div>
      <div className="flex w-full justify-start gap-2">
        <Skeleton className="size-8 shrink-0 rounded-full bg-[var(--th-search)]" />
        <Skeleton className="h-28 w-[min(68%,420px)] rounded-[18px] bg-[var(--th-search)]" />
      </div>
      <div className="flex w-full justify-end gap-2">
        <Skeleton className="h-9 w-[min(34%,220px)] rounded-[18px] bg-[var(--th-search)]" />
        <Skeleton className="size-8 shrink-0 rounded-full bg-[var(--th-search)]" />
      </div>
      <div className="flex w-full justify-start gap-2">
        <Skeleton className="size-8 shrink-0 rounded-full bg-[var(--th-search)]" />
        <Skeleton className="h-16 w-[min(52%,340px)] rounded-[18px] bg-[var(--th-search)]" />
      </div>
    </div>
  )
}
