import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { ToolActivityList } from '@/features/chat/components/tool-activity'

afterEach(() => cleanup())

describe('ToolActivityList', () => {
  it('truncates preview to one line until clicked', () => {
    const longPreview =
      '{"responses": [{"question": "What do you mean?", "choices_offered": ["Add MCP support"]}]}'

    render(
      <ToolActivityList
        tools={[{ name: 'clarify', complete: true, preview: longPreview }]}
      />,
    )

    const toggle = screen.getByRole('button', { name: /expand clarify output/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle.textContent).toContain(longPreview)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})
