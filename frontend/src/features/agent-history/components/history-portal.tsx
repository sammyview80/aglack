import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { AgentHistoryPanel } from '@/features/agent-history/components/agent-history-panel'
import { threadsUi } from '@/components/threads-ui'
import type { AgentSession } from '@/features/agent-history/types'

/**
 * Agent history as a Dialog portal — not a layout column. Clock in the
 * sidebar opens this overlay; the right-hand column stays members.
 */
export function HistoryPortal({
  workspaceId,
  open,
  onOpenChange,
  selectedAgent,
  onSelectedAgentChange,
  onSelectSession,
}: {
  workspaceId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedAgent?: string | null
  onSelectedAgentChange?: (name: string | null) => void
  onSelectSession?: (agentName: string, session: AgentSession) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={threadsUi.historyPortalBackdrop} />
        <Dialog.Popup className={threadsUi.historyPortalPopup} aria-label="History">
          <div className={threadsUi.historyPortalHeader}>
            <Dialog.Title className={threadsUi.historyPortalTitle}>History</Dialog.Title>
            <Dialog.Close className={threadsUi.historyPortalClose} aria-label="Close history">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className={threadsUi.historyPortalBody}>
            <AgentHistoryPanel
              workspaceId={workspaceId}
              open={open}
              selectedAgent={selectedAgent}
              onSelectedAgentChange={onSelectedAgentChange}
              onSelectSession={onSelectSession}
            />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
