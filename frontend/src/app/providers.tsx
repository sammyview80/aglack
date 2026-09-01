import type { ReactNode } from 'react'
import { ErrorBoundary } from '@/app/error-boundary'
import { AppToaster } from '@/app/toaster'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <>
      <ErrorBoundary>{children}</ErrorBoundary>
      <AppToaster />
    </>
  )
}
