import { toast } from 'sonner'
import { errorMessage } from '@/lib/api'

/**
 * One entry point for user-visible request failures.
 * Logs the raw error, optionally toasts, returns the display string
 * (use that for inline StatusAlert when the form should also show it).
 */
export function handleError(
  err: unknown,
  options: {
    fallback?: string
    messagesByCode?: Record<string, string>
    toast?: boolean
  } = {},
): string {
  const { fallback = 'Something went wrong', messagesByCode, toast: showToast = true } = options
  const message = errorMessage(err, fallback, messagesByCode)
  console.error(err)
  if (showToast) toast.error(message)
  return message
}
