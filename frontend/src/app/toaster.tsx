import { useColorTheme } from '@/features/theme/color-theme'
import { Toaster } from '@/components/ui/sonner'

export function AppToaster() {
  const { theme } = useColorTheme()
  return <Toaster theme={theme} position="top-right" richColors closeButton />
}
