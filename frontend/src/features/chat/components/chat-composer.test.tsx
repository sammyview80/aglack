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
})
