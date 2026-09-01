import type { ReactNode } from 'react'
import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { Button } from '@/components/ui/button'

type PageFallbackProps = {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  extra?: ReactNode
  embedded?: boolean
}

function FallbackBody({
  title,
  description,
  actionLabel,
  onAction,
  extra,
}: Omit<PageFallbackProps, 'embedded'>) {
  return (
    <>
      <h2>{title}</h2>
      <div className="divider" />
      <p className="post-copy">{description}</p>
      {(onAction && actionLabel) || extra ? (
        <div className="mt-6 flex flex-col gap-3">
          {extra}
          {onAction && actionLabel ? (
            <Button type="button" onClick={onAction}>
              {actionLabel}
            </Button>
          ) : null}
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
