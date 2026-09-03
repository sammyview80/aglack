import { useState } from 'react'
import { cn } from '@/lib/utils'
import { integrationsUi } from '@/features/integrations/integrations-ui'

/**
 * Google's public favicon service. This is a fixed, generic third-party
 * endpoint (like a CDN), not this app's own backend, so it is deliberately a
 * constant rather than a `VITE_*` env var — AGENTS.md rule 2 targets our own
 * host/port/origin, which this is not.
 */
const FAVICON_SERVICE_URL = 'https://www.google.com/s2/favicons'
const FAVICON_SIZE = 64

/**
 * Derives a favicon URL from a provider's homepage. Returns `null` when the
 * homepage is missing, blank, or unparseable — callers treat `null` as "no
 * real favicon available, render the generated avatar instead". Never throws.
 */
export function faviconUrlFor(homepageUrl: string | null | undefined): string | null {
  if (!homepageUrl || homepageUrl.trim() === '') return null
  try {
    const { hostname } = new URL(homepageUrl.trim())
    if (!hostname) return null
    const params = new URLSearchParams({ domain: hostname, sz: String(FAVICON_SIZE) })
    return `${FAVICON_SERVICE_URL}?${params.toString()}`
  } catch {
    return null
  }
}

/**
 * Generic UI palette (not a provider list). The catalog is ~1450 services
 * with no icon in the API, so every row without a usable favicon gets a
 * deterministic color + initials tile derived purely from its own
 * `service` / `displayName`.
 */
const PALETTE = [
  'bg-[#4285f4] text-white',
  'bg-[#188038] text-white',
  'bg-[#ea4335] text-white',
  'bg-[#6743ed] text-white',
  'bg-[#e8710a] text-white',
  'bg-[#0b8043] text-white',
  'bg-[#d81b60] text-white',
  'bg-[#00897b] text-white',
] as const

/** djb2 string hash, kept non-negative so it can index the palette. */
export function hashString(value: string): number {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function paletteClassFor(service: string): string {
  return PALETTE[hashString(service) % PALETTE.length]
}

export function initialsFor(displayName: string, service: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return service.trim().charAt(0).toUpperCase()
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join('')
    .toUpperCase()
}

export function CatalogProviderMark({
  service,
  displayName,
  homepageUrl,
}: {
  service: string
  displayName: string
  homepageUrl?: string | null
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const faviconUrl = faviconUrlFor(homepageUrl)

  if (faviconUrl && !imgFailed) {
    return (
      <span
        className={cn(integrationsUi.mark, 'overflow-hidden bg-white')}
        aria-hidden="true"
        title={displayName}
        data-testid="catalog-provider-mark"
      >
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          className="size-full rounded-[inherit] object-contain p-1"
          onError={() => setImgFailed(true)}
        />
      </span>
    )
  }

  return (
    <span
      className={cn(integrationsUi.mark, 'text-xs font-bold', paletteClassFor(service))}
      aria-hidden="true"
      title={displayName}
      data-testid="catalog-provider-mark"
    >
      {initialsFor(displayName, service)}
    </span>
  )
}
