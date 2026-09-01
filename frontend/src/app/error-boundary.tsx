import { Component, type ErrorInfo, type ReactNode } from 'react'
import { PageFallback } from '@/components/page-fallback'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Catches render crashes. Request failures go through handleError, not here. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <PageFallback
          title="Something went wrong"
          description={this.state.error.message || 'This screen crashed. Reload to try again.'}
          actionLabel="Reload"
          onAction={() => window.location.reload()}
        />
      )
    }
    return this.props.children
  }
}
