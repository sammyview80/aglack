import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { generateAvatarSpec, type HairStyle } from '@/lib/avatar'

function Hair({ style, color }: { style: HairStyle; color: string }) {
  switch (style) {
    case 'beret':
      return (
        <path
          d="M18 20c0-8 6-13 14-13s14 5 14 13c0-3-3-4-5-4-2 3-6 4-9 4s-7-1-9-4c-2 0-5 1-5 4Z"
          fill={color}
        />
      )
    case 'flatTop':
      return <rect x={17} y={10} width={30} height={12} rx={3} fill={color} />
    case 'sidePart':
      return (
        <path
          d="M16 22c0-9 7-15 16-15 8 0 15 6 16 14-3-4-9-6-15-5-6 1-13 2-17 6Z"
          fill={color}
        />
      )
    case 'curly':
      return (
        <g fill={color}>
          <circle cx={19} cy={16} r={6} />
          <circle cx={27} cy={11} r={7} />
          <circle cx={37} cy={11} r={7} />
          <circle cx={45} cy={16} r={6} />
        </g>
      )
    case 'bald':
      return null
  }
}

export function RandomAvatar({
  seed,
  size = 64,
  className,
}: {
  seed?: string
  size?: number
  className?: string
}) {
  const spec = useMemo(() => generateAvatarSpec(seed), [seed])

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      role="img"
      aria-label="avatar"
    >
      <rect width={64} height={64} rx={14} fill={spec.background} />
      <path
        d="M12 60c2-12 10-18 20-18s18 6 20 18Z"
        fill={spec.clothing}
      />
      <path d="M28 46h8l-4 5-4-5Z" fill="#FFFFFF" opacity={0.85} />
      <circle cx={32} cy={30} r={14} fill={spec.skin} />
      <Hair style={spec.hairStyle} color={spec.hairColor} />
    </svg>
  )
}
