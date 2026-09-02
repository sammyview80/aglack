/** Tab-scoped selected chat session — one key per workspace+agent pair.
 * Clicking a history row overwrites only that agent's slot; switching
 * agents reads a different key, so session ids never cross agents. */
const PREFIX = 'hermano.chat.selected'

function storageKey(workspaceId: string, agent: string): string {
  return `${PREFIX}.${workspaceId}.${agent}`
}

export function readSelectedChatSessionId(workspaceId: string, agent: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(workspaceId, agent))
  } catch {
    return null
  }
}

export function writeSelectedChatSessionId(
  workspaceId: string,
  agent: string,
  sessionId: string,
): void {
  try {
    window.sessionStorage.setItem(storageKey(workspaceId, agent), sessionId)
  } catch {
    /* storage unavailable — best-effort */
  }
}

export function clearSelectedChatSessionId(workspaceId: string, agent: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(workspaceId, agent))
  } catch {
    /* storage unavailable — best-effort */
  }
}
