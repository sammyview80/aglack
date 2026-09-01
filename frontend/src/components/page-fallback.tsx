import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { Button } from '@/components/ui/button'

type PageFallbackProps = {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  extra?: ReactNode
  embedded?: boolean
  onBack?: () => void
  hideBack?: boolean
}

function FallbackBody({
  title,
  description,
  actionLabel,
  onAction,
  extra,
  onBack,
  hideBack,
}: Omit<PageFallbackProps, 'embedded'>) {
  const navigate = useNavigate()
  const goBack = onBack ?? (() => navigate('/'))

  return (
    <>
      <h2>{title}</h2>
      <div className="divider" />
      <p className="post-copy">{description}</p>
      {(onAction && actionLabel) || extra || !hideBack ? (
        <div className="mt-6 flex flex-col gap-3">
          {extra}
          {onAction && actionLabel ? (
            <Button type="button" size="lg" className="w-full" onClick={onAction}>
              {actionLabel}
            </Button>
          ) : null}
          {hideBack ? null : (
            <Button type="button" variant="ghost" onClick={goBack}>
              Back
            </Button>
          )}
        </div>
      ) : null}
    </>
  )
}

/** Shared empty / error / 404 card. Do not invent a second full-page fallback. */
export function PageFallback({ embedded = false, ...props }: PageFallbackProps) {
  if (embedded) return <FallbackBody {...props} />
  return (
    <SlackOnboardingLayout title={props.title}>
      <FallbackBody {...props} />
    </SlackOnboardingLayout>
  )
}
