/**
 * iOS-style Light / Dark switch. Sun = light, moon = dark.
 * MainContent header, Sidebar, StudioPage, Dashboard, StartScreen.
 */
import { Moon, Sun } from 'lucide-react'
import { useColorTheme } from '../lib/colorTheme'

export function ThemeSwitch() {
  const { theme, toggleTheme } = useColorTheme()
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      className={`du-theme-switch${dark ? ' du-theme-switch--dark' : ''}`}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
    >
      <Sun size={16} aria-hidden="true" className="du-theme-switch__icon du-theme-switch__icon--sun" />
      <span className="du-theme-switch__track" aria-hidden="true">
        <span className="du-theme-switch__knob" />
      </span>
      <Moon size={16} aria-hidden="true" className="du-theme-switch__icon du-theme-switch__icon--moon" />
    </button>
  )
}
