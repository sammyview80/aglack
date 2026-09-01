/**
 * Workspace + console appearance. Persisted choice wins; otherwise OS
 * prefers-color-scheme. Applied on <html data-theme> AND .dark so shadcn
 * tokens and Radix/Base UI portals inherit the same theme.
 *
 * Boot script in index.html sets both before paint to avoid a flash.
 */
import { useEffect, useState } from 'react'

export type ColorTheme = 'light' | 'dark'

export const COLOR_THEME_KEY = 'hermes-console-theme'
const THEME_EVENT = 'hermes-theme'

export function loadColorTheme(): ColorTheme {
  try {
    const stored = localStorage.getItem(COLOR_THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // localStorage unavailable
  }
  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  } catch {
    // matchMedia unavailable
  }
  return 'light'
}

export function applyColorTheme(theme: ColorTheme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function saveColorTheme(theme: ColorTheme) {
  try {
    localStorage.setItem(COLOR_THEME_KEY, theme)
  } catch {
    // still apply in-memory
  }
  applyColorTheme(theme)
  window.dispatchEvent(new Event(THEME_EVENT))
}

export function useColorTheme() {
  const [theme, setTheme] = useState<ColorTheme>(loadColorTheme)

  useEffect(() => {
    applyColorTheme(loadColorTheme())
    const sync = () => setTheme(loadColorTheme())
    window.addEventListener(THEME_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(THEME_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const setColorTheme = (next: ColorTheme) => {
    if (next === theme) return
    saveColorTheme(next)
    setTheme(next)
  }

  const toggleTheme = () => {
    setColorTheme(theme === 'dark' ? 'light' : 'dark')
  }

  return { theme, setColorTheme, toggleTheme }
}
