import { RandomAvatar } from '@/components/random-avatar'

/** Pixel sizes for agent identity avatars in chat UI. */
export const AGENT_AVATAR_SIZE = {
  sm: 24,
  md: 40,
  lg: 54,
} as const

export type AgentAvatarSize = keyof typeof AGENT_AVATAR_SIZE

export function AgentAvatar({ agent, size = 'md' }: { agent: string; size?: AgentAvatarSize }) {
  return <RandomAvatar seed={agent} size={AGENT_AVATAR_SIZE[size]} />
}
