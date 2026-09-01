import { useNavigate } from 'react-router-dom'
import { PageFallback } from '@/components/page-fallback'

export function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <PageFallback
      title="Page not found"
      description="That URL does not match a route in this app."
      actionLabel="Go to create workspace"
      onAction={() => navigate('/create')}
    />
  )
}
