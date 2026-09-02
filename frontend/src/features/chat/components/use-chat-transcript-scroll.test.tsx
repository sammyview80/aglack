import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatTranscriptScroll } from '@/features/chat/components/use-chat-transcript-scroll'

afterEach(() => cleanup())

/**
 * jsdom does not implement real layout, so `scrollHeight`/`clientHeight`
 * are always 0 unless stamped onto the element directly — this helper
 * mirrors that pattern for a synthetic "scrollable transcript" div.
 */
function mockScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', { value: metrics.scrollTop, configurable: true, writable: true })
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true })
}

function fireScroll(el: HTMLElement) {
  el.dispatchEvent(new Event('scroll'))
}

function baseProps(overrides: Partial<Parameters<typeof useChatTranscriptScroll>[0]> = {}) {
  return {
    turnCount: 10,
    isStreaming: false,
    streamingText: '',
    reasoningText: '',
    toolCount: 0,
    agent: 'agent-a',
    sessionId: 'session-a',
    isLoadingTranscript: false,
    canLoadOlder: true,
    isLoadingOlder: false,
    ...overrides,
  }
}

/**
 * Renders the hook attached to a REAL mounted `<div>` (via its returned
 * `ref`), unlike a bare `renderHook` — the hook's scroll-listener effect
 * needs an actual DOM node present at effect-commit time to attach to, not
 * a ref mutated after the fact (which the effect would never see, since
 * its dependency array doesn't include the ref value itself).
 */
function renderScrollHook(props: Parameters<typeof useChatTranscriptScroll>[0]) {
  function Harness(p: Parameters<typeof useChatTranscriptScroll>[0]) {
    const hook = useChatTranscriptScroll(p)
    return <div ref={hook.ref} data-testid="transcript" />
  }
  const view = render(<Harness {...props} />)
  const el = view.getByTestId('transcript')
  const rerender = (next: Parameters<typeof useChatTranscriptScroll>[0]) => view.rerender(<Harness {...next} />)
  return { el, rerender }
}

// Regression coverage for Bug 2 ("No 'load older messages'"): before this
// fix there was no near-top detection at all, so a user scrolled to the
// top of the transcript had no way to trigger fetching anything further
// back — these tests exercise the scroll-driven trigger, its debounce/
// duplicate guard, and the scroll-position-preserving anchor logic in
// isolation from `useChat` itself (that hook's own fetch/paging logic is
// covered in use-chat.test.tsx).
describe('useChatTranscriptScroll near-top', () => {
  it('calls onNearTop exactly once when scrolled near the top with an older page available', () => {
    const onNearTop = vi.fn()
    const { el } = renderScrollHook(baseProps({ onNearTop }))

    mockScrollMetrics(el, { scrollHeight: 2000, scrollTop: 10, clientHeight: 400 })
    act(() => fireScroll(el))

    expect(onNearTop).toHaveBeenCalledTimes(1)
  })

  it('does not call onNearTop again on further scroll events while still near the top (debounced)', () => {
    const onNearTop = vi.fn()
    const { el } = renderScrollHook(baseProps({ onNearTop }))

    mockScrollMetrics(el, { scrollHeight: 2000, scrollTop: 5, clientHeight: 400 })
    act(() => fireScroll(el))
    act(() => fireScroll(el))
    act(() => fireScroll(el))

    expect(onNearTop).toHaveBeenCalledTimes(1)
  })

  it('re-arms once the user scrolls away from the top and back', () => {
    const onNearTop = vi.fn()
    const { el } = renderScrollHook(baseProps({ onNearTop }))

    mockScrollMetrics(el, { scrollHeight: 2000, scrollTop: 5, clientHeight: 400 })
    act(() => fireScroll(el))
    expect(onNearTop).toHaveBeenCalledTimes(1)

    // Scroll away from the top.
    mockScrollMetrics(el, { scrollHeight: 2000, scrollTop: 800, clientHeight: 400 })
    act(() => fireScroll(el))

    // Scroll back near the top — this is a genuinely new approach, so it
    // must fire again.
    mockScrollMetrics(el, { scrollHeight: 2000, scrollTop: 5, clientHeight: 400 })
    act(() => fireScroll(el))

    expect(onNearTop).toHaveBeenCalledTimes(2)
  })

  it('never calls onNearTop when there is no older page to load', () => {
    const onNearTop = vi.fn()
    const { el } = renderScrollHook(baseProps({ onNearTop, canLoadOlder: false }))

    mockScrollMetrics(el, { scrollHeight: 2000, scrollTop: 0, clientHeight: 400 })
    act(() => fireScroll(el))

    expect(onNearTop).not.toHaveBeenCalled()
  })

  it('never calls onNearTop while a load-older fetch is already in flight', () => {
    const onNearTop = vi.fn()
    const { el } = renderScrollHook(baseProps({ onNearTop, isLoadingOlder: true }))

    mockScrollMetrics(el, { scrollHeight: 2000, scrollTop: 0, clientHeight: 400 })
    act(() => fireScroll(el))

    expect(onNearTop).not.toHaveBeenCalled()
  })

  it('does not jump the viewport when older turns are prepended — scrollTop is re-anchored to the same content', () => {
    const { el, rerender } = renderScrollHook(baseProps({ turnCount: 10, isLoadingOlder: false }))

    // Before the older-page fetch begins: the user is scrolled somewhere
    // in the middle of the transcript.
    mockScrollMetrics(el, { scrollHeight: 2000, scrollTop: 300, clientHeight: 400 })

    // Fetch begins (isLoadingOlder flips true) — the hook snapshots the
    // scroll anchor at this instant.
    act(() => rerender(baseProps({ turnCount: 10, isLoadingOlder: true })))

    // Older turns land: content grows (scrollHeight increases) and the
    // fetch completes (isLoadingOlder flips back to false).
    mockScrollMetrics(el, { scrollHeight: 2600, scrollTop: 300, clientHeight: 400 })
    act(() => rerender(baseProps({ turnCount: 15, isLoadingOlder: false })))

    // scrollTop must have been adjusted by exactly the height the
    // prepended content added (600px), so the same messages that were
    // visible before the fetch are still visible after it — not reset to
    // the top and not left showing whatever the browser's default
    // "content added above" behavior would produce.
    expect(el.scrollTop).toBe(900)
  })
})
