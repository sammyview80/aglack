import type { ReactNode } from 'react'
import { integrationsUi } from '@/features/integrations/integrations-ui'
import { cn } from '@/lib/utils'

/**
 * Shared visual shell for every plugin/provider card — curated shelves
 * (`ProviderCard`) and the full catalog (`CatalogTab`) render different data
 * shapes and wire up different actions (oauth/api-key vs dialog-only), but
 * they must look like the same design system, not two hand-rolled cards.
 * This owns layout only: mark slot, body slot, footer slot. Callers own
 * content and interactivity (button vs clickable card, connect vs disconnect).
 */
export function PluginCardShell({
  as = 'div',
  installed,
  onClick,
  mark,
  body,
  footer,
  className,
}: {
  as?: 'div' | 'button'
  installed?: boolean
  onClick?: () => void
  mark: ReactNode
  body: ReactNode
  footer: ReactNode
  className?: string
}) {
  const rootClassName = cn(integrationsUi.catalogCard, installed && integrationsUi.catalogCardInstalled, className)

  const content = (
    <>
      <div className={integrationsUi.catalogCardTop}>
        <div className="relative shrink-0">{mark}</div>
        <div className={integrationsUi.catalogCardBody}>{body}</div>
      </div>
      <div className={integrationsUi.catalogCardFooter}>{footer}</div>
    </>
  )

  if (as === 'button') {
    return (
      <button type="button" className={rootClassName} onClick={onClick}>
        {content}
      </button>
    )
  }

  return <div className={rootClassName}>{content}</div>
}
