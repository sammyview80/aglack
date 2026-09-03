import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CatalogProviderMark,
  faviconUrlFor,
  initialsFor,
  paletteClassFor,
} from '@/features/integrations/components/catalog-provider-mark'

afterEach(() => {
  cleanup()
})

function markClass() {
  return screen.getByTestId('catalog-provider-mark').className
}

describe('CatalogProviderMark', () => {
  it('renders the same color for the same service across separate mounts and rerenders', () => {
    const first = render(<CatalogProviderMark service="slack" displayName="Slack" />)
    const classA = markClass()
    first.rerender(<CatalogProviderMark service="slack" displayName="Slack" />)
    expect(markClass()).toBe(classA)
    first.unmount()

    render(<CatalogProviderMark service="slack" displayName="Slack" />)
    expect(markClass()).toBe(classA)
    expect(classA).toContain(paletteClassFor('slack'))
  })

  it('maps different services to different colors', () => {
    // djb2("aws") % 8 === 0, djb2("box") % 8 === 6 — distinct palette slots.
    expect(paletteClassFor('aws')).not.toBe(paletteClassFor('box'))

    render(<CatalogProviderMark service="aws" displayName="AWS" />)
    const awsClass = markClass()
    cleanup()
    render(<CatalogProviderMark service="box" displayName="Box" />)
    expect(markClass()).not.toBe(awsClass)
  })

  it('derives initials from a multi-word display name', () => {
    render(<CatalogProviderMark service="google-calendar" displayName="Google Calendar" />)
    expect(screen.getByTestId('catalog-provider-mark')).toHaveTextContent('GC')
    expect(screen.getByTestId('catalog-provider-mark')).toHaveAttribute('title', 'Google Calendar')
    expect(initialsFor('asana', 'asana')).toBe('A')
  })

  it('derives a single initial from a one-word display name', () => {
    render(<CatalogProviderMark service="slack" displayName="Slack" />)
    expect(screen.getByTestId('catalog-provider-mark')).toHaveTextContent('S')
  })

  it('falls back to the service initial when display name is empty or whitespace', () => {
    render(<CatalogProviderMark service="notion" displayName="   " />)
    expect(screen.getByTestId('catalog-provider-mark')).toHaveTextContent('N')
    cleanup()
    render(<CatalogProviderMark service="zapier" displayName="" />)
    expect(screen.getByTestId('catalog-provider-mark')).toHaveTextContent('Z')
  })
})

const CLOUDFLARE_FAVICON = 'https://www.google.com/s2/favicons?domain=www.cloudflare.com&sz=64'

describe('faviconUrlFor', () => {
  it('builds the Google favicon URL from just the hostname of a homepage URL', () => {
    expect(faviconUrlFor('https://www.cloudflare.com/products/workers/?x=1')).toBe(
      CLOUDFLARE_FAVICON,
    )
  })

  it('returns null for null, empty, whitespace, and malformed input without throwing', () => {
    expect(faviconUrlFor(null)).toBeNull()
    expect(faviconUrlFor(undefined)).toBeNull()
    expect(faviconUrlFor('')).toBeNull()
    expect(faviconUrlFor('   ')).toBeNull()
    expect(() => faviconUrlFor('not a url')).not.toThrow()
    expect(faviconUrlFor('not a url')).toBeNull()
  })
})

describe('CatalogProviderMark favicon', () => {
  it('renders a favicon <img> instead of initials when a valid homepageUrl is passed', () => {
    render(
      <CatalogProviderMark
        service="cloudflare"
        displayName="Cloudflare"
        homepageUrl="https://www.cloudflare.com/"
      />,
    )
    const mark = screen.getByTestId('catalog-provider-mark')
    const img = mark.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', CLOUDFLARE_FAVICON)
    expect(img).toHaveAttribute('alt', '')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(mark).toHaveAttribute('title', 'Cloudflare')
    expect(mark).not.toHaveTextContent('C')
  })

  it('renders the initials tile with no <img> when homepageUrl is omitted or null', () => {
    render(<CatalogProviderMark service="slack" displayName="Slack" />)
    let mark = screen.getByTestId('catalog-provider-mark')
    expect(mark.querySelector('img')).toBeNull()
    expect(mark).toHaveTextContent('S')
    expect(mark.className).toContain(paletteClassFor('slack'))
    cleanup()

    render(<CatalogProviderMark service="slack" displayName="Slack" homepageUrl={null} />)
    mark = screen.getByTestId('catalog-provider-mark')
    expect(mark.querySelector('img')).toBeNull()
    expect(mark).toHaveTextContent('S')
  })

  it('falls back to the initials tile when the favicon fails to load', () => {
    render(
      <CatalogProviderMark
        service="cloudflare"
        displayName="Cloudflare"
        homepageUrl="https://www.cloudflare.com/"
      />,
    )
    const img = screen.getByTestId('catalog-provider-mark').querySelector('img')
    expect(img).not.toBeNull()
    fireEvent.error(img!)

    const mark = screen.getByTestId('catalog-provider-mark')
    expect(mark.querySelector('img')).toBeNull()
    expect(mark).toHaveTextContent('C')
    expect(mark.className).toContain(paletteClassFor('cloudflare'))
  })
})
