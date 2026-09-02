import { AGENT_STATUS_WORDS, CyclingWords } from '@/components/motion'

type AnimatedStatusWordsProps = {
  className?: string
  withEllipsis?: boolean
  intervalMs?: number
}

/** @deprecated Use `CyclingWords` from `@/components/motion`. */
export function AnimatedStatusWords(props: AnimatedStatusWordsProps) {
  return <CyclingWords words={AGENT_STATUS_WORDS} {...props} />
}
