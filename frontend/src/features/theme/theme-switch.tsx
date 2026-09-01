import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useColorTheme } from '@/features/theme/color-theme'

export function ThemeSwitch() {
  const { theme, toggleTheme } = useColorTheme()
  const dark = theme === 'dark'

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      role="switch"
      aria-checked={dark}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}
