import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MarkdownContent } from '@/features/chat/components/markdown-content'

afterEach(() => cleanup())

// Regression coverage: a `MEDIA:<absolute-path>` token an agent writes
// inline in its own reply text is NOT markdown syntax — `ReactMarkdown`
// has no idea what it means, so before this fix it rendered as broken
// literal text (the exact bug report: `MEDIA:/config/.hermes/webui/
// attachments/49e0d5e71555/router-settings.png` showing up verbatim in
// the chat bubble instead of the image it references).
describe('MarkdownContent MEDIA: token rendering', () => {
  it('renders a MEDIA: token pointing at an image as a real <img>, not literal text', () => {
    const { container } = render(
      <MarkdownContent
        text="Here is the screenshot: MEDIA:/config/.hermes/webui/attachments/49e0d5e71555/router-settings.png"
        workspaceId="ws-1"
        agent="pm"
        sessionId="49e0d5e71555"
      />,
    )

    expect(screen.queryByText(/MEDIA:/)).not.toBeInTheDocument()
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toContain('/api/media')
    expect(img?.getAttribute('src')).toContain(
      'path=%2Fconfig%2F.hermes%2Fwebui%2Fattachments%2F49e0d5e71555%2Frouter-settings.png',
    )
    expect(img?.getAttribute('src')).toContain('session_id=49e0d5e71555')
    expect(screen.getByText(/Here is the screenshot:/)).toBeInTheDocument()
  })

  it('renders a MEDIA: token pointing at a non-image file as a download-link chip', () => {
    render(
      <MarkdownContent
        text="MEDIA:/config/.hermes/webui/attachments/session-a/report.pdf"
        workspaceId="ws-1"
        agent="pm"
        sessionId="session-a"
      />,
    )

    const link = screen.getByRole('link', { name: /report\.pdf/ })
    expect(link).toHaveAttribute('href', expect.stringContaining('/api/media'))
    expect(link).toHaveAttribute('download', 'report.pdf')
  })

  it('renders a bare file:// reference the same way as an equivalent MEDIA: token', () => {
    const { container } = render(
      <MarkdownContent
        text="file:///config/.hermes/webui/attachments/session-a/photo.png"
        workspaceId="ws-1"
        agent="pm"
        sessionId="session-a"
      />,
    )

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toContain(
      'path=%2Fconfig%2F.hermes%2Fwebui%2Fattachments%2Fsession-a%2Fphoto.png',
    )
  })

  it('renders plain prose with no MEDIA: token exactly as before (no extra wrapping)', () => {
    render(<MarkdownContent text="just a normal reply, no attachments" />)

    expect(screen.getByText('just a normal reply, no attachments')).toBeInTheDocument()
  })

  it('falls back to the bare token as text when there is no session context to build a URL from', () => {
    render(<MarkdownContent text="MEDIA:/config/.hermes/webui/attachments/session-a/photo.png" />)

    expect(screen.getByText(/MEDIA:\/config/)).toBeInTheDocument()
  })

  it('still renders normal markdown formatting around a MEDIA: token', () => {
    render(
      <MarkdownContent
        text="**bold text** before MEDIA:/tmp/report.pdf and after"
        workspaceId="ws-1"
        agent="pm"
        sessionId="session-a"
      />,
    )

    expect(screen.getByText('bold text').tagName).toBe('STRONG')
    expect(screen.getByText(/and after/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /report\.pdf/ })).toBeInTheDocument()
  })
})
