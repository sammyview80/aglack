const BACKGROUNDS = ['#F5C453', '#F2A6A0', '#9ED2C6', '#A9C6E8', '#D9B8E8', '#F4B183', '#B7D9A8']

const SKIN_TONES = ['#F6D2B8', '#EFC098', '#D9A075', '#B67D53', '#8A5A36', '#5C3A21']

const HAIR_STYLES = ['beret', 'flatTop', 'sidePart', 'curly', 'bald'] as const

const HAIR_COLORS = ['#2B2118', '#4A3223', '#7A4A2B', '#B8860B', '#6E6E6E', '#C0392B', '#3A506B']

const CLOTHING_COLORS = ['#2F3E46', '#354F52', '#3B3B58', '#4A4E69', '#5C4033', '#22333B', '#414833']

export type HairStyle = (typeof HAIR_STYLES)[number]

export interface AvatarSpec {
  background: string
  skin: string
  hairStyle: HairStyle
  hairColor: string
  clothing: string
}

function hashSeed(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i)
    h |= 0
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]
}

export function generateAvatarSpec(seed?: string): AvatarSpec {
  const rand = seed !== undefined ? mulberry32(hashSeed(seed)) : Math.random.bind(Math)
  return {
    background: pick(rand, BACKGROUNDS),
    skin: pick(rand, SKIN_TONES),
    hairStyle: pick(rand, HAIR_STYLES),
    hairColor: pick(rand, HAIR_COLORS),
    clothing: pick(rand, CLOTHING_COLORS),
  }
}
