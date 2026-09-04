import { useState } from 'react'
import { cn } from '@/lib/utils'
import { integrationsUi } from '@/features/integrations/integrations-ui'
import {
  faviconUrlFor,
  initialsFor,
  paletteClassFor,
} from '@/features/integrations/components/catalog-provider-mark'

/**
 * Brand mark for a curated `providers.yaml` provider. Same two-tier
 * rendering as `CatalogProviderMark` (favicon from `homepageUrl`, else a
 * deterministic color + initials tile keyed by `providerId`) so the curated
 * grid and the full catalog look identical — no hand-maintained per-provider
 * icon table (frontend/AGENTS.md rule #2). `icon` is kept in the props for
 * callers that still pass the API's short icon keyword; it no longer drives
 * iconography.
 */
export function ProviderMark({
  providerId,
  name,
  homepageUrl,
}: {
  providerId: string
  icon: string | null
  name: string
  homepageUrl?: string | null
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const faviconUrl = faviconUrlFor(homepageUrl)

  if (faviconUrl && !imgFailed) {
    return (
      <span
        className={cn(integrationsUi.markTile, 'overflow-hidden bg-white')}
        aria-hidden="true"
        title={name}
        data-testid="provider-mark"
      >
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          className="size-full rounded-[inherit] object-contain p-1.5"
          onError={() => setImgFailed(true)}
        />
      </span>
    )
  }

  return (
    <span
      className={cn(integrationsUi.markTile, 'text-xs font-bold', paletteClassFor(providerId))}
      aria-hidden="true"
      title={name}
      data-testid="provider-mark"
    >
      {initialsFor(name, providerId)}
    </span>
  )
}
