import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chatUi, markdownToneClass, type MarkdownTone } from '@/features/chat/chat-ui'
import { cn } from '@/lib/utils'

/** Renders message text as GFM markdown (XSS-safe via react-markdown AST). */
export function MarkdownContent({
  text,
  tone = 'incoming',
}: {
  text: string
  tone?: MarkdownTone
}) {
  return (
    <div className={cn(chatUi.markdownRoot, markdownToneClass(tone))}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}
