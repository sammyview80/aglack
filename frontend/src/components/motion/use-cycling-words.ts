import { useEffect, useState } from 'react'

function pickNextIndex(words: readonly string[], current: number): number {
  if (words.length <= 1) return 0
  let next = Math.floor(Math.random() * words.length)
  while (next === current) next = Math.floor(Math.random() * words.length)
  return next
}

/** Cycle through words on an interval — generic loading / status copy. */
export function useCyclingWords(words: readonly string[], intervalMs = 2400) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * Math.max(words.length, 1)))
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (words.length === 0) return
    const id = window.setInterval(() => {
      setIndex((prev) => pickNextIndex(words, prev))
      setTick((t) => t + 1)
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [words, intervalMs])

  return { word: words[index] ?? words[0] ?? '', tick }
}
