import { Navigate, Route, Routes } from 'react-router-dom'
import { CreateWorkspacePage } from '@/pages/create-workspace-page'
import { CreatingWorkspacePage } from '@/pages/creating-workspace-page'
import { NotFoundPage } from '@/pages/not-found-page'
import { OnboardingPage } from '@/pages/onboarding-page'
import { WorkspacesPage } from '@/pages/workspaces-page'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<WorkspacesPage />} />
      <Route path="/onboarding" element={<Navigate to="/" replace />} />
      <Route path="/onboarding/:workspaceId" element={<OnboardingPage />} />
      <Route path="/create" element={<CreateWorkspacePage />} />
      <Route path="/creating" element={<CreatingWorkspacePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
