import { useCallback, useEffect, useRef, useState } from 'react'

const NEAR_BOTTOM_PX = 96

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
}: {
  turnCount: number
  isStreaming: boolean
  streamingText: string
  reasoningText: string
  toolCount: number
  agent: string | null
  sessionId: string | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const wasStreamingRef = useRef(false)

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

  const updateScrollButton = useCallback(() => {
    setShowScrollButton(!isNearBottom() && (turnCount > 0 || isStreaming))
  }, [isNearBottom, turnCount, isStreaming])

  useEffect(() => {
    const id = requestAnimationFrame(() => scrollToBottom('instant'))
    return () => cancelAnimationFrame(id)
  }, [agent, sessionId, scrollToBottom])

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
    if (wasStreamingRef.current && !isStreaming) {
      scrollToBottom('smooth')
    }
    wasStreamingRef.current = isStreaming
  }, [isStreaming, scrollToBottom])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => updateScrollButton()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [updateScrollButton])

  return { ref, scrollToBottom, showScrollButton }
}
