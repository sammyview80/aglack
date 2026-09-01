/**
 * THE ONLY place Vite env vars are read. New VITE_* → here, then callers
 * import the helper. Never `import.meta.env.VITE_*` in components.
 */
export function gatewayUrl(): string {
  const base = import.meta.env.VITE_GATEWAY_URL
  if (!base) {
    throw new Error(
      'VITE_GATEWAY_URL is not set — copy frontend/.env.example to frontend/.env',
    )
  }
  return base.replace(/\/$/, '')
}
