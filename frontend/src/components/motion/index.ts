export { motionPresets } from '@/components/motion/presets'
export { useCyclingWords } from '@/components/motion/use-cycling-words'
export { AnimatedSwap } from '@/components/motion/animated-swap'
export { CyclingWords } from '@/components/motion/cycling-words'
export { TypingIndicator } from '@/components/motion/typing-indicator'
export { PulseDot } from '@/components/motion/pulse-dot'

/** Default agent-working verbs (Claude-style). */
export const AGENT_STATUS_WORDS = [
  'Thinking',
  'Pondering',
  'Considering',
  'Reasoning',
  'Reflecting',
  'Processing',
  'Analyzing',
  'Crafting',
  'Drafting',
  'Composing',
  'Weaving',
  'Exploring',
  'Brainstorming',
  'Contemplating',
  'Deliberating',
  'Synthesizing',
] as const
