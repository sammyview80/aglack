import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const NEAR_BOTTOM_PX = 96
// Symmetric counterpart to NEAR_BOTTOM_PX — how close to the TOP of the
// transcript counts as "the user wants older history", mirrored at the
// same 96px feel rather than a different magic number for no reason.
const NEAR_TOP_PX = 96
const LAYOUT_PIN_MS = 1200

function scrollElementToBottom(el: HTMLElement, behavior: ScrollBehavior) {
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ top: el.scrollHeight, behavior })
  } else {
    el.scrollTop = el.scrollHeight
  }
}

export function useChatTranscriptScroll({
  turnCount,
  isStreaming,
  streamingText,
  reasoningText,
  toolCount,
  agent,
  sessionId,
  isLoadingTranscript = false,
  onNearTop,
  canLoadOlder = false,
  isLoadingOlder = false,
}: {
  turnCount: number
  isStreaming: boolean
  streamingText: string
  reasoningText: string
  toolCount: number
  agent: string | null
  sessionId: string | null
  isLoadingTranscript?: boolean
  /** Called (at most once per top-approach — see the scroll handler below
   * for the debounce/re-arm rule) when the transcript is scrolled near its
   * top AND `canLoadOlder` is true. The caller (`useChat.loadOlderMessages`)
   * owns the actual fetch and its own in-flight guard; this hook's job is
   * only to decide WHEN to ask and to keep the viewport pinned to the same
   * content once older turns are prepended above it. */
  onNearTop?: () => void
  /** Whether an older page could even be fetched right now — mirrors
   * `hasOlderMessages && !isLoadingOlderMessages` from `useChat`. When
   * false, reaching the top never calls `onNearTop` (nothing to load, or
   * a fetch is already in flight — see `loadOlderMessages`'s own
   * in-flight guard, which this mirrors so a fast repeated scroll can't
   * queue up multiple asks before the first one even resolves). */
  canLoadOlder?: boolean
  isLoadingOlder?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Separate from `ref` (the scroll CONTAINER, whose own box is fixed by
  // flex layout and never resizes) — this watches the CONTENT element
  // that actually grows/shrinks inside it. `ResizeObserver` fires on box
  // size changes of the observed element itself; observing the fixed-size
  // scroll container (the original bug here) means late layout growth
  // that doesn't resize the container — an async-decoded `<img>`, a
  // syntax-highlighted code block settling in, a web font swap — never
  // re-triggers the pin, silently leaving the viewport stuck above the
  // real bottom after the initial pin window's first synchronous frames.
  const contentRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const wasStreamingRef = useRef(false)
  const wasLoadingTranscriptRef = useRef(isLoadingTranscript)
  const lastPinnedContextRef = useRef<string | null>(null)
  const pinnedTurnCountRef = useRef(0)
  const pinnedStreamingRef = useRef(false)
  const layoutPinActiveRef = useRef(false)
  const contextKey = `${agent ?? ''}:${sessionId ?? 'new'}`
  // Re-arm gate for the near-top ask: sticky true while the viewport stays
  // within NEAR_TOP_PX (so a jittery scroll AT the top can't refire on
  // every scroll event — the classic "debounce/threshold" this hook's own
  // NEAR_BOTTOM_PX pattern establishes elsewhere), cleared once the user
  // scrolls back away from the top. `isLoadingOlder` also holds it closed
  // so the moment a fetch resolves and prepends content (which itself
  // fires a scroll-adjacent layout change), the still-near-top viewport
  // doesn't immediately re-ask before the user has scrolled at all.
  const nearTopArmedRef = useRef(true)

  const isNearBottom = useCallback(() => {
    const el = ref.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
  }, [])

  const isNearTop = useCallback(() => {
    const el = ref.current
    if (!el) return false
    return el.scrollTop <= NEAR_TOP_PX
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = ref.current
    if (!el) return
    scrollElementToBottom(el, behavior)
    setShowScrollButton(false)
  }, [])

  const pinToBottom = useCallback(
    (behavior: ScrollBehavior = 'instant') => {
      let raf1 = 0
      let raf2 = 0
      let raf3 = 0
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          raf3 = requestAnimationFrame(() => scrollToBottom(behavior))
        })
      })
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
        cancelAnimationFrame(raf3)
      }
    },
    [scrollToBottom],
  )

  const startLayoutPinWindow = useCallback(() => {
    const el = ref.current
    if (!el) return () => {}

    layoutPinActiveRef.current = true
    let timeoutId = 0
    let rafId = 0

    const pinIfActive = () => {
      if (!layoutPinActiveRef.current) return
      rafId = requestAnimationFrame(() => scrollToBottom('instant'))
    }

    // Observe the CONTENT element, not `el` (the scroll container) — see
    // `contentRef`'s doc comment above for why the container itself never
    // fires here. Falls back to `el` if the caller hasn't wired
    // `contentRef` to anything, so this stays a no-op behavior change for
    // any other consumer of this hook that doesn't pass it.
    const observedEl = contentRef.current ?? el
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(pinIfActive) : null
    observer?.observe(observedEl)

    pinIfActive()
    timeoutId = window.setTimeout(() => {
      layoutPinActiveRef.current = false
      observer?.disconnect()
    }, LAYOUT_PIN_MS)

    return () => {
      layoutPinActiveRef.current = false
      window.clearTimeout(timeoutId)
      cancelAnimationFrame(rafId)
      observer?.disconnect()
    }
  }, [scrollToBottom])

  const updateScrollButton = useCallback(() => {
    setShowScrollButton(!isNearBottom() && (turnCount > 0 || isStreaming))
  }, [isNearBottom, turnCount, isStreaming])

  useEffect(() => {
    if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
      const previous = history.scrollRestoration
      history.scrollRestoration = 'manual'
      return () => {
        history.scrollRestoration = previous
      }
    }
  }, [])

  const scheduleContextPin = useCallback(() => {
    const cleanupPin = pinToBottom('instant')
    const cleanupLayout = startLayoutPinWindow()
    return () => {
      cleanupPin()
      cleanupLayout()
    }
  }, [pinToBottom, startLayoutPinWindow])

  // Pin bottom on chat mount, agent switch, session/history switch, or when
  // a new context finishes its first transcript load.
  useLayoutEffect(() => {
    const contextChanged = lastPinnedContextRef.current !== contextKey
    const transcriptReady = wasLoadingTranscriptRef.current && !isLoadingTranscript

    if (isLoadingTranscript) {
      wasLoadingTranscriptRef.current = true
      return
    }

    wasLoadingTranscriptRef.current = false

    if (contextChanged || transcriptReady) {
      lastPinnedContextRef.current = contextKey
      pinnedTurnCountRef.current = turnCount
      pinnedStreamingRef.current = isStreaming
      return scheduleContextPin()
    }
  }, [contextKey, isLoadingTranscript, turnCount, isStreaming, scheduleContextPin])

  // History can land one frame after loading clears — pin when first batch arrives.
  useLayoutEffect(() => {
    if (isLoadingTranscript) return
    if (lastPinnedContextRef.current !== contextKey) return
    if (pinnedTurnCountRef.current > 0 || turnCount === 0) return

    pinnedTurnCountRef.current = turnCount
    return scheduleContextPin()
  }, [contextKey, turnCount, isLoadingTranscript, scheduleContextPin])

  // Reconnecting SSE grows the transcript after the initial pin — pin once per context.
  useLayoutEffect(() => {
    if (!isStreaming || isLoadingTranscript) return
    if (lastPinnedContextRef.current !== contextKey) return
    if (pinnedStreamingRef.current) return

    pinnedStreamingRef.current = true
    return scheduleContextPin()
  }, [contextKey, isStreaming, isLoadingTranscript, scheduleContextPin])

  useEffect(() => {
    if (isNearBottom()) {
      const id = requestAnimationFrame(() => scrollToBottom(isStreaming ? 'smooth' : 'instant'))
      return () => cancelAnimationFrame(id)
    }
    updateScrollButton()
  }, [
    turnCount,
    isStreaming,
    streamingText,
    reasoningText,
    toolCount,
    isNearBottom,
    scrollToBottom,
    updateScrollButton,
  ])

  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && isNearBottom()) {
      scrollToBottom('smooth')
    }
    wasStreamingRef.current = isStreaming
  }, [isStreaming, isNearBottom, scrollToBottom])

  // Classic "load older" scroll anchoring: the instant a load-older fetch
  // BEGINS, snapshot how far the viewport's top edge sits from the
  // transcript's own bottom-of-content (`scrollHeight - scrollTop`) — an
  // offset that does NOT change when content is prepended above it, unlike
  // `scrollTop` itself. Once the fetch resolves and `turnCount` grows (the
  // prepended turns actually committed to the DOM), re-derive `scrollTop`
  // from that same invariant so the viewport shows exactly the same
  // content it did before, instead of visibly jumping to wherever the
  // browser's own default "content added above" behavior would leave it.
  const pendingAnchorRef = useRef<number | null>(null)
  const wasLoadingOlderRef = useRef(false)

  useLayoutEffect(() => {
    if (isLoadingOlder && !wasLoadingOlderRef.current) {
      const el = ref.current
      pendingAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null
    }
    wasLoadingOlderRef.current = isLoadingOlder
  }, [isLoadingOlder])

  useLayoutEffect(() => {
    if (isLoadingOlder) return
    const anchor = pendingAnchorRef.current
    if (anchor === null) return
    pendingAnchorRef.current = null
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight - anchor
  }, [turnCount, isLoadingOlder])

  const nearTopCheckRef = useRef(onNearTop)
  nearTopCheckRef.current = onNearTop

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      updateScrollButton()
      if (!canLoadOlder || isLoadingOlder) {
        // Nothing to fetch right now (no older page, or one is already in
        // flight) — leave the arm state alone so a fetch that finishes
        // while the user is STILL scrolled away from the top doesn't
        // immediately fire again the moment it becomes eligible.
        return
      }
      if (isNearTop()) {
        if (nearTopArmedRef.current) {
          nearTopArmedRef.current = false
          nearTopCheckRef.current?.()
        }
      } else {
        nearTopArmedRef.current = true
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [updateScrollButton, isNearTop, canLoadOlder, isLoadingOlder])

  return { ref, contentRef, scrollToBottom, showScrollButton }
}
