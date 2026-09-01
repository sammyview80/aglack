import { Navigate, Route, Routes } from 'react-router-dom'
import { CreateWorkspacePage } from '@/pages/create-workspace-page'
import { CreatingWorkspacePage } from '@/pages/creating-workspace-page'
import { ModeSelectPage } from '@/pages/mode-select-page'
import { NotFoundPage } from '@/pages/not-found-page'
import { OnboardingPage } from '@/pages/onboarding-page'
import { WorkspaceChatPage } from '@/pages/workspace-chat-page'
import { WorkspacesPage } from '@/pages/workspaces-page'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<WorkspacesPage />} />
      <Route path="/onboarding" element={<Navigate to="/" replace />} />
      <Route path="/onboarding/:workspaceId" element={<OnboardingPage />} />
      <Route path="/mode/:workspaceId" element={<ModeSelectPage />} />
      <Route path="/workspaces/:workspaceId/chat" element={<WorkspaceChatPage />} />
      <Route path="/create" element={<CreateWorkspacePage />} />
      <Route path="/creating" element={<CreatingWorkspacePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
