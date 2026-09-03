import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProviderMark } from '@/features/integrations/components/provider-mark'
import {
  faviconUrlFor,
  paletteClassFor,
} from '@/features/integrations/components/catalog-provider-mark'

afterEach(() => {
  cleanup()
})

function mark() {
  return screen.getByTestId('provider-mark')
}

function markImgSrc(): string | null {
  return mark().querySelector('img')?.getAttribute('src') ?? null
}

describe('ProviderMark favicon', () => {
  it('renders a distinct favicon <img> for each of three providers with different homepages', () => {
    render(<ProviderMark providerId="github" icon="github" name="GitHub" homepageUrl="https://github.com" />)
    const github = markImgSrc()
    cleanup()
    render(<ProviderMark providerId="slack" icon="slack" name="Slack" homepageUrl="https://slack.com" />)
    const slack = markImgSrc()
    cleanup()
    render(
      <ProviderMark
        providerId="cloudflare-worker"
        icon={null}
        name="Cloudflare Worker"
        homepageUrl="https://workers.cloudflare.com"
      />,
    )
    const cloudflare = markImgSrc()

    expect(github).toBe(faviconUrlFor('https://github.com'))
    expect(slack).toBe(faviconUrlFor('https://slack.com'))
    expect(cloudflare).toBe(faviconUrlFor('https://workers.cloudflare.com'))
    expect(new Set([github, slack, cloudflare]).size).toBe(3)
    expect(mark()).toHaveAttribute('title', 'Cloudflare Worker')
    expect(mark()).not.toHaveTextContent('CW')
  })

  it('falls back to the initials tile when the favicon fails to load', () => {
    render(<ProviderMark providerId="github" icon="github" name="GitHub" homepageUrl="https://github.com" />)
    const img = mark().querySelector('img')
    expect(img).not.toBeNull()
    fireEvent.error(img!)

    expect(mark().querySelector('img')).toBeNull()
    expect(mark()).toHaveTextContent('G')
    expect(mark().className).toContain(paletteClassFor('github'))
  })
})

describe('ProviderMark fallback', () => {
  it('renders a deterministic initials tile when homepageUrl is omitted or null', () => {
    render(<ProviderMark providerId="alpaca" icon={null} name="Alpaca" />)
    expect(mark().querySelector('img')).toBeNull()
    expect(mark()).toHaveTextContent('A')
    expect(mark().className).toContain(paletteClassFor('alpaca'))
    cleanup()

    render(<ProviderMark providerId="alpaca" icon={null} name="Alpaca" homepageUrl={null} />)
    expect(mark().querySelector('img')).toBeNull()
    expect(mark()).toHaveTextContent('A')
    expect(mark().className).toContain(paletteClassFor('alpaca'))
  })

  it('renders different fallback tiles for different providers with no homepageUrl', () => {
    // djb2("aws") % 8 === 0, djb2("box") % 8 === 6 — distinct palette slots.
    expect(paletteClassFor('aws')).not.toBe(paletteClassFor('box'))

    render(<ProviderMark providerId="aws" icon={null} name="AWS" />)
    const awsClass = mark().className
    const awsText = mark().textContent
    cleanup()
    render(<ProviderMark providerId="box" icon={null} name="Box" />)
    expect(mark().className).not.toBe(awsClass)
    expect(mark().textContent).not.toBe(awsText)
  })

  it('renders the same result for the same provider across rerenders and separate mounts', () => {
    const first = render(<ProviderMark providerId="notion" icon="notion" name="Notion" />)
    const classA = mark().className
    const textA = mark().textContent
    first.rerender(<ProviderMark providerId="notion" icon="notion" name="Notion" />)
    expect(mark().className).toBe(classA)
    expect(mark().textContent).toBe(textA)
    first.unmount()

    render(<ProviderMark providerId="notion" icon="notion" name="Notion" />)
    expect(mark().className).toBe(classA)
    expect(mark().textContent).toBe(textA)
    expect(classA).toContain(paletteClassFor('notion'))
  })
})
