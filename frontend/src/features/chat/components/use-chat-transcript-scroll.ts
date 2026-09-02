import { useCallback, useEffect, useRef, useState } from 'react'

const NEAR_BOTTOM_PX = 96
const LAYOUT_PIN_MS = 900

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
}: {
  turnCount: number
  isStreaming: boolean
  streamingText: string
  reasoningText: string
  toolCount: number
  agent: string | null
  sessionId: string | null
  isLoadingTranscript?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const wasStreamingRef = useRef(false)
  const wasLoadingTranscriptRef = useRef(isLoadingTranscript)
  const lastPinnedContextRef = useRef<string | null>(null)
  const pinnedTurnCountRef = useRef(0)
  const layoutPinActiveRef = useRef(false)
  const contextKey = `${agent ?? ''}:${sessionId ?? 'new'}`

  const isNearBottom = useCallback(() => {
    const el = ref.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
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

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(pinIfActive) : null
    observer?.observe(el)

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

  // Pin bottom on chat mount, agent switch, session/history switch, or when
  // a new context finishes its first transcript load.
  useEffect(() => {
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
      const cleanupPin = pinToBottom('instant')
      const cleanupLayout = startLayoutPinWindow()
      return () => {
        cleanupPin()
        cleanupLayout()
      }
    }
  }, [contextKey, isLoadingTranscript, turnCount, pinToBottom, startLayoutPinWindow])

  // Hard reload can paint messages one frame after loading clears — pin once
  // when the first batch lands for the current context.
  useEffect(() => {
    if (isLoadingTranscript) return
    if (lastPinnedContextRef.current !== contextKey) return
    if (pinnedTurnCountRef.current > 0 || turnCount === 0) return

    pinnedTurnCountRef.current = turnCount
    const cleanupPin = pinToBottom('instant')
    const cleanupLayout = startLayoutPinWindow()
    return () => {
      cleanupPin()
      cleanupLayout()
    }
  }, [contextKey, turnCount, isLoadingTranscript, pinToBottom, startLayoutPinWindow])

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

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => updateScrollButton()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [updateScrollButton])

  return { ref, scrollToBottom, showScrollButton }
}
