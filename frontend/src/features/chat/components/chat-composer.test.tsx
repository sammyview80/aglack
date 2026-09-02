import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach } from 'vitest'
import { ChatComposer } from '@/features/chat/components/chat-composer'

afterEach(() => cleanup())

describe('ChatComposer attachments and voice', () => {
  it('renders attach file and voice input controls', () => {
    render(
      <ChatComposer
        disabled={false}
        isStreaming={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /attach file/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /voice input/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled()
  })

  it('opens the hidden file input when attach is clicked', async () => {
    const user = userEvent.setup()
    render(
      <ChatComposer
        disabled={false}
        isStreaming={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    )

    const fileInput = document.querySelector('.chat-composer-file-input') as HTMLInputElement
    const clickSpy = vi.spyOn(fileInput, 'click')

    await user.click(screen.getByRole('button', { name: /attach file/i }))
    expect(clickSpy).toHaveBeenCalled()
  })

  // Regression coverage for Bug 1 ("File attachments are silently
  // non-functional"): before this fix, submitting with an attachment sent
  // only a `[Attached: name]` text placeholder through `onSend(message)` —
  // the real `File` never left this component. Now the real `File[]` must
  // reach `onSend` as its own argument so the caller (`useChat.send`) can
  // actually upload it.
  it('passes the real File objects to onSend instead of a text placeholder', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(
      <ChatComposer disabled={false} isStreaming={false} onSend={onSend} onStop={vi.fn()} />,
    )

    const file = new File(['file contents'], 'report.pdf', { type: 'application/pdf' })
    const fileInput = document.querySelector('.chat-composer-file-input') as HTMLInputElement
    await user.upload(fileInput, file)

    expect(screen.getByText('report.pdf')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(onSend).toHaveBeenCalledTimes(1)
    const [text, files] = onSend.mock.calls[0]
    // No placeholder text was fabricated — the real file is a separate arg.
    expect(text).not.toContain('Attached')
    expect(files).toEqual([file])
  })

  it('clears the attachment chip after a successful send', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(
      <ChatComposer disabled={false} isStreaming={false} onSend={onSend} onStop={vi.fn()} />,
    )

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
    const fileInput = document.querySelector('.chat-composer-file-input') as HTMLInputElement
    await user.upload(fileInput, file)
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
  })
})
