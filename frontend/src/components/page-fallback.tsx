import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

type PageFallbackProps = {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  extra?: ReactNode
}

/** Shared empty / error / 404 card. Do not invent a second full-page fallback. */
export function PageFallback({
  title,
  description,
  actionLabel,
  onAction,
  extra,
}: PageFallbackProps) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {(onAction && actionLabel) || extra ? (
          <CardContent className="flex flex-col gap-3">
            {extra}
            {onAction && actionLabel ? (
              <Button type="button" onClick={onAction}>
                {actionLabel}
              </Button>
            ) : null}
          </CardContent>
        ) : null}
      </Card>
    </main>
  )
}
